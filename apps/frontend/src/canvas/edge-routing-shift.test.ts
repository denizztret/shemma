// apps/frontend/src/canvas/edge-routing-shift.test.ts
// DRW-246: тесты для чистого ядра сдвига блока (TDD — сначала красные, потом зелёные).

import { describe, expect, test } from "bun:test";
import {
  type Polyline,
  type RouteBox,
  type RouteEdge,
  buildBoxIndex,
  countCrossFlowTerminals,
  countPolylineCrossings,
  foreignCrossings,
  planTransfer,
  polylineLength,
  routeScore,
} from "./edge-routing-core";
import {
  type ShiftCandidate,
  type ShiftTarget,
  evaluateShift,
  genShiftCandidates,
  pickMovableEnd,
} from "./edge-routing-shift";

// ─── Вспомогательные фабрики ──────────────────────────────────────────────────

/** Типобезопасный lookup: бросает Error при отсутствии (только для тестов). */
function findBox(bxs: ReadonlyArray<RouteBox>, id: string): RouteBox {
  const found = bxs.find((b) => b.id === id);
  if (!found) throw new Error(`Box '${id}' not found in test fixture`);
  return found;
}

function leaf(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  parent: string | null = null,
): RouteBox {
  return { id, kind: "leaf", x, y, w, h, parent };
}

function container(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  parent: string | null = null,
): RouteBox {
  return { id, kind: "container", x, y, w, h, parent };
}

function edge(id: string, from: string, to: string): RouteEdge {
  return { id, from, to };
}

// ─── pickMovableEnd ────────────────────────────────────────────────────────────

describe("pickMovableEnd", () => {
  const boxA = leaf("A", 0, 0, 100, 50);
  const boxB = leaf("B", 200, 0, 120, 60);
  const boxes = new Map([
    ["A", boxA],
    ["B", boxB],
  ]);
  const e = edge("e1", "A", "B");

  test("pinned-конец отсечён → возвращает другой", () => {
    const degree = new Map([
      ["A", 1],
      ["B", 1],
    ]);
    const pinned = new Set(["A"]);
    const result = pickMovableEnd(e, boxes, degree, pinned);
    expect(result).toBe("B");
  });

  test("degree > 2 отсечён → возвращает другой", () => {
    const degree = new Map([
      ["A", 3],
      ["B", 1],
    ]);
    const pinned = new Set<string>();
    const result = pickMovableEnd(e, boxes, degree, pinned);
    expect(result).toBe("B");
  });

  test("kind=container отсечён → возвращает другой", () => {
    const boxC = container("C", 0, 0, 100, 50);
    const boxD = leaf("D", 200, 0, 80, 40);
    const bxs = new Map([
      ["C", boxC],
      ["D", boxD],
    ]);
    const degree = new Map([
      ["C", 1],
      ["D", 1],
    ]);
    const eCD = edge("eCD", "C", "D");
    const result = pickMovableEnd(eCD, bxs, degree, new Set());
    expect(result).toBe("D");
  });

  test("tie-break по площади (равная степень, меньшая площадь побеждает)", () => {
    // boxA = 100×50 = 5000, boxB = 120×60 = 7200 → A меньше → A побеждает
    const degree = new Map([
      ["A", 1],
      ["B", 1],
    ]);
    const result = pickMovableEnd(e, boxes, degree, new Set());
    expect(result).toBe("A");
  });

  test("tie-break → to (равная степень, равная площадь → предпочитаем to)", () => {
    const boxE = leaf("E", 0, 0, 100, 50);
    const boxF = leaf("F", 200, 0, 100, 50);
    const bxs = new Map([
      ["E", boxE],
      ["F", boxF],
    ]);
    const eEF = edge("eEF", "E", "F");
    const degree = new Map([
      ["E", 1],
      ["F", 1],
    ]);
    const result = pickMovableEnd(eEF, bxs, degree, new Set());
    expect(result).toBe("F");
  });

  test("оба негодны → null", () => {
    const degree = new Map([
      ["A", 1],
      ["B", 1],
    ]);
    const pinned = new Set(["A", "B"]);
    const result = pickMovableEnd(e, boxes, degree, pinned);
    expect(result).toBeNull();
  });
});

