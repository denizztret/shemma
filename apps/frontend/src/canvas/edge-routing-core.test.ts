import { describe, expect, test } from "bun:test";
import {
  type Polyline,
  type RouteBox,
  type RouteEdge,
  type RouteMetrics,
  ancestorsOf,
  anchorFor,
  assignPorts,
  axisOfDirection,
  buildBoxIndex,
  buildParentIndex,
  candidateBeatsCurrent,
  classifyEdges,
  countCrossFlowTerminals,
  countPolylineCrossings,
  foreignCrossings,
  maxEndpointDegree,
  pickArcBend,
  planTransfer,
  sampleArc,
  sampledForeignCrossings,
  segCrossesBox,
  sideOfPoint,
  visibleSetFor,
} from "./edge-routing-core";
import probe from "./fixtures/drw199-probe.json";

const box = (over: Partial<RouteBox> & { id: string }): RouteBox => ({
  kind: "leaf",
  parent: null,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  ...over,
});

describe("classifyEdges / visibleSetFor (V-H)", () => {
  const boxes: RouteBox[] = [
    box({ id: "C1", kind: "container", w: 200, h: 400 }),
    box({ id: "a", parent: "C1", x: 20, y: 20, w: 60, h: 40 }),
    box({ id: "b", parent: "C1", x: 20, y: 200, w: 60, h: 40 }),
    box({ id: "C2", kind: "container", x: 400, w: 200, h: 400 }),
    box({ id: "c", parent: "C2", x: 420, y: 20, w: 60, h: 40 }),
    box({ id: "free", x: 800, y: 0, w: 60, h: 40 }),
  ];

  test("межконтейнерное ребро исключает обоих предков, внутреннее — одного", () => {
    const { classes } = classifyEdges(boxes, [
      { id: "e1", from: "a", to: "c" },
      { id: "e2", from: "a", to: "b" },
    ]);
    expect(classes).toHaveLength(2);
    const cross = classes.find((c) => c.edges[0].id === "e1");
    expect([...(cross?.excl ?? [])].sort()).toEqual(["C1", "C2"]);
    const inner = classes.find((c) => c.edges[0].id === "e2");
    expect([...(inner?.excl ?? [])]).toEqual(["C1"]);
  });

  test("рёбра одного exclusion-множества попадают в один класс", () => {
    const { classes } = classifyEdges(boxes, [
      { id: "e1", from: "a", to: "c" },
      { id: "e2", from: "b", to: "c" },
    ]);
    expect(classes).toHaveLength(1);
    expect(classes[0].edges).toHaveLength(2);
  });

  test("лист→свой контейнер уходит в skipped", () => {
    const { classes, skipped } = classifyEdges(boxes, [
      { id: "e1", from: "a", to: "C1" },
    ]);
    expect(classes).toHaveLength(0);
    expect(skipped.map((e) => e.id)).toEqual(["e1"]);
  });

  test("visibleSet: исключённый контейнер раскрыт, чужой опаковый (без overlap)", () => {
    const byParent = buildParentIndex(boxes);
    const ids = visibleSetFor(byParent, new Set(["C1"]))
      .map((b) => b.id)
      .sort();
    expect(ids).toEqual(["C2", "a", "b", "free"]);
  });

  test("visibleSet рекурсивен для вложенных контейнеров", () => {
    const nested: RouteBox[] = [
      box({ id: "outer", kind: "container", w: 600, h: 600 }),
      box({
        id: "inner",
        kind: "container",
        parent: "outer",
        x: 20,
        y: 20,
        w: 200,
        h: 200,
      }),
      box({ id: "leaf", parent: "inner", x: 40, y: 40, w: 60, h: 40 }),
      box({ id: "sib", parent: "outer", x: 300, y: 300, w: 60, h: 40 }),
    ];
    const ids = visibleSetFor(
      buildParentIndex(nested),
      new Set(["outer", "inner"]),
    )
      .map((b) => b.id)
      .sort();
    expect(ids).toEqual(["leaf", "sib"]);
  });
});

