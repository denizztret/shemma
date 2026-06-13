// apps/frontend/src/canvas/edge-routing.ts
// DRW-199 T4: оркестратор edge-routing — сбор боксов, гейт, writeback, отчёт.
// Editor-зависимая часть тонкая; решающая логика — decideEdges (чистая функция).

import type { Editor, TLShapeId } from "tldraw";
import {
  type Polyline,
  type RouteBox,
  type RouteEdge,
  type RouteMetrics,
  type TransferPlan,
  anchorFor,
  assignPorts,
  axisOfDirection,
  buildBoxIndex,
  candidateBeatsCurrent,
  classifyEdges,
  countCrossFlowTerminals,
  countPolylineCrossings,
  foreignCrossings,
  maxEndpointDegree,
  pickArcBend,
  planTransfer,
  polylineLength,
  routeScore,
  sampleArc,
  sampledForeignCrossings,
} from "./edge-routing-core";
import {
  type ShiftCandidate,
  type ShiftTarget,
  evaluateShift,
  genShiftCandidates,
  pickMovableEnd,
} from "./edge-routing-shift";
import { loadAvoid, routeClasses } from "./libavoid-router";

// ─── Константы ────────────────────────────────────────────────────────────────

const BUFFER_DISTANCE = 12;
const NUDGE_DISTANCE = 16;

// ─── Чистая решающая логика ───────────────────────────────────────────────────

export interface EdgeDecision {
  readonly edgeId: string;
  readonly action: "apply" | "arc" | "inexpressible" | "gate-skip";
  readonly plan?: TransferPlan;
  readonly route?: Polyline;
  readonly foreignBest?: number;
  readonly foreignRoute?: number;
  readonly arcBend?: number;
  /** Концы ребра — нужны shift-прогону (и отчёту inexpressible). */
  readonly from?: string;
  readonly to?: string;
  /** Тип нерешённого elbow-плана для action "arc"/"inexpressible" — цель сдвига. */
  readonly planKind?: "U" | "detour";
  /** Score лучшего ТЕКУЩЕГО варианта этого ребра: для "arc" — score принятой
   * дуги, для "inexpressible" — foreignBest. Базовая планка для shift-прогона. */
  readonly currentScore?: number;
}

function metricsFor(
  pts: Polyline,
  edge: RouteEdge,
  boxes: ReadonlyArray<RouteBox>,
  byId: ReadonlyMap<string, RouteBox>,
  otherRoutes: ReadonlyMap<string, Polyline>,
): RouteMetrics {
  const foreign = foreignCrossings(pts, edge, boxes, byId).length;
  let edgeCross = 0;
  for (const [otherId, other] of otherRoutes) {
    if (otherId === edge.id) continue;
    edgeCross += countPolylineCrossings(pts, other);
  }
  const length = polylineLength(pts);
  const srcBox = byId.get(edge.from);
  const dstBox = byId.get(edge.to);
  const crossFlow =
    srcBox && dstBox ? countCrossFlowTerminals(pts, srcBox, dstBox) : 0;
  return { foreign, edgeCross, length, crossFlow };
}