// ─── genShiftCandidates ────────────────────────────────────────────────────────

describe("genShiftCandidates", () => {
  // move = {id:"A", kind:"leaf", x:100, y:200, w:100, h:40}
  // partner = {id:"B", kind:"leaf", x:300, y:180, w:120, h:60}
  const move = leaf("A", 100, 200, 100, 40);
  const partner = leaf("B", 300, 180, 120, 60);

  test("same-parent: 5 кандидатов с точными координатами", () => {
    const candidates = genShiftCandidates(move, partner, null, true, []);
    expect(candidates).toHaveLength(5);

    // adj-top: x = 300 + 60 - 50 = 310, y = 180 - 24 - 40 = 116
    expect(candidates[0]).toMatchObject({ label: "adj-top", x: 310, y: 116 });
    // adj-bottom: x = 310, y = 180 + 60 + 24 = 264
    expect(candidates[1]).toMatchObject({
      label: "adj-bottom",
      x: 310,
      y: 264,
    });
    // adj-left: x = 300 - 24 - 100 = 176, y = 180 + 30 - 20 = 190
    expect(candidates[2]).toMatchObject({ label: "adj-left", x: 176, y: 190 });
    // adj-right: x = 300 + 120 + 24 = 444, y = 190
    expect(candidates[3]).toMatchObject({ label: "adj-right", x: 444, y: 190 });
    // cross-align (нет flowAxis → "v"): x = 310, y = 200 (сохраняем y move)
    expect(candidates[4]).toMatchObject({
      label: "cross-align",
      x: 310,
      y: 200,
    });
  });

  test("cross-parent: 2 кандидата с точными координатами", () => {
    // parent = {id:"P", kind:"container", x:0, y:0, w:600, h:500}
    // move: cx = 100+50 = 150, cy = 200+20 = 220
    // partner: cx = 300+60 = 360, cy = 180+30 = 210
    // dcx = 360 - 150 = 210, dcy = 210 - 220 = -10
    // |dcx| >= |dcy| → горизонтальная ось, dcx > 0 → x = 600 - 16 - 100 = 484, y = 200
    const parent = container("P", 0, 0, 600, 500);
    const candidates = genShiftCandidates(move, partner, parent, false, []);
    expect(candidates).toHaveLength(2);
    // cross-align: x=310, y=200
    expect(candidates[0]).toMatchObject({
      label: "cross-align",
      x: 310,
      y: 200,
    });
    // facade: x = 484, y = 200
    expect(candidates[1]).toMatchObject({ label: "facade", x: 484, y: 200 });
  });

  test("clamp в родителя: узкие границы зажимают позицию", () => {
    // Узкий parent: adj-top уйдёт за верхнюю границу → clamp прижмёт
    // parent: x=50, y=100, w=300, h=200 → clamp y: [116, 116+padding_check]
    // adj-top y=116; parent.y+16=116 → min boundary
    // adj-top x=310; parent.x+16=66, parent.x+parent.w-16-move.w=50+300-16-100=234
    // Так что x=310 → clamp до 234
    const narrowParent = container("NP", 50, 100, 300, 200);
    const moveInParent = leaf("A", 100, 200, 100, 40, "NP");
    const partnerInParent = leaf("B", 300, 180, 120, 60, "NP");
    const candidates = genShiftCandidates(
      moveInParent,
      partnerInParent,
      narrowParent,
      true,
      [],
    );
    // adj-top без clamp: x=310, y=116 → после clamp: x=234, y=116 (parent.y+16=116)
    expect(candidates[0]).toMatchObject({ label: "adj-top", x: 234, y: 116 });
  });

  test("no-op кандидат отбрасывается", () => {
    // move и partner расположены так, что cross-align совпадает с текущей позицией move
    // cross-align для "v": x = partner.x + partner.w/2 - move.w/2, y = move.y
    // Нужно чтобы x = move.x = 100: partner.x + partner.w/2 - move.w/2 = 100
    // partner.x = 100 + 50 - 60 = 90, partner.w = 120 → check: 90+60-50=100 ✓
    // move.y = 200 → cross-align: x=100, y=200 = move → отбрасывается
    const moveNoOp = leaf("A", 100, 200, 100, 40);
    const partnerNoOp = leaf("B", 90, 180, 120, 60);
    const candidates = genShiftCandidates(
      moveNoOp,
      partnerNoOp,
      null,
      true,
      [],
    );
    // cross-align даёт x=90+60-50=100, y=200 — совпадает с move → отброшен
    // остальные 4 кандидата должны присутствовать
    const labels = candidates.map((c) => c.label);
    expect(labels).not.toContain("cross-align");
    expect(candidates).toHaveLength(4);
  });
});

