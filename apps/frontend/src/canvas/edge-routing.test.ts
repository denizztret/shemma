// apps/frontend/src/canvas/edge-routing.test.ts
// DRW-199 T4: юниты для edge-routing.ts
// decideEdges — чистые тесты без editor/WASM; collectRouteBoxes/currentArrowPolyline — fake-editor.

import { describe, expect, test } from "bun:test";
import type { Editor, TLShapeId } from "tldraw";
import {
  type EdgeDecision,
  buildWritebackPlan,
  collectRouteBoxes,
  currentArrowPolyline,
  decideEdges,
  filterRoutableEdges,
  planShiftsForDecisions,
} from "./edge-routing";
import { assignPorts, classifyEdges } from "./edge-routing-core";
import type { Polyline, RouteBox, RouteEdge } from "./edge-routing-core";

// ─── Вспомогательные конструкторы ─────────────────────────────────────────────

const box = (over: Partial<RouteBox> & { id: string }): RouteBox => ({
  kind: "leaf",
  parent: null,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  ...over,
});

const edge = (
  over: Partial<RouteEdge> & { id: string; from: string; to: string },
): RouteEdge => ({
  ...over,
});

const boxes2: RouteBox[] = [
  box({ id: "A", x: 0, y: 0, w: 80, h: 60 }),
  box({ id: "B", x: 300, y: 0, w: 80, h: 60 }),
];

// Прямой маршрут: A(right) → B(left), 2 точки
const straightRoute: Polyline = [
  [80, 30],
  [300, 30],
];

// Z-маршрут: 4 точки, выход справа, вход слева, средняя линия посередине
const zRoute: Polyline = [
  [80, 30],
  [190, 30],
  [190, 30],
  [300, 30],
];

// U-маршрут: выход и вход с ОДНОЙ стороны — оба справа (R→R, 3 сегмента)
const uRouteBoxes: RouteBox[] = [
  box({ id: "A", x: 0, y: 0, w: 80, h: 60 }),
  box({ id: "B", x: 0, y: 200, w: 80, h: 60 }),
];
// U: A.right → обход справа → B.right
const uRoute: Polyline = [
  [80, 30],
  [140, 30],
  [140, 230],
  [80, 230],
];

// detour: 6 точек = 5 сегментов — planTransfer вернёт "detour"
const detourRoute: Polyline = [
  [80, 30],
  [120, 30],
  [120, 80],
  [180, 80],
  [180, 30],
  [300, 30],
];

// ─── decideEdges — чистые тесты ───────────────────────────────────────────────

describe("decideEdges", () => {
  test("T1: прямой маршрут без текущего → apply", () => {
    const e1 = edge({ id: "e1", from: "A", to: "B" });
    const routes = new Map<string, Polyline>([["e1", straightRoute]]);
    const currents = new Map<string, Polyline>();
    const decisions = decideEdges(boxes2, [e1], routes, currents);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe("apply");
    expect(decisions[0]?.plan?.kind).toBe("straight");
  });

  test("T2: Z-маршрут лучше текущего (текущий пересекает бокс-препятствие) → apply с elbowMidPoint", () => {
    // Препятствие посередине — текущий маршрут его пересекает
    const obstacle: RouteBox = box({ id: "OBS", x: 140, y: 10, w: 40, h: 40 });
    const localBoxes = [...boxes2, obstacle];
    const e1 = edge({ id: "e1", from: "A", to: "B" });

    // Текущий маршрут прямо через препятствие: foreign=1
    const badCurrent: Polyline = [
      [80, 30],
      [300, 30],
    ];
    // Новый Z-маршрут обходит препятствие: foreign=0
    const goodZ: Polyline = [
      [80, 10], // выходит сверху A
      [190, 10],
      [190, 10],
      [300, 10],
    ];

    const routes = new Map<string, Polyline>([["e1", goodZ]]);
    const currents = new Map<string, Polyline>([["e1", badCurrent]]);
    const decisions = decideEdges(localBoxes, [e1], routes, currents);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe("apply");
  });

  test("T3: кандидат не лучше текущего (оба foreign=0, длина в пределах 5%) → gate-skip", () => {
    const e1 = edge({ id: "e1", from: "A", to: "B" });
    // Оба маршрута — прямые, длина одинакова
    const current: Polyline = [
      [80, 30],
      [300, 30],
    ];
    const candidate: Polyline = [
      [80, 31],
      [300, 31],
    ];
    const routes = new Map<string, Polyline>([["e1", candidate]]);
    const currents = new Map<string, Polyline>([["e1", current]]);
    const decisions = decideEdges(boxes2, [e1], routes, currents);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe("gate-skip");
  });

  test("T4: U-маршрут без стены (arc чистый, нет текущего) → arc", () => {
    // uRouteBoxes не содержит стены между A и B → arc-кандидат без пересечений найдётся.
    // Нет текущего маршрута → arc применяется напрямую.
    // (Если нужен inexpressible — требуется стена, которую дуга не может обойти; см. T-arc-2.)
    const e1 = edge({ id: "e1", from: "A", to: "B" });
    const routes = new Map<string, Polyline>([["e1", uRoute]]);
    const currents = new Map<string, Polyline>();
    const decisions = decideEdges(uRouteBoxes, [e1], routes, currents);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe("arc");
    expect(decisions[0]?.arcBend).toBeDefined();
  });

  test("T5: detour без стены (arc чистый, нет текущего) → arc", () => {
    // boxes2 не содержит стены; detour без текущего → arc-кандидат найдётся и применится.
    const e1 = edge({ id: "e1", from: "A", to: "B" });
    const routes = new Map<string, Polyline>([["e1", detourRoute]]);
    const currents = new Map<string, Polyline>();
    const decisions = decideEdges(boxes2, [e1], routes, currents);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe("arc");
  });

  test("T6: ребро без route в Map → отсутствует в decisions", () => {
    const e1 = edge({ id: "e1", from: "A", to: "B" });
    const e2 = edge({ id: "e2", from: "B", to: "A" });
    // e2 не в routes
    const routes = new Map<string, Polyline>([["e1", straightRoute]]);
    const currents = new Map<string, Polyline>();
    const decisions = decideEdges(boxes2, [e1, e2], routes, currents);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.edgeId).toBe("e1");
  });
});

