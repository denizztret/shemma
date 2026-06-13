// apps/frontend/src/canvas/edge-routing-shift.ts
// DRW-246: чистое ядро сдвига блока для улучшения edge-routing.
// Без tldraw/libavoid, тестируется в bun:test.

import { countBoxOverlaps } from "./direction-choice";
import {
  type Polyline,
  type RouteBox,
  type RouteEdge,
  ancestorsOf,
  buildBoxIndex,
  countCrossFlowTerminals,
  countPolylineCrossings,
  foreignCrossings,
  planTransfer,
  polylineLength,
  routeScore,
} from "./edge-routing-core";

// ─── Публичные интерфейсы ──────────────────────────────────────────────────────

export interface ShiftTarget {
  readonly edge: RouteEdge;
  readonly planKind: "U" | "detour";
  readonly currentScore: number;
  /** Текущий маршрут — принятая arc-дуга (паллиатив). Дуга обычно имеет
   * score 0 (foreign=0), поэтому строгий гейт `<` никогда не даёт сдвигу её
   * победить. Политика: elbow-через-сдвиг предпочтительнее дуги при равном
   * score → для arc гейт ослаблен до `<=`. Для inexpressible — строгий `<`. */
  readonly currentIsArc: boolean;
}

export interface ShiftCandidate {
  readonly moveId: string;
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

// ─── pickMovableEnd ────────────────────────────────────────────────────────────

/**
 * Выбирает подвижный конец ребра для сдвига.
 *
 * Конец пригоден если:
 * - бокс есть в boxes
 * - kind === "leaf"
 * - не в pinned
 * - degree <= 2
 *
 * Из двух пригодных: меньшая degree → меньшая площадь → конец `to`.
 * Ни одного пригодного → null.
 */
export function pickMovableEnd(
  edge: RouteEdge,
  boxes: ReadonlyMap<string, RouteBox>,
  degree: ReadonlyMap<string, number>,
  pinned: ReadonlySet<string>,
): string | null {
  function isEligible(id: string): boolean {
    const box = boxes.get(id);
    if (!box) return false;
    if (box.kind !== "leaf") return false;
    if (pinned.has(id)) return false;
    if ((degree.get(id) ?? 0) > 2) return false;
    return true;
  }

  const fromOk = isEligible(edge.from);
  const toOk = isEligible(edge.to);

  if (!fromOk && !toOk) return null;
  if (fromOk && !toOk) return edge.from;
  if (!fromOk && toOk) return edge.to;

  // Оба пригодны: тай-брейк
  const fromDeg = degree.get(edge.from) ?? 0;
  const toDeg = degree.get(edge.to) ?? 0;

  if (fromDeg !== toDeg) {
    return fromDeg < toDeg ? edge.from : edge.to;
  }

  // Равная степень: меньшая площадь
  const fromBox = boxes.get(edge.from);
  const toBox = boxes.get(edge.to);
  if (!fromBox || !toBox) return edge.to;
  const fromArea = fromBox.w * fromBox.h;
  const toArea = toBox.w * toBox.h;

  if (fromArea !== toArea) {
    return fromArea < toArea ? edge.from : edge.to;
  }

  // Равная площадь → предпочитаем to
  return edge.to;
}

// ─── genShiftCandidates ────────────────────────────────────────────────────────

/**
 * Генерирует кандидатные позиции для сдвига move-бокса рядом с partner-боксом.
 *
 * same-parent: 5 кандидатов (adj-top, adj-bottom, adj-left, adj-right, cross-align).
 * cross-parent: 2 кандидата (cross-align, facade).
 *
 * Дополнительно (DRW-246, live-фикс A3→E2): 2 «lane»-кандидата уворота за полосу
 * препятствий коридора move↔partner — генерятся И для same-parent, И для
 * cross-parent, ПОСЛЕ существующих кандидатов, когда между концами есть чужие
 * боксы. См. genLaneCandidates ниже.
 *
 * Базовые кандидаты clamped внутри parent (с padding 16) если parent задан;
 * lane-кандидаты по оси уворота НЕ клампятся (см. genLaneCandidates).
 * Кандидаты с позицией == текущей move отбрасываются.
 * Дубликаты позиций → оставляем первый по порядку.
 *
 * @param obstacles ВСЕ боксы scope (рабочая копия workBoxes) — нужны для
 *   определения препятствий коридора в lane-кандидатах.
 */
export function genShiftCandidates(
  move: RouteBox,
  partner: RouteBox,
  parent: RouteBox | null,
  sameParent: boolean,
  obstacles: ReadonlyArray<RouteBox>,
  gap = 24,
): ShiftCandidate[] {
  type RawCandidate = {
    label: string;
    x: number;
    y: number;
    noClamp?: boolean;
  };

  function crossAlignXY(): { x: number; y: number } {
    const axis: "h" | "v" = partner.flowAxis ?? move.flowAxis ?? "v";
    if (axis === "v") {
      // Вертикальный поток: выравниваем по x (центрируем move под partner), сохраняем y move
      return {
        x: partner.x + partner.w / 2 - move.w / 2,
        y: move.y,
      };
    }
    // Горизонтальный поток: сохраняем x move, выравниваем по y
    return {
      x: move.x,
      y: partner.y + partner.h / 2 - move.h / 2,
    };
  }

  function facadeXY(): { x: number; y: number } {
    // parent здесь — собственный parent move-бокса; вызывается только при !sameParent && parent != null
    // Используем non-null assertion через проверку в вызывающем коде (raw assignment ниже)
    const p = parent ?? move; // fallback на move — никогда не достигается при корректном вызове
    const dcx = partner.x + partner.w / 2 - (move.x + move.w / 2);
    const dcy = partner.y + partner.h / 2 - (move.y + move.h / 2);

    if (Math.abs(dcx) >= Math.abs(dcy)) {
      // Горизонтальная ось
      if (dcx > 0) {
        return { x: p.x + p.w - 16 - move.w, y: move.y };
      }
      return { x: p.x + 16, y: move.y };
    }
    // Вертикальная ось
    if (dcy > 0) {
      return { x: move.x, y: p.y + p.h - 16 - move.h };
    }
    return { x: move.x, y: p.y + 16 };
  }

  /**
   * Lane-кандидаты (DRW-246): уворот move за полосу препятствий коридора.
   *
   * Коридор — прямой проход между центрами концов move↔partner. Ось коридора
   * выбирается по доминирующей разнице центров: |Δcx| >= |Δcy| → горизонтальный
   * (ось "h", уворот по y), иначе вертикальный (ось "v", уворот по x).
   *
   * Препятствия — боксы scope, чей диапазон по оси коридора пересекает интервал
   * между центрами концов, КРОМЕ: самих move/partner, всех их предков (маршрут
   * легально проходит через них) и собственных обёрток (боксы, для которых
   * move/partner — предки). Нет препятствий → прямой коридор свободен, lane не
   * нужен.
   *
   * "lane-after": уворот за дальний край полосы (низ/право) + gap.
   * "lane-before": уворот за ближний край (верх/лево) - gap - размер move.
   *
   * ОТЛИЧИЕ от остальных кандидатов: координата уворота НЕ клампится в parent —
   * выход за родителя допустим, после применения сдвига parent дорастёт grow-only
   * обтяжкой (refitWrappers).
   */
  function genLaneCandidates(): RawCandidate[] {
    const byId = buildBoxIndex(obstacles);
    const moveCx = move.x + move.w / 2;
    const moveCy = move.y + move.h / 2;
    const partnerCx = partner.x + partner.w / 2;
    const partnerCy = partner.y + partner.h / 2;
    const corridorAxis: "h" | "v" =
      Math.abs(partnerCx - moveCx) >= Math.abs(partnerCy - moveCy) ? "h" : "v";

    // Концы коридора (по центрам) вдоль оси коридора.
    const c0 =
      corridorAxis === "h"
        ? Math.min(moveCx, partnerCx)
        : Math.min(moveCy, partnerCy);
    const c1 =
      corridorAxis === "h"
        ? Math.max(moveCx, partnerCx)
        : Math.max(moveCy, partnerCy);

    // Полоса коридора по ОСИ УВОРОТА — диапазон, который занимают оба конца
    // (union по перпендикулярной оси). Препятствие мешает прямому проходу, только
    // если пересекает эту полосу: бокс в том же x-диапазоне, но далеко по y
    // (напр. отдельная цепочка ниже), коридор A↔B НЕ блокирует. Без этой проверки
    // уворот уходил за самый дальний край такого нерелевантного бокса (live-фикс
    // A3→E2: X-ряд внизу уводил E2 на y≈850 вместо y≈658 под колонкой C3).
    const bandLo =
      corridorAxis === "h"
        ? Math.min(move.y, partner.y)
        : Math.min(move.x, partner.x);
    const bandHi =
      corridorAxis === "h"
        ? Math.max(move.y + move.h, partner.y + partner.h)
        : Math.max(move.x + move.w, partner.x + partner.w);

    // Множество боксов-исключений: move, partner и все их предки.
    const excluded = new Set<string>([move.id, partner.id]);
    for (const seed of [move.id, partner.id]) {
      for (const a of ancestorsOf(byId, seed)) excluded.add(a);
    }

    function isOwnWrapper(b: RouteBox): boolean {
      // move/partner среди предков b → b — собственная обёртка (не препятствие).
      const anc = ancestorsOf(byId, b.id);
      return anc.has(move.id) || anc.has(partner.id);
    }

    let minTL = Number.POSITIVE_INFINITY; // top (h) / left (v) полосы
    let maxBR = Number.NEGATIVE_INFINITY; // bottom (h) / right (v) полосы
    let found = false;

    for (const b of obstacles) {
      if (excluded.has(b.id)) continue;
      if (isOwnWrapper(b)) continue;
      const lo = corridorAxis === "h" ? b.x : b.y;
      const hi = corridorAxis === "h" ? b.x + b.w : b.y + b.h;
      // Пересечение диапазона по оси коридора с интервалом между центрами.
      if (hi <= c0 || lo >= c1) continue;
      // Пересечение по оси уворота с полосой коридора (иначе бокс не на пути).
      const dLo = corridorAxis === "h" ? b.y : b.x;
      const dHi = corridorAxis === "h" ? b.y + b.h : b.x + b.w;
      if (dHi <= bandLo || dLo >= bandHi) continue;
      found = true;
      const near = corridorAxis === "h" ? b.y : b.x;
      const far = corridorAxis === "h" ? b.y + b.h : b.x + b.w;
      if (near < minTL) minTL = near;
      if (far > maxBR) maxBR = far;
    }

    if (!found) return [];

    if (corridorAxis === "h") {
      // Горизонтальный коридор: уворот по y, x прежний.
      return [
        { label: "lane-after", x: move.x, y: maxBR + gap, noClamp: true },
        {
          label: "lane-before",
          x: move.x,
          y: minTL - gap - move.h,
          noClamp: true,
        },
      ];
    }
    // Вертикальный коридор: уворот по x, y прежний.
    return [
      { label: "lane-after", x: maxBR + gap, y: move.y, noClamp: true },
      {
        label: "lane-before",
        x: minTL - gap - move.w,
        y: move.y,
        noClamp: true,
      },
    ];
  }

  let raw: RawCandidate[];

  if (sameParent) {
    const adjTopX = partner.x + partner.w / 2 - move.w / 2;
    const adjTopY = partner.y - gap - move.h;
    const adjBotX = adjTopX;
    const adjBotY = partner.y + partner.h + gap;
    const adjLeftX = partner.x - gap - move.w;
    const adjLeftY = partner.y + partner.h / 2 - move.h / 2;
    const adjRightX = partner.x + partner.w + gap;
    const adjRightY = adjLeftY;
    const ca = crossAlignXY();

    raw = [
      { label: "adj-top", x: adjTopX, y: adjTopY },
      { label: "adj-bottom", x: adjBotX, y: adjBotY },
      { label: "adj-left", x: adjLeftX, y: adjLeftY },
      { label: "adj-right", x: adjRightX, y: adjRightY },
      { label: "cross-align", x: ca.x, y: ca.y },
    ];
  } else {
    const ca = crossAlignXY();
    const fa = facadeXY();

    raw = [
      { label: "cross-align", x: ca.x, y: ca.y },
      { label: "facade", x: fa.x, y: fa.y },
    ];
  }

  // Lane-кандидаты — ПОСЛЕ базовых, общий путь для same/cross-parent.
  raw = [...raw, ...genLaneCandidates()];

  // Clamp в parent если задан
  function clampCoord(val: number, min: number, max: number): number {
    if (max < min) return min;
    return Math.max(min, Math.min(max, val));
  }

  function clampInParent(x: number, y: number): { x: number; y: number } {
    if (!parent) return { x, y };
    const minX = parent.x + 16;
    const maxX = parent.x + parent.w - 16 - move.w;
    const minY = parent.y + 16;
    const maxY = parent.y + parent.h - 16 - move.h;
    return {
      x: clampCoord(x, minX, maxX),
      y: clampCoord(y, minY, maxY),
    };
  }

  // Применяем clamp, отбрасываем no-op и дубликаты
  const result: ShiftCandidate[] = [];
  const seen = new Set<string>();

  for (const r of raw) {
    // Lane-кандидаты НЕ клампятся в parent: выход за родителя допустим (parent
    // дорастёт grow-only обтяжкой после применения сдвига).
    const { x, y } = r.noClamp ? { x: r.x, y: r.y } : clampInParent(r.x, r.y);

    // Отбрасываем кандидатов с позицией == текущей move
    if (Math.abs(x - move.x) < 0.5 && Math.abs(y - move.y) < 0.5) continue;

    // Отбрасываем дубликаты (после clamp)
    const key = `${x}|${y}`;
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({ moveId: move.id, x, y, label: r.label });
  }

  return result;
}

// ─── Вспомогательная: метрики маршрута ────────────────────────────────────────

function metricsFor(
  pts: Polyline,
  e: RouteEdge,
  boxes: ReadonlyArray<RouteBox>,
  byId: ReadonlyMap<string, RouteBox>,
  otherRoutes: ReadonlyMap<string, Polyline>,
): { foreign: number; edgeCross: number; length: number; crossFlow: number } {
  const foreign = foreignCrossings(pts, e, boxes, byId).length;
  let edgeCross = 0;
  for (const [otherId, other] of otherRoutes) {
    if (otherId === e.id) continue;
    edgeCross += countPolylineCrossings(pts, other);
  }
  const length = polylineLength(pts);
  const srcBox = byId.get(e.from);
  const dstBox = byId.get(e.to);
  const crossFlow =
    srcBox && dstBox ? countCrossFlowTerminals(pts, srcBox, dstBox) : 0;
  return { foreign, edgeCross, length, crossFlow };
}

// ─── evaluateShift ────────────────────────────────────────────────────────────

/**
 * Оценивает кандидатные сдвиги move-бокса и выбирает лучший.
 *
 * Алгоритм:
 * 1. Считаем исходный суммарный score (один раз, до цикла).
 * 2. Для каждого кандидата:
 *    a. Подменяем x/y move-бокса в boxes'.
 *    b. Маршрутизируем → проверяем plan для target.edge (не U/detour → skip).
 *    c. Считаем newScore для target.edge → гейт: для arc — `<=` currentScore,
 *       для inexpressible — строго `<` (иначе skip).
 *    d. Проверяем box overlaps → если выросло → skip.
 *    e. Считаем суммарный score → если вырос > исходного + eps → skip.
 * 3. Победитель: min суммарный score → min длина → меньший индекс.
 */
export function evaluateShift(
  target: ShiftTarget,
  candidates: ReadonlyArray<ShiftCandidate>,
  boxes: ReadonlyArray<RouteBox>,
  edges: ReadonlyArray<RouteEdge>,
  routeFn: (
    boxes: ReadonlyArray<RouteBox>,
    edges: ReadonlyArray<RouteEdge>,
  ) => ReadonlyMap<string, Polyline>,
): { candidate: ShiftCandidate; newScore: number } | null {
  const byId = buildBoxIndex(boxes);

  // Исходный суммарный score (один раз)
  const baseRoutes = routeFn(boxes, edges);
  const baseByIdMap = byId;
  let baseTotal = 0;
  for (const e of edges) {
    const pts = baseRoutes.get(e.id);
    if (!pts) continue;
    const m = metricsFor(pts, e, boxes, baseByIdMap, baseRoutes);
    baseTotal += routeScore(m);
  }

  // Исходное число overlaps
  const baseOverlaps = countBoxOverlaps(boxes);

  type Winner = {
    candidate: ShiftCandidate;
    newScore: number;
    totalScore: number;
    targetLength: number;
    index: number;
  };
  let winner: Winner | null = null;

  for (let idx = 0; idx < candidates.length; idx++) {
    const candidate = candidates[idx];
    if (!candidate) continue;

    // Подменяем позицию move-бокса
    const boxes2: RouteBox[] = boxes.map((b) => {
      if (b.id !== candidate.moveId) return b;
      return { ...b, x: candidate.x, y: candidate.y };
    });

    const routes2 = routeFn(boxes2, edges);
    const route2 = routes2.get(target.edge.id);
    if (!route2) continue;

    const byId2 = buildBoxIndex(boxes2);

    // srcBox' и dstBox' из boxes'
    const srcBox2 = byId2.get(target.edge.from);
    const dstBox2 = byId2.get(target.edge.to);
    if (!srcBox2 || !dstBox2) continue;

    // Проверяем plan
    const plan2 = planTransfer(route2, srcBox2, dstBox2);
    if (plan2.kind !== "straight" && plan2.kind !== "L" && plan2.kind !== "Z") {
      continue;
    }

    // newScore для target.edge
    const targetMetrics = metricsFor(
      route2,
      target.edge,
      boxes2,
      byId2,
      routes2,
    );
    const newScore = routeScore(targetMetrics);
    // Гейт п.2: сдвиг должен дать строго лучший score, КРОМЕ случая, когда
    // текущий маршрут — arc-дуга: тогда elbow-через-сдвиг побеждает при равном
    // score (`<=` с eps), т.к. дуга — паллиатив, а явный elbow предпочтительнее.
    const passesGate = target.currentIsArc
      ? newScore <= target.currentScore + 1e-9
      : newScore < target.currentScore;
    if (!passesGate) continue;

    // Проверяем overlaps
    const overlaps2 = countBoxOverlaps(boxes2);
    if (overlaps2 > baseOverlaps) continue;

    // Суммарный score по boxes'
    let total2 = 0;
    for (const e of edges) {
      const pts = routes2.get(e.id);
      if (!pts) continue;
      const m = metricsFor(pts, e, boxes2, byId2, routes2);
      total2 += routeScore(m);
    }
    if (total2 > baseTotal + 1e-6) continue;

    // Длина target-полилинии (тай-брейк)
    const targetLength = polylineLength(route2);

    // Выбираем победителя: min total → min targetLength → меньший индекс
    if (
      winner === null ||
      total2 < winner.totalScore - 1e-9 ||
      (Math.abs(total2 - winner.totalScore) < 1e-9 &&
        targetLength < winner.targetLength - 1e-9) ||
      (Math.abs(total2 - winner.totalScore) < 1e-9 &&
        Math.abs(targetLength - winner.targetLength) < 1e-9 &&
        idx < winner.index)
    ) {
      winner = {
        candidate,
        newScore,
        totalScore: total2,
        targetLength,
        index: idx,
      };
    }
  }

  if (!winner) return null;
  return { candidate: winner.candidate, newScore: winner.newScore };
}