export function decideEdges(
  boxes: ReadonlyArray<RouteBox>,
  edges: ReadonlyArray<RouteEdge>,
  routes: ReadonlyMap<string, Polyline>,
  currents: ReadonlyMap<string, Polyline>,
): EdgeDecision[] {
  const byId = buildBoxIndex(boxes);
  const decisions: EdgeDecision[] = [];

  for (const edge of edges) {
    const route = routes.get(edge.id);
    if (!route) continue;

    const srcBox = byId.get(edge.from);
    const dstBox = byId.get(edge.to);
    if (!srcBox || !dstBox) continue;

    const routeMetrics = metricsFor(route, edge, boxes, byId, routes);
    const plan = planTransfer(route, srcBox, dstBox);

    const current = currents.get(edge.id);
    const currentMetrics = current
      ? metricsFor(current, edge, boxes, byId, currents)
      : null;

    // U или detour — elbow не выразит; пробуем arc-кандидат
    if (plan.kind === "U" || plan.kind === "detour") {
      const bend = pickArcBend(route, edge, boxes, byId);
      if (bend !== null) {
        const start = route[0];
        const end = route[route.length - 1];
        if (start !== undefined && end !== undefined) {
          const arcSamples = sampleArc(start, end, bend);
          const arcForeign = sampledForeignCrossings(
            arcSamples,
            edge,
            boxes,
            byId,
          ).length; // 0 по построению pickArcBend
          const arcLength = polylineLength(arcSamples);
          // edgeCross для arc-кандидата считается консервативно — равен edgeCross
          // текущего маршрута (countPolylineCrossings рассчитан для ortho-полилиний
          // и даст неточный счёт для кривой; принимаем worst-case = current).
          const arcEdgeCross = currentMetrics
            ? currentMetrics.edgeCross
            : routeMetrics.edgeCross;
          const arcMetrics = {
            foreign: arcForeign,
            edgeCross: arcEdgeCross,
            length: arcLength,
            crossFlow: 0,
          };
          const shouldApplyArc = currentMetrics
            ? candidateBeatsCurrent(arcMetrics, currentMetrics)
            : true; // нет текущего — применяем дугу
          if (shouldApplyArc) {
            decisions.push({
              edgeId: edge.id,
              action: "arc",
              route,
              arcBend: bend,
              from: edge.from,
              to: edge.to,
              planKind: plan.kind,
              // Базовая планка для shift-прогона — score принятой дуги.
              currentScore: routeScore(arcMetrics),
            });
            continue;
          }
        }
      }
      const foreignBest = routeScore(currentMetrics ?? routeMetrics);
      const foreignRoute = routeScore(routeMetrics);
      decisions.push({
        edgeId: edge.id,
        action: "inexpressible",
        foreignBest,
        foreignRoute,
        from: edge.from,
        to: edge.to,
        planKind: plan.kind,
        currentScore: foreignBest,
      });
      continue;
    }

    // Гейт: если текущий маршрут есть и кандидат не лучше — пропускаем
    if (
      currentMetrics &&
      !candidateBeatsCurrent(routeMetrics, currentMetrics)
    ) {
      decisions.push({ edgeId: edge.id, action: "gate-skip" });
      continue;
    }

    decisions.push({ edgeId: edge.id, action: "apply", plan, route });
  }

  return decisions;
}

// ─── Планирование сдвигов блоков (чистая, тестируется без WASM — DRW-246) ─────

/** Один принятый сдвиг: какое ребро его спровоцировало, какой узел сдвинут,
 * новая позиция и дельта относительно исходной. */
export interface PlannedShift {
  readonly edgeId: string;
  readonly movedId: string;
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
}

/**
 * Из решений decideEdges выбирает цели сдвига (arc/inexpressible с planKind
 * U/detour), и для каждой пытается сдвинуть подвижный конец так, чтобы маршрут
 * стал выразимым elbow'ом. Принятые сдвиги применяются к РАБОЧЕЙ КОПИИ боксов
 * последовательно: следующая цель видит сдвиг предыдущей.
 *
 * Детерминизм: цели сортируются по edgeId; порядок кандидатов фиксирован в
 * genShiftCandidates; тай-брейки — в evaluateShift.
 *
 * Чистая функция: editor/WASM не трогает. routeFn — инъекция роутера.
 */