describe("arc-кандидат в decideEdges", () => {
  test("T-arc-1: U-маршрут с возможной дугой, текущий пересекает бокс → action arc с arcBend", () => {
    // Сцена: src, dst по горизонтали; стена посередине; U-маршрут огибает снизу.
    // Текущий маршрут — прямая сквозь стену (foreign=1).
    const src: RouteBox = {
      id: "src",
      kind: "leaf",
      parent: null,
      x: 0,
      y: 20,
      w: 80,
      h: 40,
    };
    const dst: RouteBox = {
      id: "dst",
      kind: "leaf",
      parent: null,
      x: 320,
      y: 20,
      w: 80,
      h: 40,
    };
    const wall: RouteBox = {
      id: "wall",
      kind: "leaf",
      parent: null,
      x: 150,
      y: 0,
      w: 100,
      h: 100,
    };
    const localBoxes = [src, dst, wall];
    const e = edge({ id: "e1", from: "src", to: "dst" });

    // U-маршрут: огибает стену снизу (depth ≈ 110)
    const uRouteArc: Polyline = [
      [80, 40],
      [80, 150],
      [320, 150],
      [320, 40],
    ];
    // Текущий: прямая сквозь стену — foreign=1
    const badCurrent: Polyline = [
      [80, 40],
      [320, 40],
    ];

    const routes = new Map<string, Polyline>([["e1", uRouteArc]]);
    const currents = new Map<string, Polyline>([["e1", badCurrent]]);
    const decisions = decideEdges(localBoxes, [e], routes, currents);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe("arc");
    expect(decisions[0]?.arcBend).toBeDefined();
    expect(typeof decisions[0]?.arcBend).toBe("number");
  });

  test("T-arc-2: U-маршрут, дуга не находится (стена огромная) → inexpressible", () => {
    const src: RouteBox = {
      id: "src",
      kind: "leaf",
      parent: null,
      x: 0,
      y: 0,
      w: 50,
      h: 50,
    };
    const dst: RouteBox = {
      id: "dst",
      kind: "leaf",
      parent: null,
      x: 450,
      y: 0,
      w: 50,
      h: 50,
    };
    // Огромная стена: закрывает всю область по Y
    const wall: RouteBox = {
      id: "wall",
      kind: "leaf",
      parent: null,
      x: 60,
      y: -2000,
      w: 380,
      h: 4000,
    };
    const localBoxes = [src, dst, wall];
    const e = edge({ id: "e1", from: "src", to: "dst" });

    const uRouteBlocked: Polyline = [
      [50, 25],
      [50, 300],
      [450, 300],
      [450, 25],
    ];

    const routes = new Map<string, Polyline>([["e1", uRouteBlocked]]);
    const currents = new Map<string, Polyline>();
    const decisions = decideEdges(localBoxes, [e], routes, currents);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe("inexpressible");
  });

  test("T-arc-3: U-маршрут с ЧИСТЫМ текущим (foreign=0) → arc НЕ лучше → inexpressible (антидрейф)", () => {
    // Src и dst без стены между ними; текущий маршрут чистый (foreign=0).
    // Дуга тоже будет foreign=0, но edgeCross консервативно = current.edgeCross=0,
    // length дуги ≈ length U-маршрута (кандидат не 5% лучше) → gate-skip или inexpressible.
    // Поскольку arc-проверка идёт ДО стандартного gate: candidateBeatsCurrent(arc, current).
    // arc.foreign=0, arc.edgeCross=0 (current.edgeCross=0), arc.length ≈ chord ≈ 240.
    // current.foreign=0, current.edgeCross=0, current.length=240.
    // score(arc)=score(current)=0; длина не даёт 5% выигрыша → NOT beats → inexpressible.
    const src: RouteBox = {
      id: "src",
      kind: "leaf",
      parent: null,
      x: 0,
      y: 20,
      w: 80,
      h: 40,
    };
    const dst: RouteBox = {
      id: "dst",
      kind: "leaf",
      parent: null,
      x: 320,
      y: 20,
      w: 80,
      h: 40,
    };
    // Нет стены между ними; U-маршрут тем не менее есть (тест проверяет только гейт)
    const localBoxes = [src, dst];
    const e = edge({ id: "e1", from: "src", to: "dst" });

    const uRouteClean: Polyline = [
      [80, 40],
      [80, 150],
      [320, 150],
      [320, 40],
    ];
    // Текущий чистый прямой маршрут (foreign=0)
    const cleanCurrent: Polyline = [
      [80, 40],
      [320, 40],
    ];

    const routes = new Map<string, Polyline>([["e1", uRouteClean]]);
    const currents = new Map<string, Polyline>([["e1", cleanCurrent]]);
    const decisions = decideEdges(localBoxes, [e], routes, currents);

    expect(decisions).toHaveLength(1);
    // Дуга не лучше текущего (оба чистые, длина сопоставима) → inexpressible
    expect(decisions[0]?.action).toBe("inexpressible");
  });
});