describe("геометрия", () => {
  const wall = box({ id: "w", x: 200, y: 0, w: 100, h: 100 });
  test("горизонтальный сегмент сквозь бокс / по касательной", () => {
    expect(segCrossesBox([0, 50] as const, [400, 50] as const, wall)).toBe(
      true,
    );
    expect(segCrossesBox([0, 0] as const, [400, 0] as const, wall)).toBe(false); // касание границы
    expect(segCrossesBox([0, 150] as const, [400, 150] as const, wall)).toBe(
      false,
    );
  });
  test("near-ortho сегмент (float-дрейф вершин реальной стрелки) считается горизонтальным", () => {
    expect(segCrossesBox([0, 50.2], [400, 50.0], wall)).toBe(true);
    expect(segCrossesBox([0, 50], [400, 53], wall)).toBe(false); // настоящая диагональ
  });
  test("вертикальный сегмент", () => {
    expect(segCrossesBox([250, -50] as const, [250, 200] as const, wall)).toBe(
      true,
    );
    expect(segCrossesBox([200, -50] as const, [200, 200] as const, wall)).toBe(
      false,
    );
  });
  test("foreignCrossings исключает концы и их предков", () => {
    const fboxes: RouteBox[] = [
      box({ id: "C1", kind: "container", w: 100, h: 100 }),
      box({ id: "a", parent: "C1", x: 10, y: 10, w: 40, h: 40 }),
      box({ id: "b", x: 400, y: 10, w: 40, h: 40 }),
      box({ id: "wall", x: 200, y: 0, w: 50, h: 100 }),
    ];
    const edge: RouteEdge = { id: "e", from: "a", to: "b" };
    const route: ReadonlyArray<readonly [number, number]> = [
      [30, 30],
      [420, 30],
    ];
    // пересекает C1 (свой предок — не считается) и wall (чужой — считается)
    expect(
      foreignCrossings(route, edge, fboxes, buildBoxIndex(fboxes)),
    ).toEqual(["wall"]);
  });
  test("foreignCrossings ловит кривую полилинию по вершинам внутри бокса", () => {
    const fboxes: RouteBox[] = [
      box({ id: "a", x: 0, y: 0, w: 40, h: 40 }),
      box({ id: "b", x: 400, y: 0, w: 40, h: 40 }),
      box({ id: "wall", x: 180, y: 40, w: 80, h: 80 }),
    ];
    const edge: RouteEdge = { id: "e", from: "a", to: "b" };
    // диагональная «дуга»: вершина [220, 80] внутри wall, ortho-сегментов нет
    const curve: ReadonlyArray<readonly [number, number]> = [
      [40, 20],
      [130, 55],
      [220, 80],
      [310, 55],
      [400, 20],
    ];
    expect(
      foreignCrossings(curve, edge, fboxes, buildBoxIndex(fboxes)),
    ).toEqual(["wall"]);
  });
  test("пересечение двух ortho-полилиний", () => {
    const a: ReadonlyArray<readonly [number, number]> = [
      [0, 50],
      [100, 50],
    ];
    const b: ReadonlyArray<readonly [number, number]> = [
      [50, 0],
      [50, 100],
    ];
    expect(countPolylineCrossings(a, b)).toBe(1);
    expect(countPolylineCrossings(a, a)).toBe(0); // параллельные H×H не считаются
  });
});

describe("гейт", () => {
  const m = (
    foreign: number,
    edgeCross = 0,
    length = 100,
  ): {
    foreign: number;
    edgeCross: number;
    length: number;
    crossFlow: number;
  } => ({
    foreign,
    edgeCross,
    length,
    crossFlow: 0,
  });
  test("кандидат побеждает только при строгом улучшении score", () => {
    expect(candidateBeatsCurrent(m(0), m(1))).toBe(true);
    expect(candidateBeatsCurrent(m(1), m(0))).toBe(false);
  });
  test("равный score: длина решает только с маржой 5%", () => {
    expect(candidateBeatsCurrent(m(0, 0, 94), m(0, 0, 100))).toBe(true);
    expect(candidateBeatsCurrent(m(0, 0, 96), m(0, 0, 100))).toBe(false);
  });
  test("равный foreign/edgeCross: кандидат с crossFlow=0 строго бьёт текущий с crossFlow=1", () => {
    const current: RouteMetrics = {
      foreign: 0,
      edgeCross: 0,
      length: 100,
      crossFlow: 1,
    };
    const candidate: RouteMetrics = {
      foreign: 0,
      edgeCross: 0,
      length: 100,
      crossFlow: 0,
    };
    expect(candidateBeatsCurrent(candidate, current)).toBe(true);
  });

  test("оба crossFlow=0, равный score → длина решает (маржа 5%)", () => {
    const current: RouteMetrics = {
      foreign: 0,
      edgeCross: 0,
      length: 100,
      crossFlow: 0,
    };
    const candidate: RouteMetrics = {
      foreign: 0,
      edgeCross: 0,
      length: 94,
      crossFlow: 0,
    };
    expect(candidateBeatsCurrent(candidate, current)).toBe(true);
    const candidate2: RouteMetrics = {
      foreign: 0,
      edgeCross: 0,
      length: 96,
      crossFlow: 0,
    };
    expect(candidateBeatsCurrent(candidate2, current)).toBe(false);
  });
});