export function planShiftsForDecisions(
  decisions: ReadonlyArray<EdgeDecision>,
  boxes: ReadonlyArray<RouteBox>,
  edges: ReadonlyArray<RouteEdge>,
  degree: ReadonlyMap<string, number>,
  pinned: ReadonlySet<string>,
  routeFn: (
    boxes: ReadonlyArray<RouteBox>,
    edges: ReadonlyArray<RouteEdge>,
  ) => ReadonlyMap<string, Polyline>,
): PlannedShift[] {
  // Цели: только arc/inexpressible с planKind U/detour, детерминированно по edgeId.
  const targets = decisions
    .filter(
      (d) =>
        (d.action === "arc" || d.action === "inexpressible") &&
        (d.planKind === "U" || d.planKind === "detour") &&
        d.from !== undefined &&
        d.to !== undefined &&
        d.currentScore !== undefined,
    )
    .sort((a, b) => a.edgeId.localeCompare(b.edgeId));

  // Рабочая копия боксов — мутируется по мере принятия сдвигов (id → box).
  let workBoxes: RouteBox[] = boxes.map((b) => ({ ...b }));
  const result: PlannedShift[] = [];

  for (const d of targets) {
    const from = d.from as string;
    const to = d.to as string;
    const byId = buildBoxIndex(workBoxes);
    const edge: RouteEdge = { id: d.edgeId, from, to };

    const moveId = pickMovableEnd(edge, byId, degree, pinned);
    if (moveId === null) continue;

    const move = byId.get(moveId);
    if (!move) continue;
    const partnerId = moveId === from ? to : from;
    const partner = byId.get(partnerId);
    if (!partner) continue;

    // parent-бокс move — RouteBox с id === move.parent (может отсутствовать).
    const parent = move.parent ? (byId.get(move.parent) ?? null) : null;
    const srcBox = byId.get(from);
    const dstBox = byId.get(to);
    const sameParent =
      srcBox !== undefined &&
      dstBox !== undefined &&
      srcBox.parent === dstBox.parent;

    const candidates: ShiftCandidate[] = genShiftCandidates(
      move,
      partner,
      parent,
      sameParent,
      // obstacles = весь scope (рабочая копия): lane-кандидаты ищут препятствия коридора.
      workBoxes,
    );
    if (candidates.length === 0) continue;

    const target: ShiftTarget = {
      edge,
      planKind: d.planKind as "U" | "detour",
      currentScore: d.currentScore as number,
      // arc → дуга-паллиатив (гейт `<=`); inexpressible → строгий `<`.
      currentIsArc: d.action === "arc",
    };
    const picked = evaluateShift(target, candidates, workBoxes, edges, routeFn);
    if (!picked) continue;

    const { candidate } = picked;
    const dx = candidate.x - move.x;
    const dy = candidate.y - move.y;
    result.push({
      edgeId: d.edgeId,
      movedId: moveId,
      x: candidate.x,
      y: candidate.y,
      dx,
      dy,
    });

    // Применяем сдвиг к рабочей копии — следующая цель видит его.
    workBoxes = workBoxes.map((b) =>
      b.id === moveId ? { ...b, x: candidate.x, y: candidate.y } : b,
    );
  }

  return result;
}

// ─── Фильтрация роутабельных рёбер (чистая, тестируется отдельно) ─────────────

export interface FilterResult {
  readonly routable: RouteEdge[];
  /** id выровненных Ф2 рёбер — роутятся НАРАВНЕ с остальными: их прямая линия
   * участвует в гейте (чистая выживает сама, сквозь-боксовая проигрывает обходу).
   * Live-находка T5: безусловный skip сохранял дефектное ребро A3→E2. */
  readonly alignedIds: ReadonlySet<string>;
}

export function filterRoutableEdges(
  byArrow: Readonly<Record<string, { start?: string; end?: string }>>,
  inScope: ReadonlySet<string>,
  byId: ReadonlyMap<string, RouteBox>,
  alignedEdges?: ReadonlySet<string>,
): FilterResult {
  const alignedIds = new Set<string>();
  const routable: RouteEdge[] = [];

  for (const [aid, t] of Object.entries(byArrow)) {
    if (!t.start || !t.end) continue;
    // Scope по КОНЦАМ ребра (инвариант distributeArrowPorts: byArrow покрывает весь
    // store, стрелки в inScope не входят) — byId собран из inScope-боксов.
    if (!inScope.has(t.start) || !inScope.has(t.end)) continue;
    if (!byId.has(t.start) || !byId.has(t.end)) continue;
    const key = `${t.start}>${t.end}`;
    const keyRev = `${t.end}>${t.start}`;
    if (alignedEdges && (alignedEdges.has(key) || alignedEdges.has(keyRev))) {
      alignedIds.add(aid);
    }
    routable.push({ id: aid, from: t.start, to: t.end });
  }

  return { routable, alignedIds };
}