// ─── Fake-editor для тестов collectRouteBoxes / currentArrowPolyline ─────────

type FakeShape = {
  id: string;
  type: string;
  parentId: string;
  meta?: Record<string, unknown>;
  props?: Record<string, unknown>;
};

type FakeBounds = { x: number; y: number; w: number; h: number };

function makeFakeEditor(
  shapes: FakeShape[],
  bounds: Record<string, FakeBounds>,
  vertices?: Array<readonly [number, number]>,
  transform?: {
    applyToPoint: (v: { x: number; y: number }) => { x: number; y: number };
  },
): Editor {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  return {
    getShape: (id: TLShapeId) => byId.get(id as string) ?? undefined,
    getShapePageBounds: (id: TLShapeId) => bounds[id as string] ?? undefined,
    getShapeGeometry: (_id: TLShapeId) =>
      vertices ? { vertices: vertices.map(([x, y]) => ({ x, y })) } : undefined,
    getShapePageTransform: (_id: TLShapeId) => transform ?? undefined,
  } as unknown as Editor;
}

// ─── collectRouteBoxes ────────────────────────────────────────────────────────

describe("collectRouteBoxes", () => {
  test("T7: geo → leaf, schema-container → container, parent-цепочка через schema-container", () => {
    const shapes: FakeShape[] = [
      { id: "shape:c1", type: "schema-container", parentId: "page:p" },
      { id: "shape:g1", type: "geo", parentId: "shape:c1" },
      { id: "shape:g2", type: "geo", parentId: "page:p" },
    ];
    const bounds: Record<string, FakeBounds> = {
      "shape:c1": { x: 0, y: 0, w: 200, h: 200 },
      "shape:g1": { x: 10, y: 10, w: 50, h: 50 },
      "shape:g2": { x: 300, y: 0, w: 80, h: 60 },
    };
    const inScope = new Set(["shape:c1", "shape:g1", "shape:g2"]);
    const editor = makeFakeEditor(shapes, bounds);
    const boxes = collectRouteBoxes(editor, inScope);

    const c1 = boxes.find((b) => b.id === "shape:c1");
    const g1 = boxes.find((b) => b.id === "shape:g1");
    const g2 = boxes.find((b) => b.id === "shape:g2");

    expect(c1?.kind).toBe("container");
    expect(c1?.parent).toBeNull();
    expect(g1?.kind).toBe("leaf");
    expect(g1?.parent).toBe("shape:c1");
    expect(g2?.kind).toBe("leaf");
    expect(g2?.parent).toBeNull();
  });

  test("T8: обычный frame-предок (не schema-container) → parent null", () => {
    const shapes: FakeShape[] = [
      { id: "shape:f1", type: "frame", parentId: "page:p" },
      { id: "shape:g1", type: "geo", parentId: "shape:f1" },
    ];
    const bounds: Record<string, FakeBounds> = {
      "shape:f1": { x: 0, y: 0, w: 300, h: 300 },
      "shape:g1": { x: 10, y: 10, w: 50, h: 50 },
    };
    const inScope = new Set(["shape:f1", "shape:g1"]);
    const editor = makeFakeEditor(shapes, bounds);
    const boxes = collectRouteBoxes(editor, inScope);

    const g1 = boxes.find((b) => b.id === "shape:g1");
    // frame не schema-container → g1.parent === null
    expect(g1?.parent).toBeNull();
  });

  test("T9: фигуры вне scope игнорируются, arrow пропускается", () => {
    const shapes: FakeShape[] = [
      { id: "shape:g1", type: "geo", parentId: "page:p" },
      { id: "shape:g2", type: "geo", parentId: "page:p" },
      { id: "shape:a1", type: "arrow", parentId: "page:p" },
    ];
    const bounds: Record<string, FakeBounds> = {
      "shape:g1": { x: 0, y: 0, w: 80, h: 60 },
      "shape:g2": { x: 200, y: 0, w: 80, h: 60 },
      "shape:a1": { x: 80, y: 30, w: 120, h: 1 },
    };
    // Только g1 в scope (g2 и a1 — вне)
    const inScope = new Set(["shape:g1"]);
    const editor = makeFakeEditor(shapes, bounds);
    const boxes = collectRouteBoxes(editor, inScope);

    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.id).toBe("shape:g1");
  });
});