describe("planTransfer", () => {
  const src = box({ id: "s", x: 0, y: 0, w: 100, h: 100 });
  const dst = box({ id: "d", x: 400, y: 0, w: 100, h: 100 });

  test("прямая R→L", () => {
    const p = planTransfer(
      [
        [100, 50],
        [400, 50],
      ] as unknown as Polyline,
      src,
      dst,
    );
    expect(p).toMatchObject({ kind: "straight", srcSide: "R", dstSide: "L" });
  });

  test("Z-маршрут R→L: midpoint нормирован между фасадами", () => {
    // фасады: src right=100, dst left=400; средняя линия x=250 → t=0.5
    const p = planTransfer(
      [
        [100, 30],
        [250, 30],
        [250, 80],
        [400, 80],
      ] as unknown as Polyline,
      src,
      dst,
    );
    expect(p.kind).toBe("Z");
    expect(p.elbowMidPoint).toBeCloseTo(0.5);
  });

  test("Z со средней линией вне фасадов → detour (ручка не достанет)", () => {
    const p = planTransfer(
      [
        [100, 30],
        [600, 30],
        [600, 80],
        [400, 80],
      ] as unknown as Polyline,
      src,
      dst,
    );
    expect(p.kind).toBe("detour");
  });

  test("same-side U (B→B) распознан как U", () => {
    const p = planTransfer(
      [
        [50, 100],
        [50, 300],
        [450, 300],
        [450, 100],
      ] as unknown as Polyline,
      src,
      dst,
    );
    expect(p).toMatchObject({ kind: "U", srcSide: "B", dstSide: "B" });
  });

  test("5+ сегментов → detour", () => {
    const p = planTransfer(
      [
        [100, 50],
        [200, 50],
        [200, 200],
        [350, 200],
        [350, 50],
        [400, 50],
      ] as unknown as Polyline,
      src,
      dst,
    );
    expect(p.kind).toBe("detour");
  });
});

describe("assignPorts", () => {
  test("порядок портов следует порядку маршрутов, позиции (i+1)/(n+1)", () => {
    const hub = box({ id: "hub", x: 0, y: 0, w: 100, h: 300 });
    const t1 = box({ id: "t1", x: 400, y: 0, w: 80, h: 60 });
    const t2 = box({ id: "t2", x: 400, y: 240, w: 80, h: 60 });
    const byId = buildBoxIndex([hub, t1, t2]);
    const edges: RouteEdge[] = [
      { id: "e-bottom", from: "hub", to: "t2" },
      { id: "e-top", from: "hub", to: "t1" },
    ];
    const routes = new Map<string, Polyline>([
      [
        "e-top",
        [
          [100, 80],
          [400, 30],
        ] as unknown as Polyline,
      ],
      [
        "e-bottom",
        [
          [100, 220],
          [400, 270],
        ] as unknown as Polyline,
      ],
    ]);
    const hubR = assignPorts(routes, edges, byId).find(
      (a) => a.shapeId === "hub" && a.side === "R",
    );
    expect(hubR?.ports.map((p) => p.edgeId)).toEqual(["e-top", "e-bottom"]);
    expect(hubR?.ports.map((p) => p.frac)).toEqual([1 / 3, 2 / 3]);
  });

  test("детерминизм: одинаковый orderKey — тай-брейк по edgeId", () => {
    const hub = box({ id: "hub", w: 100, h: 100 });
    const t = box({ id: "t", x: 400, w: 100, h: 100 });
    const byId = buildBoxIndex([hub, t]);
    const edges: RouteEdge[] = [
      { id: "b", from: "hub", to: "t" },
      { id: "a", from: "hub", to: "t" },
    ];
    const line = [
      [100, 50],
      [400, 50],
    ] as unknown as Polyline;
    const routes = new Map([
      ["a", line],
      ["b", line],
    ]);
    const hubR = assignPorts(routes, edges, byId).find(
      (x) => x.shapeId === "hub",
    );
    expect(hubR?.ports.map((p) => p.edgeId)).toEqual(["a", "b"]);
  });
});