// ─── Editor-обвязка ───────────────────────────────────────────────────────────

export interface EdgeRoutingReport {
  routed: number;
  approximated: string[];
  /** gate-skip рёбра: маршрут не лучше текущего (гейт отклонил). */
  skipped: string[];
  /** classification-skip: лист→свой контейнер или битые концы —
   * пасс их не обслуживал; нуждаются в residual distributeArrowPorts. */
  unrouted: string[];
  alignedKept: number;
  inexpressible: Array<{
    edgeId: string;
    from: string;
    to: string;
    foreignBest: number;
    foreignRoute: number;
  }>;
  /** Принятые сдвиги блоков (DRW-246): ребро, сдвинутый узел, дельта позиции.
   * Всегда присутствует (пустой, если сдвигов нет). */
  shifted: Array<{ edgeId: string; movedId: string; dx: number; dy: number }>;
}

export interface EdgeRoutingOpts {
  readonly alignedEdges?: ReadonlySet<string>;
  readonly pinsPerSide?: number;
  /** Направление потока scope-фрейма/контейнера ("TB"|"BT"|"LR"|"RL"). */
  readonly flowDir?: string;
  /** Grow-only обтяжка предков для сдвинутых узлов (DRW-246). Передаётся
   * call-site'ами из elk-layout (growWrappersForShapes) — параметром, а не
   * импортом, чтобы избежать цикла зависимостей. По умолчанию no-op. */
  readonly refitWrappers?: (movedIds: ReadonlyArray<string>) => void;
  /** Force-семантика ⌘⌥⇧L: раскладка переразложила и pinned-узлы, поэтому
   * и сдвиг блока (DRW-246) не должен считать их неподвижными. */
  readonly forceUnpin?: boolean;
}

/** Собирает RouteBox из editor по inScope.
 * geo → leaf, schema-container → container.
 * parent = ближайший schema-container-предок в inScope (подъём по parentId).
 */
export function collectRouteBoxes(
  editor: Editor,
  inScope: ReadonlySet<string>,
  opts?: EdgeRoutingOpts,
): RouteBox[] {
  const result: RouteBox[] = [];

  for (const id of inScope) {
    const shape = editor.getShape(id as TLShapeId);
    if (!shape) continue;
    if (shape.type === "arrow") continue;

    const bounds = editor.getShapePageBounds(id as TLShapeId);
    if (!bounds) continue;

    const kind: RouteBox["kind"] =
      shape.type === "schema-container" ? "container" : "leaf";

    // Ищем ближайшего schema-container-предка в scope
    let parent: string | null = null;
    // biome-ignore lint/suspicious/noExplicitAny: tldraw shape parentId строка
    let curParentId: string = (shape as any).parentId as string;
    while (curParentId && inScope.has(curParentId)) {
      const parentShape = editor.getShape(curParentId as TLShapeId);
      if (parentShape?.type === "schema-container") {
        parent = curParentId;
        break;
      }
      // biome-ignore lint/suspicious/noExplicitAny: tldraw shape parentId строка
      curParentId = (parentShape as any)?.parentId as string;
    }

    let flowAxis: "h" | "v" | undefined;
    if (parent !== null) {
      const parentShape = editor.getShape(parent as TLShapeId);
      // Канон направления контейнера — meta.didrawDirection (TB/BT/LR/RL);
      // props.direction при ручных правках вырождается в "custom" (DRW-150)
      // и осью не является. Фоллбэк — направление scope.
      // biome-ignore lint/suspicious/noExplicitAny: schema-container meta/props
      const metaDir = (parentShape as any)?.meta?.didrawDirection as
        | string
        | undefined;
      // biome-ignore lint/suspicious/noExplicitAny: schema-container props
      const propsDir = (parentShape as any)?.props?.direction as
        | string
        | undefined;
      flowAxis =
        axisOfDirection(metaDir) ??
        axisOfDirection(propsDir) ??
        axisOfDirection(opts?.flowDir);
    } else {
      flowAxis = axisOfDirection(opts?.flowDir);
    }

    result.push({
      id,
      kind,
      parent,
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
      flowAxis,
    });
  }

  return result;
}