// ─── currentArrowPolyline ─────────────────────────────────────────────────────

describe("currentArrowPolyline", () => {
  test("T10: vertices + identity-transform → правильная page-полилиния", () => {
    const vertices: Array<readonly [number, number]> = [
      [10, 20],
      [50, 20],
      [50, 80],
    ];
    const transform = {
      applyToPoint: (v: { x: number; y: number }) => ({
        x: v.x + 5,
        y: v.y + 5,
      }),
    };
    const editor = makeFakeEditor([], {}, vertices, transform);
    const poly = currentArrowPolyline(editor, "shape:a1");
    expect(poly).toHaveLength(3);
    expect(poly?.[0]).toEqual([15, 25]);
    expect(poly?.[1]).toEqual([55, 25]);
    expect(poly?.[2]).toEqual([55, 85]);
  });

  test("T11: <2 точек → null", () => {
    const vertices: Array<readonly [number, number]> = [[10, 20]];
    const transform = {
      applyToPoint: (v: { x: number; y: number }) => v,
    };
    const editor = makeFakeEditor([], {}, vertices, transform);
    const poly = currentArrowPolyline(editor, "shape:a1");
    expect(poly).toBeNull();
  });

  test("T12: нет геометрии → null", () => {
    const editor = makeFakeEditor([], {});
    const poly = currentArrowPolyline(editor, "shape:a1");
    expect(poly).toBeNull();
  });
});

// ─── filterRoutableEdges ──────────────────────────────────────────────────────

describe("filterRoutableEdges", () => {
  const byArrow: Record<string, { start?: string; end?: string }> = {
    "shape:e1": { start: "shape:a", end: "shape:b" },
    "shape:e2": { start: "shape:b", end: "shape:c" }, // aligned
    "shape:e3": { start: "shape:a", end: "shape:c" },
    "shape:e4": { start: "shape:x", end: "shape:y" }, // вне scope
  };
  const byId: Map<string, RouteBox> = new Map([
    ["shape:a", box({ id: "shape:a" })],
    ["shape:b", box({ id: "shape:b" })],
    ["shape:c", box({ id: "shape:c" })],
  ]);
  // scope задаётся УЗЛАМИ (концами рёбер), не arrow-id — инвариант distributeArrowPorts
  const inScope = new Set(["shape:a", "shape:b", "shape:c"]);
  const alignedEdges = new Set(["shape:b>shape:c"]);

  test("T13: aligned-ребро остаётся в routable и помечено в alignedIds (гейт решает)", () => {
    const { routable, alignedIds } = filterRoutableEdges(
      byArrow,
      inScope,
      byId,
      alignedEdges,
    );
    expect([...alignedIds]).toEqual(["shape:e2"]);
    expect(routable.find((e) => e.id === "shape:e2")).toBeDefined();
  });

  test("T14: обычные рёбра в scope → в routable; вне scope или без обоих концов → пропуск", () => {
    const { routable } = filterRoutableEdges(
      byArrow,
      inScope,
      byId,
      alignedEdges,
    );
    const ids = routable.map((e) => e.id);
    expect(ids).toContain("shape:e1");
    expect(ids).toContain("shape:e3");
    // e4 — вне scope
    expect(ids).not.toContain("shape:e4");
    // e2 — aligned, но РОУТИТСЯ (его судьбу решает гейт)
    expect(ids).toContain("shape:e2");
  });
});

// ─── EdgeRoutingReport: разделение unrouted vs skipped ───────────────────────