describe("sideOfPoint / anchorFor", () => {
  const b = box({ id: "b", x: 10, y: 10, w: 100, h: 100 });
  test("точка на грани определяет сторону", () => {
    expect(sideOfPoint([10, 50], b)).toBe("L");
    expect(sideOfPoint([110, 50], b)).toBe("R");
    expect(sideOfPoint([50, 10], b)).toBe("T");
    expect(sideOfPoint([50, 110], b)).toBe("B");
    expect(sideOfPoint([50, 50], b)).toBe(null);
  });
  test("anchorFor отображает сторону+frac в normalizedAnchor", () => {
    expect(anchorFor("R", 0.25)).toEqual({ x: 1, y: 0.25 });
    expect(anchorFor("T", 0.75)).toEqual({ x: 0.75, y: 0 });
  });
});

describe("arc-кандидат", () => {
  // sampleArc: горизонтальная хорда [0,0]→[400,0], bend=100 (сагитта).
  // Нормаль: nx=0, ny=1 → apex=[200, 2*bend]=[200,200].
  // Квадратичная Безье t=0.5: y = 2*0.25*200 = 100 = bend — середина модели
  // отклоняется ровно на сагитту, как настоящая дуга tldraw.
  test("sampleArc: начало/конец совпадают со start/end", () => {
    const pts = sampleArc([0, 0], [400, 0], 100);
    const first = pts[0];
    const last = pts[pts.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first && last) {
      expect(first[0]).toBeCloseTo(0);
      expect(first[1]).toBeCloseTo(0);
      expect(last[0]).toBeCloseTo(400);
      expect(last[1]).toBeCloseTo(0);
    }
  });

  test("sampleArc: mid-точка (t=0.5) горизонтальной дуги при bend=100 → y≈100 (сагитта)", () => {
    const pts = sampleArc([0, 0], [400, 0], 100, 16);
    // t=0.5 соответствует индексу samples/2 = 8
    const mid = pts[8];
    expect(mid).toBeDefined();
    if (mid) {
      expect(mid[0]).toBeCloseTo(200, 0);
      expect(mid[1]).toBeCloseTo(100, 0); // отклонение середины = bend
    }
  });

  test("sampledForeignCrossings: дуга над боксом → пусто", () => {
    // Бокс на y=200..300; дуга горизонтальная на y≈0..50 — не пересекает
    const wallFar: RouteBox = {
      id: "wall",
      kind: "leaf",
      parent: null,
      x: 100,
      y: 200,
      w: 200,
      h: 100,
    };
    const edge: RouteEdge = { id: "e", from: "src", to: "dst" };
    const boxes = [wallFar];
    const byId = buildBoxIndex(boxes);
    const pts = sampleArc([0, 0], [400, 0], 50); // apex y=25; max y≈12.5
    const hits = sampledForeignCrossings(pts, edge, boxes, byId);
    expect(hits).toHaveLength(0);
  });

  test("sampledForeignCrossings: дуга сквозь бокс → [id бокса]", () => {
    // Бокс y: 10..90; дуга от [0,50] к [400,50] с bend=30 прогибается до y=80
    // в середине — внутри бокса (x 100..300).
    const wall: RouteBox = {
      id: "wall",
      kind: "leaf",
      parent: null,
      x: 100,
      y: 10,
      w: 200,
      h: 80,
    };
    const edge: RouteEdge = { id: "e", from: "src", to: "dst" };
    const boxes = [wall];
    const byId = buildBoxIndex(boxes);
    const pts = sampleArc([0, 50], [400, 50], 30);
    const hits = sampledForeignCrossings(pts, edge, boxes, byId);
    expect(hits).toContain("wall");
  });

  test("pickArcBend: U-маршрут огибает стену снизу → bend найден, дуга чистая", () => {
    // Стена: x=150..250, y=0..100. Src: x=0..80,y=20..60. Dst: x=320..400,y=20..60.
    // U-маршрут: [80,40] → [80,150] → [320,150] → [320,40] (обходит снизу).
    // Хорда: [80,40]→[320,40] — проходит сквозь стену.
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
    const edge: RouteEdge = { id: "e", from: "src", to: "dst" };
    const boxes = [src, dst, wall];
    const byId = buildBoxIndex(boxes);
    // U-маршрут ogibает снизу: depth ≈ 110 (150 - 40)
    const route: Polyline = [
      [80, 40],
      [80, 150],
      [320, 150],
      [320, 40],
    ];
    const bend = pickArcBend(route, edge, boxes, byId);
    expect(bend).not.toBeNull();
    if (bend !== null) {
      // Верифицируем: дуга с этим bend не пересекает стену
      const start = route[0];
      const end = route[route.length - 1];
      if (start && end) {
        const arc = sampleArc(start, end, bend);
        const hits = sampledForeignCrossings(arc, edge, boxes, byId);
        expect(hits).toHaveLength(0);
      }
    }
  });

  test("pickArcBend: стена огромная, ни один кандидат не проходит → null", () => {
    // Стена покрывает всю область между src и dst по обе стороны хорды
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
    // Огромная стена: закрывает y от -2000 до 2000
    const wall: RouteBox = {
      id: "wall",
      kind: "leaf",
      parent: null,
      x: 60,
      y: -2000,
      w: 380,
      h: 4000,
    };
    const edge: RouteEdge = { id: "e", from: "src", to: "dst" };
    const boxes = [src, dst, wall];
    const byId = buildBoxIndex(boxes);
    // Любой маршрут проходит через зону x=60..440 — стена всё закрывает
    const route: Polyline = [
      [50, 25],
      [50, 300],
      [450, 300],
      [450, 25],
    ];
    const bend = pickArcBend(route, edge, boxes, byId);
    expect(bend).toBeNull();
  });

  test("pickArcBend детерминирован: два вызова возвращают одно значение", () => {
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
    const edge: RouteEdge = { id: "e", from: "src", to: "dst" };
    const boxes = [src, dst, wall];
    const byId = buildBoxIndex(boxes);
    const route: Polyline = [
      [80, 40],
      [80, 150],
      [320, 150],
      [320, 40],
    ];
    const bend1 = pickArcBend(route, edge, boxes, byId);
    const bend2 = pickArcBend(route, edge, boxes, byId);
    expect(bend1).toBe(bend2);
  });
});