/** Текущая полилиния стрелки в page-координатах.
 * null если недоступна или меньше 2 точек.
 */
export function currentArrowPolyline(
  editor: Editor,
  arrowId: string,
): Polyline | null {
  const g = editor.getShapeGeometry(arrowId as TLShapeId);
  const tr = editor.getShapePageTransform(arrowId as TLShapeId);
  if (!g || !tr) return null;

  const pts: Array<readonly [number, number]> = g.vertices.map((v) => {
    const p = tr.applyToPoint(v);
    return [p.x, p.y] as const;
  });

  if (pts.length < 2) return null;
  return pts;
}

// ─── Writeback-план (чистая функция, тестируется без WASM) ───────────────────

export interface BindingUpdate {
  readonly bindingId: string;
  readonly fromId: string;
  readonly toId: string;
  readonly props: Record<string, unknown> & { terminal: "start" | "end" };
  readonly normalizedAnchor: { x: number; y: number };
}

export interface ShapeUpdate {
  readonly shapeId: string;
  readonly props:
    | { kind: "elbow"; elbowMidPoint: number }
    | { kind: "arc"; bend: number };
}

export interface WritebackPlan {
  readonly bindingUpdates: BindingUpdate[];
  readonly shapeUpdates: ShapeUpdate[];
}

/** Строит план writeback из decisions и assignments — без editor. */
export function buildWritebackPlan(
  decisions: ReadonlyArray<EdgeDecision>,
  assignments: ReturnType<typeof assignPorts>,
  bindByKey: ReadonlyMap<
    string,
    {
      id: string;
      fromId: string;
      toId: string;
      props: Record<string, unknown> & { terminal: "start" | "end" };
    }
  >,
): WritebackPlan {
  const bindingUpdates: BindingUpdate[] = [];
  for (const assignment of assignments) {
    for (const slot of assignment.ports) {
      const rec = bindByKey.get(`${slot.edgeId}|${slot.terminal}`);
      if (!rec) continue;
      bindingUpdates.push({
        bindingId: rec.id,
        fromId: rec.fromId,
        toId: rec.toId,
        props: rec.props,
        normalizedAnchor: anchorFor(assignment.side, slot.frac),
      });
    }
  }

  const shapeUpdates: ShapeUpdate[] = [];
  for (const d of decisions) {
    if (d.action === "apply" && d.plan) {
      // Для straight/L: явно пишем elbowMidPoint: 0.5 — иначе stale значение
      // от прошлых прогонов остаётся (updateShape мержит props).
      shapeUpdates.push({
        shapeId: d.edgeId,
        props:
          d.plan.kind === "Z" && d.plan.elbowMidPoint !== undefined
            ? { kind: "elbow", elbowMidPoint: d.plan.elbowMidPoint }
            : { kind: "elbow", elbowMidPoint: 0.5 },
      });
    } else if (d.action === "arc" && d.arcBend !== undefined) {
      shapeUpdates.push({
        shapeId: d.edgeId,
        props: { kind: "arc", bend: d.arcBend },
      });
    }
  }

  return { bindingUpdates, shapeUpdates };
}

/** Читает все binding-записи store типа arrow; индексирует по `${fromId}|${terminal}`. */
function loadBindingIndex(editor: Editor): Map<
  string,
  {
    id: string;
    fromId: string;
    toId: string;
    props: Record<string, unknown> & { terminal: "start" | "end" };
  }
> {
  const bindings = editor.store.allRecords().filter((r) => {
    const x = r as { typeName: string; type?: string };
    return x.typeName === "binding" && x.type === "arrow";
  }) as unknown as Array<{
    id: string;
    fromId: string;
    toId: string;
    props: Record<string, unknown> & { terminal: "start" | "end" };
  }>;

  return new Map(bindings.map((b) => [`${b.fromId}|${b.props.terminal}`, b]));
}

/** Степень узлов scope: сколько routable-рёбер инцидентно каждому концу. */
function buildDegreeMap(edges: ReadonlyArray<RouteEdge>): Map<string, number> {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  return degree;
}