// ─── genShiftCandidates: lane-кандидаты (DRW-246) ──────────────────────────────

describe("genShiftCandidates lane-кандидаты", () => {
  function laneOf(
    candidates: ReadonlyArray<ShiftCandidate>,
    label: "lane-after" | "lane-before",
  ): ShiftCandidate | undefined {
    return candidates.find((c) => c.label === label);
  }

  test("(а) горизонтальный коридор с препятствием → lane-after/lane-before с точными координатами", () => {
    // move A: cx=40, cy=120; partner B: cx=540, cy=120 → ось "h" (|Δcx|=500 >= |Δcy|=0), уворот по y.
    // c0=40, c1=540. OBS: x=[200..280] пересекает [40..540], y=[80..200].
    const move = leaf("A", 0, 100, 80, 40);
    const partner = leaf("B", 500, 100, 80, 40);
    const obs = leaf("OBS", 200, 80, 80, 120);
    const candidates = genShiftCandidates(move, partner, null, false, [
      move,
      partner,
      obs,
    ]);

    const after = laneOf(candidates, "lane-after");
    const before = laneOf(candidates, "lane-before");
    expect(after).toBeDefined();
    expect(before).toBeDefined();
    // lane-after: y = bottom(OBS)=200 + gap(24) = 224; x прежний = move.x = 0.
    expect(after).toMatchObject({ label: "lane-after", x: 0, y: 224 });
    // lane-before: y = top(OBS)=80 - gap(24) - move.h(40) = 16; x прежний = 0.
    expect(before).toMatchObject({ label: "lane-before", x: 0, y: 16 });
  });

  test("(б) предки move/partner и сами концы не считаются препятствиями → lane не генерятся", () => {
    // P — контейнер-родитель move, лежит в коридоре. Других боксов нет → препятствий нет.
    const parent = container("P", -50, 50, 700, 200);
    const move = leaf("A", 0, 100, 80, 40, "P");
    const partner = leaf("B", 500, 100, 80, 40);
    const candidates = genShiftCandidates(move, partner, parent, false, [
      parent,
      move,
      partner,
    ]);
    const labels = candidates.map((c) => c.label);
    expect(labels).not.toContain("lane-after");
    expect(labels).not.toContain("lane-before");
  });

  test("(в) lane-after НЕ клампится в parent (y ниже parent.y+parent.h)", () => {
    // Маленький parent: y=100, h=40 → нижняя кромка 140. lane-after.y=224 > 140 → НЕ зажат.
    const parent = container("P", -20, 100, 720, 40);
    const move = leaf("A", 0, 100, 80, 40, "P");
    const partner = leaf("B", 500, 100, 80, 40);
    const obs = leaf("OBS", 200, 80, 80, 120);
    const candidates = genShiftCandidates(move, partner, parent, false, [
      parent,
      move,
      partner,
      obs,
    ]);
    const after = laneOf(candidates, "lane-after");
    expect(after).toBeDefined();
    expect(after?.y).toBe(224); // ниже parent.y+parent.h = 140, clamp НЕ применён
  });

  test("(г) вертикальный коридор → симметрия: уворот по x", () => {
    // move A: cx=120, cy=40; partner B: cx=120, cy=540 → ось "v" (|Δcy|=500 > |Δcx|=0), уворот по x.
    // c0=40, c1=540 (по y). OBS: y=[200..280] пересекает [40..540], x=[80..200].
    const move = leaf("A", 100, 0, 40, 80);
    const partner = leaf("B", 100, 500, 40, 80);
    const obs = leaf("OBS", 80, 200, 120, 80);
    const candidates = genShiftCandidates(move, partner, null, false, [
      move,
      partner,
      obs,
    ]);
    const after = laneOf(candidates, "lane-after");
    const before = laneOf(candidates, "lane-before");
    expect(after).toBeDefined();
    expect(before).toBeDefined();
    // lane-after: x = right(OBS)=200 + gap(24) = 224; y прежний = move.y = 0.
    expect(after).toMatchObject({ label: "lane-after", x: 224, y: 0 });
    // lane-before: x = left(OBS)=80 - gap(24) - move.w(40) = 16; y прежний = 0.
    expect(before).toMatchObject({ label: "lane-before", x: 16, y: 0 });
  });

  test("(д) бокс вне полосы коридора по оси уворота НЕ препятствие", () => {
    // Коридор A→B горизонтальный, концы на y=[100..140]; полоса = [100,140].
    // FAR в том же x-диапазоне, но y=[400..480] — далеко ниже полосы (отдельная
    // цепочка). OBS на полосе (y=[80..200]). Уворот должен считать только OBS:
    // lane-after.y = bottom(OBS)=200+gap=224, а НЕ bottom(FAR)=480+gap (live-фикс).
    const move = leaf("A", 0, 100, 80, 40);
    const partner = leaf("B", 500, 100, 80, 40);
    const obs = leaf("OBS", 200, 80, 80, 120);
    const far = leaf("FAR", 220, 400, 80, 80);
    const candidates = genShiftCandidates(move, partner, null, false, [
      move,
      partner,
      obs,
      far,
    ]);
    const after = laneOf(candidates, "lane-after");
    expect(after).toMatchObject({ label: "lane-after", x: 0, y: 224 });
  });
});