describe("фикстура drw-235-probe (паритет с headless-пробой)", () => {
  test("классификация даёт 7 классов, эталонное ребро A3→E2 исключает C1+C4", () => {
    const boxes = probe.boxes as unknown as RouteBox[];
    const edges = probe.edges as Array<{
      id: string;
      from: string;
      to: string;
    }>;
    const { classes, skipped } = classifyEdges(boxes, edges);
    expect(skipped).toHaveLength(0);
    expect(classes).toHaveLength(7);
    const a3e2 = classes.find((c) =>
      c.edges.some((e) => e.from === "shape:t218a3" && e.to === "shape:t218e2"),
    );
    expect(a3e2).toBeDefined();
    const byId = buildBoxIndex(boxes);
    const exclLabels = [...(a3e2?.excl ?? [])]
      .map((id) => byId.get(id)?.id)
      .sort();
    expect(exclLabels).toHaveLength(2);
  });
});

// ─── maxEndpointDegree ────────────────────────────────────────────────────────

describe("maxEndpointDegree", () => {
  test("хаб с 7 рёбрами → 7", () => {
    // Узел H соединён с 7 другими; степень H = 7
    const edges: RouteEdge[] = Array.from({ length: 7 }, (_, i) => ({
      id: `e${i}`,
      from: "H",
      to: `N${i}`,
    }));
    expect(maxEndpointDegree(edges)).toBe(7);
  });

  test("пустой набор рёбер → 0", () => {
    expect(maxEndpointDegree([])).toBe(0);
  });

  test("два узла с одинаковой степенью → правильный максимум", () => {
    // A→B, A→C, B→D, B→E: степень A=2, степень B=3 (1 как to + 2 как from)
    const edges: RouteEdge[] = [
      { id: "e1", from: "A", to: "B" },
      { id: "e2", from: "A", to: "C" },
      { id: "e3", from: "B", to: "D" },
      { id: "e4", from: "B", to: "E" },
    ];
    expect(maxEndpointDegree(edges)).toBe(3);
  });
});