/** Pinned-узлы scope: только ПОЗИЦИОННЫЙ пин (meta.pinned). didrawSizePinned
 * охраняет размер, не позицию — его ставит авто-обтяжка текста каждому узлу,
 * и он не должен запрещать сдвиг блока. */
function collectPinnedSet(
  editor: Editor,
  inScope: ReadonlySet<string>,
): Set<string> {
  const pinned = new Set<string>();
  for (const id of inScope) {
    const shape = editor.getShape(id as TLShapeId);
    // biome-ignore lint/suspicious/noExplicitAny: tldraw shape meta
    const meta = (shape as any)?.meta as Record<string, unknown> | undefined;
    if (meta?.pinned === true) {
      pinned.add(id);
    }
  }
  return pinned;
}

/** Главный пасс. Возвращает null если libavoid недоступен или при ошибке.
 * `depth` — внутренний: 0 = первичный прогон (выполняет shift-прогон),
 * 1 = повторный прогон после применённых сдвигов (shift не выполняется). */
export async function runEdgeRoutingPass(
  editor: Editor,
  inScope: ReadonlySet<string>,
  byArrow: Readonly<Record<string, { start?: string; end?: string }>>,
  opts: EdgeRoutingOpts = {},
  depth = 0,
): Promise<EdgeRoutingReport | null> {
  const Avoid = await loadAvoid();
  if (!Avoid) return null;

  // Сбор боксов и фильтрация — вне try (нет WASM-объектов, падение маловероятно)
  const boxes = collectRouteBoxes(editor, inScope, opts);
  const byId = buildBoxIndex(boxes);

  const report: EdgeRoutingReport = {
    routed: 0,
    approximated: [],
    skipped: [],
    unrouted: [],
    alignedKept: 0,
    inexpressible: [],
    shifted: [],
  };

  const { routable, alignedIds } = filterRoutableEdges(
    byArrow,
    inScope,
    byId,
    opts.alignedEdges,
  );

  if (routable.length === 0) return report;

  try {
    const { classes, skipped } = classifyEdges(boxes, routable);
    // classification-skip → unrouted (residual-порты нужны)
    for (const e of skipped) report.unrouted.push(e.id);

    // pinsPerSide по максимальной степени узла — хаб с >3 рёбрами не упрётся в лимит
    const pinsPerSide =
      opts.pinsPerSide ?? Math.max(3, maxEndpointDegree(routable));

    const routes = routeClasses(Avoid, boxes, classes, {
      bufferDistance: BUFFER_DISTANCE,
      nudgeDistance: NUDGE_DISTANCE,
      pinsPerSide,
    });

    // Собираем рёбра с маршрутами (только те, что реально маршрутизированы)
    const routedEdges = routable.filter((e) => routes.has(e.id));

    // Текущие полилинии для гейта
    const currents = new Map<string, Polyline>();
    for (const e of routedEdges) {
      const poly = currentArrowPolyline(editor, e.id);
      if (poly) currents.set(e.id, poly);
    }

    const decisions = decideEdges(boxes, routedEdges, routes, currents);

    // ─── Shift-прогон (DRW-246) — только на глубине 0 ──────────────────────
    // Цели = arc/inexpressible (U/detour). Сдвигаем подвижный конец ребра так,
    // чтобы маршрут стал выразимым elbow'ом, затем перезапускаем пасс (depth=1).
    if (depth === 0) {
      const degree = buildDegreeMap(routedEdges);
      const pinned = opts.forceUnpin
        ? new Set<string>()
        : collectPinnedSet(editor, inScope);
      // routeFn для shift-ядра: те же opts роутера, что и основной прогон.
      const routeFn = (
        b2: ReadonlyArray<RouteBox>,
        e2: ReadonlyArray<RouteEdge>,
      ): ReadonlyMap<string, Polyline> => {
        const { classes: cls2 } = classifyEdges(b2, e2);
        return routeClasses(Avoid, b2, cls2, {
          bufferDistance: BUFFER_DISTANCE,
          nudgeDistance: NUDGE_DISTANCE,
          pinsPerSide,
        });
      };
      const shifts = planShiftsForDecisions(
        decisions,
        boxes,
        routedEdges,
        degree,
        pinned,
        routeFn,
      );

      if (shifts.length > 0) {
        const movedIds = shifts.map((s) => s.movedId);
        // Применяем сдвиги: page-координаты ядра → parent-локальные шейпа.
        editor.run(
          () => {
            for (const s of shifts) {
              const local = editor.getPointInParentSpace(
                s.movedId as TLShapeId,
                {
                  x: s.x,
                  y: s.y,
                },
              );
              editor.updateShape({
                id: s.movedId as TLShapeId,
                type: editor.getShape(s.movedId as TLShapeId)?.type as string,
                x: local.x,
                y: local.y,
              } as never);
            }
            // Grow-only обтяжка предков сдвинутых узлов (call-site прокидывает
            // growWrappersForShapes; дефолт no-op).
            opts.refitWrappers?.(movedIds);
          },
          { history: "ignore" },
        );

        // Перезапуск пасса на изменённой геометрии — он сделает реальный writeback.
        const sub = await runEdgeRoutingPass(editor, inScope, byArrow, opts, 1);
        const shiftedRecords = shifts.map((s) => ({
          edgeId: s.edgeId,
          movedId: s.movedId,
          dx: s.dx,
          dy: s.dy,
        }));
        if (sub) {
          sub.shifted = shiftedRecords;
          return sub;
        }
        // Sub-пасс упал/недоступен — отдаём отчёт без writeback, но со сдвигами.
        report.shifted = shiftedRecords;
        return report;
      }
    }

    const appliedEdges: RouteEdge[] = [];
    const appliedRoutes = new Map<string, Polyline>();

    for (const d of decisions) {
      if (d.action === "apply" && d.plan && d.route) {
        const found = routedEdges.find((e) => e.id === d.edgeId);
        if (found) appliedEdges.push(found);
        appliedRoutes.set(d.edgeId, d.route);
      } else if (d.action === "arc" && d.route) {
        // arc-рёбра участвуют в раздаче портов наравне с applied:
        // стороны выхода у дуги те же, что у маршрута libavoid.
        const found = routedEdges.find((e) => e.id === d.edgeId);
        if (found) appliedEdges.push(found);
        appliedRoutes.set(d.edgeId, d.route);
        report.approximated.push(d.edgeId);
      } else if (d.action === "gate-skip") {
        // gate-skip → skipped (осознанный пропуск гейтом, якоря не трогаем)
        if (alignedIds.has(d.edgeId)) report.alignedKept++;
        else report.skipped.push(d.edgeId);
      } else if (d.action === "inexpressible") {
        report.inexpressible.push({
          edgeId: d.edgeId,
          from: d.from ?? "",
          to: d.to ?? "",
          foreignBest: d.foreignBest ?? 0,
          foreignRoute: d.foreignRoute ?? 0,
        });
      }
    }

    const assignments = assignPorts(appliedRoutes, appliedEdges, byId);

    // Writeback в одной транзакции
    editor.run(
      () => {
        const bindByKey = loadBindingIndex(editor);
        const plan = buildWritebackPlan(decisions, assignments, bindByKey);

        // Анкоры через updateBinding — тем же механизмом, что distributeArrowPorts
        for (const bu of plan.bindingUpdates) {
          editor.updateBinding({
            id: bu.bindingId,
            type: "arrow",
            fromId: bu.fromId,
            toId: bu.toId,
            props: {
              ...bu.props,
              isPrecise: true,
              normalizedAnchor: bu.normalizedAnchor,
            },
          } as never);
        }

        // Props стрелок
        for (const su of plan.shapeUpdates) {
          editor.updateShape({
            id: su.shapeId as TLShapeId,
            type: "arrow",
            props: su.props,
          });
        }
      },
      { history: "ignore" },
    );

    report.routed = appliedEdges.length;
  } catch (err) {
    console.warn(
      "[shemma] edge-routing pass failed — fallback к elbow-пассу",
      err,
    );
    return null;
  }

  return report;
}