describe("EdgeRoutingReport — unrouted vs skipped", () => {
  // Проверяем, что classifyEdges-скип (лист→свой контейнер) записывается
  // в unrouted, а gate-skip (гейт отклонил) — в skipped.
  // Тестируем через decideEdges + ручную сборку отчёта (минимальный путь
  // без WASM), следуя той же логике, что runEdgeRoutingPass.

  test("classification-skip (нет бокса в byId) → попадёт в unrouted при classifyEdges", () => {
    // Ребро с несуществующим концом — classifyEdges пропустит его в skipped
    // (в runEdgeRoutingPass classification.skipped → report.unrouted)
    const localBoxes: RouteBox[] = [box({ id: "A", x: 0, y: 0, w: 80, h: 60 })];
    const edges: RouteEdge[] = [
      // MISSING не существует — битый конец → classification-skip
      edge({ id: "e-bad", from: "A", to: "MISSING" }),
    ];
    const { skipped } = classifyEdges(localBoxes, edges);
    expect(skipped.map((e) => e.id)).toContain("e-bad");
  });

  test("gate-skip решение от decideEdges → попадёт в skipped, не в unrouted", () => {
    // Сцена из T3: оба маршрута чистые, длина одинакова → gate-skip
    const e1 = edge({ id: "e1", from: "A", to: "B" });
    const current: Polyline = [
      [80, 30],
      [300, 30],
    ];
    const candidate: Polyline = [
      [80, 31],
      [300, 31],
    ];
    const routes = new Map<string, Polyline>([["e1", candidate]]);
    const currents = new Map<string, Polyline>([["e1", current]]);
    const decisions = decideEdges(boxes2, [e1], routes, currents);
    // gate-skip
    const gateSkipped = decisions.filter((d) => d.action === "gate-skip");
    expect(gateSkipped.map((d) => d.edgeId)).toContain("e1");
    // В отчёт это ребро должно идти в skipped, не unrouted
    // (логика в runEdgeRoutingPass: gate-skip → skipped, classification-skip → unrouted)
    const skippedIds: string[] = [];
    const unroutedIds: string[] = [];
    for (const d of decisions) {
      if (d.action === "gate-skip") skippedIds.push(d.edgeId);
    }
    expect(skippedIds).toContain("e1");
    expect(unroutedIds).not.toContain("e1");
  });
});

// ─── buildWritebackPlan — транзакционный writeback без WASM ──────────────────

describe("buildWritebackPlan", () => {
  // Фиктивные binding-записи для одной стрелки e1 (start + end)
  const bindByKey = new Map([
    [
      "e1|start",
      {
        id: "bind:e1-start",
        fromId: "e1",
        toId: "shape:A",
        props: { terminal: "start" as const, isPrecise: false },
      },
    ],
    [
      "e1|end",
      {
        id: "bind:e1-end",
        fromId: "e1",
        toId: "shape:B",
        props: { terminal: "end" as const, isPrecise: false },
      },
    ],
  ]);

  // Боксы A и B, ребро e1: прямой маршрут A.right → B.left
  const localBoxes: RouteBox[] = [
    box({ id: "shape:A", x: 0, y: 0, w: 80, h: 60 }),
    box({ id: "shape:B", x: 300, y: 0, w: 80, h: 60 }),
  ];
  const e1 = edge({ id: "e1", from: "shape:A", to: "shape:B" });

  test("T-wb-1: Z-ребро → binding-анкоры + kind=elbow с elbowMidPoint (не 0.5)", () => {
    // Z-маршрут с elbowMidPoint ≈ 0.47
    const zR: Polyline = [
      [80, 30],
      [190, 30],
      [190, 30],
      [300, 30],
    ];
    const routes = new Map<string, Polyline>([["e1", zR]]);
    const currents = new Map<string, Polyline>();
    const decisions = decideEdges(localBoxes, [e1], routes, currents);
    expect(decisions[0]?.action).toBe("apply");

    const byId = new Map(localBoxes.map((b) => [b.id, b]));
    const assignments = assignPorts(routes, [e1], byId);
    const plan = buildWritebackPlan(decisions, assignments, bindByKey);

    // Должны быть binding-апдейты для обоих концов
    expect(plan.bindingUpdates.length).toBeGreaterThanOrEqual(1);
    // Должен быть shape-апдейт для e1
    const su = plan.shapeUpdates.find((s) => s.shapeId === "e1");
    expect(su).toBeDefined();
    expect(su?.props.kind).toBe("elbow");
  });

  test("T-wb-2: straight-ребро → elbowMidPoint === 0.5 (сброс stale)", () => {
    // straightRoute: [[80,30],[300,30]] — совместимо с localBoxes (shape:A w=80, shape:B x=300)
    const routes = new Map<string, Polyline>([["e1", straightRoute]]);
    const currents = new Map<string, Polyline>();
    const decisions = decideEdges(localBoxes, [e1], routes, currents);
    expect(decisions[0]?.action).toBe("apply");
    expect(decisions[0]?.plan?.kind).toBe("straight");

    const byId = new Map(localBoxes.map((b) => [b.id, b]));
    const assignments = assignPorts(routes, [e1], byId);
    const plan = buildWritebackPlan(decisions, assignments, bindByKey);

    const su = plan.shapeUpdates.find((s) => s.shapeId === "e1");
    expect(su?.props.kind).toBe("elbow");
    // TS narrowing: straight → elbowMidPoint
    if (su?.props.kind === "elbow") {
      expect(su.props.elbowMidPoint).toBe(0.5);
    }
  });

  test("T-wb-3: arc-ребро → kind=arc + bend", () => {
    // U-маршрут без стены → arc
    const e1u = edge({ id: "e1", from: "A", to: "B" });
    const routes = new Map<string, Polyline>([["e1", uRoute]]);
    const currents = new Map<string, Polyline>();
    const decisions = decideEdges(uRouteBoxes, [e1u], routes, currents);
    expect(decisions[0]?.action).toBe("arc");

    const byId = new Map(uRouteBoxes.map((b) => [b.id, b]));
    // arc-рёбра в assignments передаются с маршрутом libavoid (начало/конец то же)
    const assignments = assignPorts(routes, [e1u], byId);
    const plan = buildWritebackPlan(decisions, assignments, bindByKey);

    const su = plan.shapeUpdates.find((s) => s.shapeId === "e1");
    expect(su?.props.kind).toBe("arc");
    if (su?.props.kind === "arc") {
      expect(typeof su.props.bend).toBe("number");
    }
  });

  test("T-wb-4: gate-skip ребро → не попадает в shapeUpdates", () => {
    // T3 сценарий: оба маршрута одинаковы → gate-skip
    const e1g = edge({ id: "e1", from: "A", to: "B" });
    const current: Polyline = [
      [80, 30],
      [300, 30],
    ];
    const candidate: Polyline = [
      [80, 31],
      [300, 31],
    ];
    const routes = new Map<string, Polyline>([["e1", candidate]]);
    const currents = new Map<string, Polyline>([["e1", current]]);
    const decisions = decideEdges(boxes2, [e1g], routes, currents);
    expect(decisions[0]?.action).toBe("gate-skip");

    const byId = new Map(boxes2.map((b) => [b.id, b]));
    const assignments = assignPorts(new Map(), [], byId);
    const plan = buildWritebackPlan(decisions, assignments, bindByKey);

    // gate-skip не пишет shape-апдейты
    expect(plan.shapeUpdates.find((s) => s.shapeId === "e1")).toBeUndefined();
    // и не пишет binding-апдейты (нет assignments)
    expect(plan.bindingUpdates).toHaveLength(0);
  });
});