describe("axisOfDirection", () => {
  test("TB → v", () => expect(axisOfDirection("TB")).toBe("v"));
  test("BT → v", () => expect(axisOfDirection("BT")).toBe("v"));
  test("LR → h", () => expect(axisOfDirection("LR")).toBe("h"));
  test("RL → h", () => expect(axisOfDirection("RL")).toBe("h"));
  test("мусор → undefined", () =>
    expect(axisOfDirection("XY")).toBeUndefined());
  test("undefined → undefined", () =>
    expect(axisOfDirection(undefined)).toBeUndefined());
});

describe("countCrossFlowTerminals", () => {
  const srcH: RouteBox = {
    id: "s",
    kind: "leaf",
    parent: null,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    flowAxis: "v",
  };
  const dstH: RouteBox = {
    id: "d",
    kind: "leaf",
    parent: null,
    x: 200,
    y: 0,
    w: 100,
    h: 100,
    flowAxis: "v",
  };
  const dstNoAxis: RouteBox = {
    id: "d2",
    kind: "leaf",
    parent: null,
    x: 200,
    y: 0,
    w: 100,
    h: 100,
  };

  test("same-row пара (не разделена по оси потока): боковой ход легален → 0", () => {
    const pts: Polyline = [
      [100, 50],
      [200, 50],
    ] as unknown as Polyline;
    expect(countCrossFlowTerminals(pts, srcH, dstH)).toBe(0);
  });

  test("пара, разделённая вдоль потока: боковые терминалы штрафуются → 2", () => {
    const below: RouteBox = { ...dstH, x: 0, y: 200 }; // строго ниже srcH
    // маршрут выходит из правого края src и входит в правый край below
    const pts: Polyline = [
      [100, 50],
      [150, 50],
      [150, 250],
      [100, 250],
    ] as unknown as Polyline;
    expect(countCrossFlowTerminals(pts, srcH, below)).toBe(2);
  });

  test("вертикальный маршрут B→T при flowAxis=v → crossFlow=0", () => {
    const srcV: RouteBox = {
      id: "sv",
      kind: "leaf",
      parent: null,
      x: 100,
      y: 0,
      w: 100,
      h: 100,
      flowAxis: "v",
    };
    const dstV: RouteBox = {
      id: "dv",
      kind: "leaf",
      parent: null,
      x: 100,
      y: 200,
      w: 100,
      h: 100,
      flowAxis: "v",
    };
    const pts: Polyline = [
      [150, 100],
      [150, 200],
    ] as unknown as Polyline;
    expect(countCrossFlowTerminals(pts, srcV, dstV)).toBe(0);
  });

  test("бокс без flowAxis → не штрафуется", () => {
    const pts: Polyline = [
      [100, 50],
      [200, 50],
    ] as unknown as Polyline;
    expect(countCrossFlowTerminals(pts, dstNoAxis, dstNoAxis)).toBe(0);
  });

  test("только src имеет flowAxis (пара разделена вдоль), dst — нет → 1", () => {
    const belowNoAxis: RouteBox = { ...dstNoAxis, x: 0, y: 200 };
    const pts: Polyline = [
      [100, 50],
      [150, 50],
      [150, 250],
      [100, 250],
    ] as unknown as Polyline;
    expect(countCrossFlowTerminals(pts, srcH, belowNoAxis)).toBe(1);
  });
});