// ─── evaluateShift ────────────────────────────────────────────────────────────

describe("evaluateShift", () => {
  /**
   * Геометрия: A (movable) слева, OBSTACLE посередине, B справа.
   * Базовый маршрут eAB проходит НАСКВОЗЬ через OBSTACLE → foreign crossing → score = 1.
   * После сдвига A вниз, маршрут огибает obstacle сверху/снизу → foreign = 0, score = 0.
   *
   * Layout:
   *   A:        x=0,   y=100, w=80, h=40   (cx=40, cy=120)
   *   OBSTACLE: x=200, y=100, w=80, h=40   (cx=240, cy=120)
   *   B:        x=500, y=100, w=80, h=40   (cx=540, cy=120)
   *   EXTRA:    x=700, y=100, w=80, h=40   (для второго ребра)
   */
  const boxA = leaf("A", 0, 100, 80, 40);
  const boxObs = leaf("OBS", 200, 100, 80, 40);
  const boxB = leaf("B", 500, 100, 80, 40);
  const boxExtra = leaf("EXTRA", 700, 100, 80, 40);
  const boxes = [boxA, boxObs, boxB, boxExtra];

  // Ребро A→B (target)
  const edgeAB = edge("eAB", "A", "B");
  // Второе ребро (для проверки суммарного score)
  const edgeBE = edge("eBE", "B", "EXTRA");
  const edges = [edgeAB, edgeBE];

  // «Плохой» базовый маршрут eAB: прямая через OBSTACLE (1 сегмент → straight)
  // y=120 попадает в interior OBSTACLE (y=100..140) → foreign crossing!
  function makeBadRoute(a: RouteBox, b: RouteBox): Polyline {
    return [
      [a.x + a.w, a.y + a.h / 2],
      [b.x, b.y + b.h / 2],
    ] as Polyline;
  }

  // «Хороший» маршрут eAB: L-образный (3 точки, 2 сегмента), обходит OBSTACLE снизу
  // Выходим справа от a (x=a.x+a.w), горизонт вправо до x=b.x, затем вверх/вниз до b.
  // При a.y=300: [80,320] → [500,320] → [500,120] → plan.kind="L", нет foreign.
  function makeGoodRoute(a: RouteBox, b: RouteBox): Polyline {
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    return [
      [x1, y1],
      [x2, y1],
      [x2, y2],
    ] as Polyline;
  }

  // Простой L без препятствий (нейтральный маршрут для второго ребра)
  function makeSafeL(src: RouteBox, dst: RouteBox): Polyline {
    const x1 = src.x + src.w;
    const y1 = src.y + src.h / 2;
    const x2 = dst.x;
    const y2 = dst.y + dst.h / 2;
    return [
      [x1, y1],
      [x2, y1],
      [x2, y2],
    ] as Polyline;
  }

  // Вычисляем базовый currentScore для eAB (плохой маршрут через OBSTACLE)
  const byId = buildBoxIndex(boxes);
  const badRouteAB = makeBadRoute(boxA, boxB);
  const safeRouteBE = makeSafeL(boxB, boxExtra);
  const baseRoutes = new Map([
    ["eAB", badRouteAB],
    ["eBE", safeRouteBE],
  ]);

  function calcScore(
    pts: Polyline,
    e: RouteEdge,
    bxs: ReadonlyArray<RouteBox>,
    bId: ReadonlyMap<string, RouteBox>,
    routes: ReadonlyMap<string, Polyline>,
  ): number {
    const foreign = foreignCrossings(pts, e, bxs, bId).length;
    let edgeCross = 0;
    for (const [otherId, other] of routes) {
      if (otherId === e.id) continue;
      edgeCross += countPolylineCrossings(pts, other);
    }
    const length = polylineLength(pts);
    const srcBox = bId.get(e.from);
    const dstBox = bId.get(e.to);
    const crossFlow =
      srcBox && dstBox ? countCrossFlowTerminals(pts, srcBox, dstBox) : 0;
    return routeScore({ foreign, edgeCross, length, crossFlow });
  }

  const currentScore = calcScore(badRouteAB, edgeAB, boxes, byId, baseRoutes);
  // currentScore должен быть 1 (foreign crossing через OBSTACLE)

  test("принятие: хороший маршрут без foreign crossing → возвращает кандидата", () => {
    // Сдвигаем A вниз на y=300: маршрут больше не проходит через OBSTACLE
    const candidate: ShiftCandidate = {
      moveId: "A",
      x: 0,
      y: 300,
      label: "adj-bottom",
    };

    function routeFn(
      bxs: ReadonlyArray<RouteBox>,
      _edges: ReadonlyArray<RouteEdge>,
    ): ReadonlyMap<string, Polyline> {
      const a = findBox(bxs, "A");
      const bBox = findBox(bxs, "B");
      const extra = findBox(bxs, "EXTRA");
      const isShifted = a.y === 300;
      const routeAB = isShifted
        ? makeGoodRoute(a, bBox)
        : makeBadRoute(a, bBox);
      return new Map([
        ["eAB", routeAB],
        ["eBE", makeSafeL(bBox, extra)],
      ]);
    }

    const target: ShiftTarget = {
      edge: edgeAB,
      planKind: "U",
      currentScore,
      currentIsArc: false,
    };
    const result = evaluateShift(target, [candidate], boxes, edges, routeFn);
    expect(result).not.toBeNull();
    expect(result?.candidate.label).toBe("adj-bottom");
    expect(result?.newScore).toBe(0);
  });

  test("отказ: routeFn возвращает U-план для кандидата → skip", () => {
    // routeFn всегда возвращает «плохой» маршрут (straight через OBSTACLE)
    // planTransfer для прямой (2 точки, 1 сегмент) → "straight" — это допустимо
    // Нужно вернуть настоящий U-маршрут (4 точки, srcSide === dstSide)
    const candidate: ShiftCandidate = {
      moveId: "A",
      x: 0,
      y: 300,
      label: "adj-bottom",
    };

    function routeFn(
      bxs: ReadonlyArray<RouteBox>,
      _edges: ReadonlyArray<RouteEdge>,
    ): ReadonlyMap<string, Polyline> {
      const a = findBox(bxs, "A");
      const bBox = findBox(bxs, "B");
      const extra = findBox(bxs, "EXTRA");
      // U-маршрут: выходим слева от a, обходим слева → входим слева в b (srcSide=L, dstSide=L → U)
      const x1 = a.x;
      const y1 = a.y + a.h / 2;
      const x2 = bBox.x;
      const y2 = bBox.y + bBox.h / 2;
      const xLeft = Math.min(x1, x2) - 60;
      const uRoute: Polyline = [
        [x1, y1],
        [xLeft, y1],
        [xLeft, y2],
        [x2, y2],
      ];
      return new Map([
        ["eAB", uRoute],
        ["eBE", makeSafeL(bBox, extra)],
      ]);
    }

    const target: ShiftTarget = {
      edge: edgeAB,
      planKind: "U",
      currentScore: 999,
      currentIsArc: false,
    };
    const result = evaluateShift(target, [candidate], boxes, edges, routeFn);
    expect(result).toBeNull();
  });

  test("отказ: кандидат вызывает overlap с OBSTACLE → skip", () => {
    // A сдвигается прямо на позицию OBSTACLE → overlap
    const candidate: ShiftCandidate = {
      moveId: "A",
      x: 200, // = boxObs.x
      y: 100, // = boxObs.y
      label: "adj-right",
    };

    function routeFn(
      bxs: ReadonlyArray<RouteBox>,
      _edges: ReadonlyArray<RouteEdge>,
    ): ReadonlyMap<string, Polyline> {
      const a = findBox(bxs, "A");
      const bBox = findBox(bxs, "B");
      const extra = findBox(bxs, "EXTRA");
      return new Map([
        ["eAB", makeSafeL(a, bBox)],
        ["eBE", makeSafeL(bBox, extra)],
      ]);
    }

    const target: ShiftTarget = {
      edge: edgeAB,
      planKind: "U",
      currentScore: 999,
      currentIsArc: false,
    };
    const result = evaluateShift(target, [candidate], boxes, edges, routeFn);
    expect(result).toBeNull();
  });

  test("отказ: суммарный score вырос (eBE ухудшился) → skip", () => {
    /**
     * Добавляем OBS3 (x=350, y=30) и OBS4 (x=450, y=30) — на уровне y=30..70.
     *
     * Базовый:
     *   eAB = badRoute через OBS (y=120) → score=1
     *   eBE = safeBE(y=200) → score=0  (мимо всех obstacle)
     *   baseTotal = 1
     *
     * После сдвига A на y=300:
     *   eAB = goodRoute([[80,320],[500,320],[500,120]]) → score=0 (нет fc)
     *   eBE = badBE([[580,50],[200,50]]) → через OBS3 и OBS4 → fc=2 → score=2
     *   total2 = 2 > 1 + 1e-6 → SKIP
     */
    const boxObs3 = leaf("OBS3", 350, 30, 80, 40);
    const boxObs4 = leaf("OBS4", 450, 30, 40, 40);
    const extBoxes = [...boxes, boxObs3, boxObs4];
    const extEdges = [...edges];

    const candidate: ShiftCandidate = {
      moveId: "A",
      x: 0,
      y: 300,
      label: "adj-bottom",
    };

    function routeFn(
      bxs: ReadonlyArray<RouteBox>,
      _edges: ReadonlyArray<RouteEdge>,
    ): ReadonlyMap<string, Polyline> {
      const a = findBox(bxs, "A");
      const bBox = findBox(bxs, "B");
      const extra = findBox(bxs, "EXTRA");
      const isShifted = a.y === 300;
      const routeAB = isShifted
        ? makeGoodRoute(a, bBox)
        : makeBadRoute(a, bBox);
      // Исходный eBE: y=200 (мимо всего); после сдвига: y=50 через OBS3+OBS4 → fc=2
      const routeBE: Polyline = isShifted
        ? [
            [bBox.x + bBox.w, 50],
            [200, 50],
          ]
        : [
            [bBox.x + bBox.w, 200],
            [extra.x, 200],
          ];
      return new Map([
        ["eAB", routeAB],
        ["eBE", routeBE],
      ]);
    }

    const target: ShiftTarget = {
      edge: edgeAB,
      planKind: "U",
      currentScore,
      currentIsArc: false,
    };
    const result = evaluateShift(
      target,
      [candidate],
      extBoxes,
      extEdges,
      routeFn,
    );
    // total2 = 0(eAB) + 2(eBE через OBS3+OBS4) = 2 > baseTotal = 1 → null
    expect(result).toBeNull();
  });

  test("выбор лучшего из двух кандидатов: меньший суммарный score побеждает", () => {
    // candidateNear: A сдвигается на y=300 → хороший маршрут (нет foreign)
    // candidateFar:  A сдвигается на y=400 → тоже нет foreign, но длиннее
    const candidateNear: ShiftCandidate = {
      moveId: "A",
      x: 0,
      y: 300,
      label: "adj-bottom",
    };
    const candidateFar: ShiftCandidate = {
      moveId: "A",
      x: 0,
      y: 400,
      label: "adj-left",
    };

    function routeFn(
      bxs: ReadonlyArray<RouteBox>,
      _edges: ReadonlyArray<RouteEdge>,
    ): ReadonlyMap<string, Polyline> {
      const a = findBox(bxs, "A");
      const bBox = findBox(bxs, "B");
      const extra = findBox(bxs, "EXTRA");
      let routeAB: Polyline;
      if (a.y === 300) {
        routeAB = makeGoodRoute(a, bBox); // shorter bypass
      } else if (a.y === 400) {
        // Более длинный обход: y=500 вместо y=200
        routeAB = [
          [a.x + a.w, a.y + a.h / 2],
          [a.x + a.w, 500],
          [bBox.x, 500],
          [bBox.x, bBox.y + bBox.h / 2],
        ];
      } else {
        routeAB = makeBadRoute(a, bBox);
      }
      return new Map([
        ["eAB", routeAB],
        ["eBE", makeSafeL(bBox, extra)],
      ]);
    }

    const target: ShiftTarget = {
      edge: edgeAB,
      planKind: "U",
      currentScore,
      currentIsArc: false,
    };
    const result = evaluateShift(
      target,
      [candidateNear, candidateFar],
      boxes,
      edges,
      routeFn,
    );
    expect(result).not.toBeNull();
    // candidateNear даёт более короткий маршрут → должен победить
    expect(result?.candidate.label).toBe("adj-bottom");
  });

  // DRW-246 live-фикс: при равном score arc-цель ПРИНИМАЕТ сдвиг (дуга —
  // паллиатив, явный elbow предпочтительнее), inexpressible — отклоняет.
  test("arc-цель: newScore == currentScore → кандидат ПРИНЯТ", () => {
    // Сдвиг A вниз даёт хороший маршрут со score 0; current arc-score тоже 0.
    const candidate: ShiftCandidate = {
      moveId: "A",
      x: 0,
      y: 300,
      label: "adj-bottom",
    };

    function routeFn(
      bxs: ReadonlyArray<RouteBox>,
      _edges: ReadonlyArray<RouteEdge>,
    ): ReadonlyMap<string, Polyline> {
      const a = findBox(bxs, "A");
      const bBox = findBox(bxs, "B");
      const extra = findBox(bxs, "EXTRA");
      // Даже базовый (несдвинутый) маршрут «хороший» → score 0 = currentScore.
      return new Map([
        ["eAB", makeGoodRoute(a, bBox)],
        ["eBE", makeSafeL(bBox, extra)],
      ]);
    }

    const target: ShiftTarget = {
      edge: edgeAB,
      planKind: "U",
      currentScore: 0,
      currentIsArc: true,
    };
    const result = evaluateShift(target, [candidate], boxes, edges, routeFn);
    expect(result).not.toBeNull();
    expect(result?.candidate.label).toBe("adj-bottom");
    expect(result?.newScore).toBe(0);
  });

  test("inexpressible-цель: newScore == currentScore → кандидат ОТКЛОНЁН", () => {
    // Та же геометрия, но currentIsArc=false → строгий гейт `<` → равный score не проходит.
    const candidate: ShiftCandidate = {
      moveId: "A",
      x: 0,
      y: 300,
      label: "adj-bottom",
    };

    function routeFn(
      bxs: ReadonlyArray<RouteBox>,
      _edges: ReadonlyArray<RouteEdge>,
    ): ReadonlyMap<string, Polyline> {
      const a = findBox(bxs, "A");
      const bBox = findBox(bxs, "B");
      const extra = findBox(bxs, "EXTRA");
      return new Map([
        ["eAB", makeGoodRoute(a, bBox)],
        ["eBE", makeSafeL(bBox, extra)],
      ]);
    }

    const target: ShiftTarget = {
      edge: edgeAB,
      planKind: "U",
      currentScore: 0,
      currentIsArc: false,
    };
    const result = evaluateShift(target, [candidate], boxes, edges, routeFn);
    expect(result).toBeNull();
  });

  // DRW-246 live-фикс: lane-кандидат уворачивает A под полосу OBSTACLE — U-цель
  // превращается в выразимый L и принимается.
  test("lane-кандидат: U-цель становится L и ПРИНЯТА", () => {
    // Коридор A→B горизонтальный (A.cx=40, B.cx=540); OBS x=[200..280] в коридоре,
    // y=[100..140] → lane-after.y = bottom(OBS)=140 + gap(24) = 164, x = A.x = 0.
    const laneCands = genShiftCandidates(boxA, boxB, null, false, boxes);
    const laneAfter = laneCands.find((c) => c.label === "lane-after");
    expect(laneAfter).toBeDefined();
    expect(laneAfter).toMatchObject({ moveId: "A", x: 0, y: 164 });

    function routeFn(
      bxs: ReadonlyArray<RouteBox>,
      _edges: ReadonlyArray<RouteEdge>,
    ): ReadonlyMap<string, Polyline> {
      const a = findBox(bxs, "A");
      const bBox = findBox(bxs, "B");
      const extra = findBox(bxs, "EXTRA");
      const isShifted = a.y === 164;
      // База — U-маршрут (srcSide=L, dstSide=L); сдвиг → хороший L (score 0).
      let routeAB: Polyline;
      if (isShifted) {
        routeAB = makeGoodRoute(a, bBox);
      } else {
        const x1 = a.x;
        const y1 = a.y + a.h / 2;
        const x2 = bBox.x;
        const y2 = bBox.y + bBox.h / 2;
        const xLeft = Math.min(x1, x2) - 60;
        routeAB = [
          [x1, y1],
          [xLeft, y1],
          [xLeft, y2],
          [x2, y2],
        ];
      }
      return new Map([
        ["eAB", routeAB],
        ["eBE", makeSafeL(bBox, extra)],
      ]);
    }

    const target: ShiftTarget = {
      edge: edgeAB,
      planKind: "U",
      // U-маршрут невыразим elbow'ом → score 1 (есть foreign через OBSTACLE).
      currentScore,
      currentIsArc: false,
    };
    // laneAfter гарантированно определён (проверено выше).
    const result = evaluateShift(
      target,
      [laneAfter as ShiftCandidate],
      boxes,
      edges,
      routeFn,
    );
    expect(result).not.toBeNull();
    expect(result?.candidate.label).toBe("lane-after");
    expect(result?.newScore).toBe(0);
  });
});