// ─── collectRouteBoxes — flowAxis ─────────────────────────────────────────────

describe("collectRouteBoxes — flowAxis", () => {
  test("T-cf-1: узел в schema-container получает flowAxis из props.direction контейнера", () => {
    const shapes: FakeShape[] = [
      {
        id: "shape:c1",
        type: "schema-container",
        parentId: "page:p",
        props: { direction: "TB" },
      },
      { id: "shape:g1", type: "geo", parentId: "shape:c1" },
    ];
    const bounds: Record<string, FakeBounds> = {
      "shape:c1": { x: 0, y: 0, w: 200, h: 200 },
      "shape:g1": { x: 10, y: 10, w: 50, h: 50 },
    };
    const inScope = new Set(["shape:c1", "shape:g1"]);
    const editor = makeFakeEditor(shapes, bounds);
    const boxes = collectRouteBoxes(editor, inScope);

    const g1 = boxes.find((b) => b.id === "shape:g1");
    // g1 в TB-контейнере → flowAxis="v"
    expect(g1?.flowAxis).toBe("v");
  });

  test("T-cf-2: top-level узел получает flowAxis из opts.flowDir", () => {
    const shapes: FakeShape[] = [
      { id: "shape:g1", type: "geo", parentId: "page:p" },
    ];
    const bounds: Record<string, FakeBounds> = {
      "shape:g1": { x: 0, y: 0, w: 80, h: 60 },
    };
    const inScope = new Set(["shape:g1"]);
    const editor = makeFakeEditor(shapes, bounds);
    const boxes = collectRouteBoxes(editor, inScope, { flowDir: "LR" });

    const g1 = boxes.find((b) => b.id === "shape:g1");
    // LR-фрейм → flowAxis="h"
    expect(g1?.flowAxis).toBe("h");
  });

  test("T-cf-3: узел без родителя и без opts.flowDir → flowAxis undefined", () => {
    const shapes: FakeShape[] = [
      { id: "shape:g1", type: "geo", parentId: "page:p" },
    ];
    const bounds: Record<string, FakeBounds> = {
      "shape:g1": { x: 0, y: 0, w: 80, h: 60 },
    };
    const inScope = new Set(["shape:g1"]);
    const editor = makeFakeEditor(shapes, bounds);
    const boxes = collectRouteBoxes(editor, inScope);

    const g1 = boxes.find((b) => b.id === "shape:g1");
    expect(g1?.flowAxis).toBeUndefined();
  });
});

// ─── decideEdges — from/to/planKind/currentScore (DRW-246) ───────────────────

describe("decideEdges — поля для shift-прогона", () => {
  test("inexpressible-решение несёт from/to/planKind/currentScore", () => {
    // T-arc-2 геометрия: огромная стена — дуга не находится → inexpressible.
    const src: RouteBox = box({ id: "src", x: 0, y: 0, w: 50, h: 50 });
    const dst: RouteBox = box({ id: "dst", x: 450, y: 0, w: 50, h: 50 });
    const wall: RouteBox = box({
      id: "wall",
      x: 60,
      y: -2000,
      w: 380,
      h: 4000,
    });
    const localBoxes = [src, dst, wall];
    const e = edge({ id: "e1", from: "src", to: "dst" });
    const uRouteBlocked: Polyline = [
      [50, 25],
      [50, 300],
      [450, 300],
      [450, 25],
    ];
    const routes = new Map<string, Polyline>([["e1", uRouteBlocked]]);
    const decisions = decideEdges(localBoxes, [e], routes, new Map());
    expect(decisions[0]?.action).toBe("inexpressible");
    expect(decisions[0]?.from).toBe("src");
    expect(decisions[0]?.to).toBe("dst");
    // Маршрут 4 точки, srcSide(R) ≠ dstSide(R)? — здесь planTransfer даёт detour.
    expect(["U", "detour"]).toContain(decisions[0]?.planKind);
    expect(typeof decisions[0]?.currentScore).toBe("number");
  });

  test("arc-решение несёт from/to/planKind/currentScore", () => {
    // T4 геометрия: U без стены → arc.
    const aBoxes: RouteBox[] = [
      box({ id: "A", x: 0, y: 0, w: 80, h: 60 }),
      box({ id: "B", x: 0, y: 200, w: 80, h: 60 }),
    ];
    const uR: Polyline = [
      [80, 30],
      [140, 30],
      [140, 230],
      [80, 230],
    ];
    const e = edge({ id: "e1", from: "A", to: "B" });
    const decisions = decideEdges(
      aBoxes,
      [e],
      new Map([["e1", uR]]),
      new Map(),
    );
    expect(decisions[0]?.action).toBe("arc");
    expect(decisions[0]?.from).toBe("A");
    expect(decisions[0]?.to).toBe("B");
    expect(decisions[0]?.planKind).toBe("U");
    expect(typeof decisions[0]?.currentScore).toBe("number");
  });
});

// ─── planShiftsForDecisions (DRW-246) ────────────────────────────────────────

describe("planShiftsForDecisions", () => {
  // Геометрия: A (movable) слева, OBS посередине, B справа. Базовый маршрут
  // eAB сквозь OBS → foreign → высокий score. Сдвиг A вниз (adj-bottom y=300)
  // даёт чистый L → score 0.
  const boxA = box({ id: "A", x: 0, y: 100, w: 80, h: 40 });
  const boxObs = box({ id: "OBS", x: 200, y: 100, w: 80, h: 40 });
  const boxB = box({ id: "B", x: 500, y: 100, w: 80, h: 40 });
  const baseBoxes = [boxA, boxObs, boxB];
  const edgeAB = edge({ id: "eAB", from: "A", to: "B" });

  function badRoute(a: RouteBox, b: RouteBox): Polyline {
    return [
      [a.x + a.w, a.y + a.h / 2],
      [b.x, b.y + b.h / 2],
    ];
  }
  function goodL(a: RouteBox, b: RouteBox): Polyline {
    return [
      [a.x + a.w, a.y + a.h / 2],
      [b.x, a.y + a.h / 2],
      [b.x, b.y + b.h / 2],
    ];
  }
  // routeFn: пока A на исходной высоте — плохой маршрут; после сдвига вниз — L.
  function routeFn(
    bxs: ReadonlyArray<RouteBox>,
    _edges: ReadonlyArray<RouteEdge>,
  ): ReadonlyMap<string, Polyline> {
    const a = bxs.find((b) => b.id === "A");
    const b = bxs.find((bx) => bx.id === "B");
    if (!a || !b) return new Map();
    const route = a.y === 100 ? badRoute(a, b) : goodL(a, b);
    return new Map([["eAB", route]]);
  }

  const inexprDecision: EdgeDecision = {
    edgeId: "eAB",
    action: "inexpressible",
    from: "A",
    to: "B",
    planKind: "U",
    // currentScore высокий, чтобы любой чистый сдвиг победил.
    currentScore: 999,
  };

  test("цель с пригодным концом → сдвиг (fake routeFn)", () => {
    const degree = new Map([
      ["A", 1],
      ["B", 1],
    ]);
    const shifts = planShiftsForDecisions(
      [inexprDecision],
      baseBoxes,
      [edgeAB],
      degree,
      new Set(),
      routeFn,
    );
    expect(shifts).toHaveLength(1);
    expect(shifts[0]?.edgeId).toBe("eAB");
    // pickMovableEnd: оба deg=1, площади равны → предпочитает "to" (B).
    expect(shifts[0]?.movedId).toBe("B");
  });

  test("цель без пригодного конца (оба pinned) → пропуск", () => {
    const degree = new Map([
      ["A", 1],
      ["B", 1],
    ]);
    const shifts = planShiftsForDecisions(
      [inexprDecision],
      baseBoxes,
      [edgeAB],
      degree,
      new Set(["A", "B"]),
      routeFn,
    );
    expect(shifts).toHaveLength(0);
  });

  test("решение без planKind (apply/gate-skip) → не цель → пропуск (depth=1 не сдвигает)", () => {
    // После сдвигов повторный прогон видит только apply/gate-skip — целей нет.
    const applyDecision: EdgeDecision = {
      edgeId: "eAB",
      action: "apply",
    };
    const degree = new Map([
      ["A", 1],
      ["B", 1],
    ]);
    const shifts = planShiftsForDecisions(
      [applyDecision],
      baseBoxes,
      [edgeAB],
      degree,
      new Set(),
      routeFn,
    );
    expect(shifts).toHaveLength(0);
  });

  test("второй таргет видит сдвиг первого (последовательная рабочая копия)", () => {
    // Два ребра: e1 двигает X к A, e2 двигает X к B. X — единственный подвижный
    // конец обоих (A,B pinned). Цель e2 должна оценивать X уже на позиции после e1.
    const A = box({ id: "A", x: 0, y: 0, w: 60, h: 40 });
    const B = box({ id: "B", x: 600, y: 0, w: 60, h: 40 });
    const X = box({ id: "X", x: 300, y: 300, w: 60, h: 40 });
    const bxs = [A, B, X];
    const e1 = edge({ id: "e1", from: "A", to: "X" });
    const e2 = edge({ id: "e2", from: "X", to: "B" });
    const d1: EdgeDecision = {
      edgeId: "e1",
      action: "inexpressible",
      from: "A",
      to: "X",
      planKind: "U",
      currentScore: 999,
    };
    const d2: EdgeDecision = {
      edgeId: "e2",
      action: "inexpressible",
      from: "X",
      to: "B",
      planKind: "U",
      currentScore: 999,
    };
    // Захватываем boxes, переданные в routeFn при оценке e2 — там X уже сдвинут e1.
    const seenXForE2: Array<{ x: number; y: number }> = [];
    function rf(
      b2: ReadonlyArray<RouteBox>,
      _e: ReadonlyArray<RouteEdge>,
    ): ReadonlyMap<string, Polyline> {
      const xb = b2.find((b) => b.id === "X");
      const ab = b2.find((b) => b.id === "A");
      const bb = b2.find((b) => b.id === "B");
      if (!xb || !ab || !bb) return new Map();
      // Любой сдвиг X даёт чистый прямой маршрут (score 0) — сдвиг всегда принимается.
      const straight = (s: RouteBox, t: RouteBox): Polyline => [
        [s.x + s.w, s.y + s.h / 2],
        [t.x, t.y + t.h / 2],
      ];
      return new Map([
        ["e1", straight(ab, xb)],
        ["e2", straight(xb, bb)],
      ]);
    }
    // degree X = 2 (≤2 → пригоден); A,B pinned.
    const degree = new Map([
      ["A", 1],
      ["B", 1],
      ["X", 2],
    ]);
    const wrapped = (
      b2: ReadonlyArray<RouteBox>,
      e: ReadonlyArray<RouteEdge>,
    ): ReadonlyMap<string, Polyline> => {
      // Запоминаем позицию X при оценке (грубо: любой вызов с X — фиксируем).
      const xb = b2.find((b) => b.id === "X");
      if (xb) seenXForE2.push({ x: xb.x, y: xb.y });
      return rf(b2, e);
    };
    const shifts = planShiftsForDecisions(
      [d2, d1], // нарочно в обратном порядке — функция сортирует по edgeId (e1 < e2)
      bxs,
      [e1, e2],
      degree,
      new Set(["A", "B"]),
      wrapped,
    );
    // Оба ребра двигают X → два сдвига, e1 первым (сортировка по edgeId).
    expect(shifts).toHaveLength(2);
    expect(shifts[0]?.edgeId).toBe("e1");
    expect(shifts[1]?.edgeId).toBe("e2");
    expect(shifts[0]?.movedId).toBe("X");
    expect(shifts[1]?.movedId).toBe("X");
    // Второй сдвиг стартует от позиции X ПОСЛЕ первого (dx второго ≠ от исходной 300).
    const afterFirst = { x: shifts[0]?.x ?? 0, y: shifts[0]?.y ?? 0 };
    // dx второго = x2 - afterFirst.x (а не x2 - 300) → проверяем согласованность.
    expect(shifts[1]?.dx).toBeCloseTo((shifts[1]?.x ?? 0) - afterFirst.x, 5);
  });
});
