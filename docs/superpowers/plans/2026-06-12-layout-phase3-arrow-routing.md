# Layout Фаза 3 — edge-routing (DRW-199) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** после явной компоновки стрелки не идут сквозь боксы и не переплетаются на выходе из узла — libavoid-as-layout-hint поверх штатных elbow-стрелок.

**Architecture:** чистое ядро `edge-routing-core.ts` (классификация V-H, видимость, метрики, перенос, порты, гейт) + тонкая WASM-обёртка `libavoid-router.ts` (lazy-load) + оркестратор `edge-routing.ts` (сбор боксов из editor, writeback, отчёт). Интеграция в оба scope-пайплайна `elk-layout.ts` за dev-флагом `window.__SHEMMA_EDGE_ROUTING` (снимается в T8). Спека: `docs/superpowers/specs/2026-06-12-layout-phase3-arrow-routing-design.md`.

**Tech Stack:** TypeScript strict, bun test, libavoid-js@0.5.0-beta.5 (уже в devDependencies frontend), tldraw 5.x.

**Контекст для исполнителя (прочитать перед T1):**
- Спека §2 — почему V-H: libavoid требует НЕпересекающихся препятствий; предки концов «раскрываются» до детей, чужие контейнеры опаковые. Probe-референс: `docs/references/drw-199-probes/` (probe-hierarchy.mjs — рабочий V-H на сырых JSON).
- Спека §5 — у same-side U-маршрутов tldraw НЕТ управляемого midpoint; такие рёбра — кандидаты приближения, гейт решает.
- embind-грабли (отчёт DRW-244 §AC#3): enum'ы — статические свойства классов (`Avoid.RouterFlag.OrthogonalRouting.value` в конструктор), полилиния — `pl.at(i)`, `ConnDirAll` = число 15, объекты требуют ручного `.delete()`.
- Точки интеграции: `apps/frontend/src/canvas/elk-layout.ts` — фрейм-scope ~строка 1701 (`distributeArrowPorts(editor, inGraph, byArrow, frameDir, alignedEdgesSet); optimizeScopedElbows(...)`), контейнер-scope ~строка 1015 (то же без alignedEdgesSet). Обе функции async.
- `byArrow: Record<string, { start?: string; end?: string }>` — карта arrowId → концевые shapeId (уже собирается в обоих scope).
- `alignedEdgesSet: Set<string>` — ключи `"from>to"` выровненных Ф2 рёбер (фрейм-scope). Выровненные рёбра пасс НЕ трогает (реализация спекового пункта про portHints-стоимости; в T8 спека уточняется до v1.1).

---

### Task 1: edge-routing-core — классификация V-H, видимость, геометрия, метрики

**Files:**
- Create: `apps/frontend/src/canvas/edge-routing-core.ts`
- Create: `apps/frontend/src/canvas/edge-routing-core.test.ts`
- Create: `apps/frontend/src/canvas/fixtures/drw199-probe.json` (копия `docs/references/drw-199-probes/boxes-probe.json`)
- Create: `apps/frontend/src/canvas/fixtures/drw199-probe2.json` (копия `boxes-probe2.json`)

- [ ] **Step 1: типы и индексы**

```typescript
// apps/frontend/src/canvas/edge-routing-core.ts
// DRW-199: чистое ядро edge-routing — без tldraw, без libavoid (юниты в bun).
// Модель V-H («иерархическая видимость per-class») — спека §2-3.

export type Side = "L" | "R" | "T" | "B";
export type RoutePoint = readonly [number, number];
export type Polyline = ReadonlyArray<RoutePoint>;

export interface RouteBox {
  readonly id: string;
  readonly kind: "leaf" | "container";
  /** Контейнер-родитель в scope; null — top-level бокс фрейма. */
  readonly parent: string | null;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface RouteEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export interface RoutingClass {
  readonly key: string;
  readonly excl: ReadonlySet<string>;
  readonly edges: RouteEdge[];
}

export function buildBoxIndex(
  boxes: ReadonlyArray<RouteBox>,
): Map<string, RouteBox> {
  return new Map(boxes.map((b) => [b.id, b]));
}

export function buildParentIndex(
  boxes: ReadonlyArray<RouteBox>,
): Map<string | null, RouteBox[]> {
  const out = new Map<string | null, RouteBox[]>();
  for (const b of boxes) {
    const key = b.parent ?? null;
    const list = out.get(key);
    if (list) list.push(b);
    else out.set(key, [b]);
  }
  return out;
}

export function ancestorsOf(
  byId: ReadonlyMap<string, RouteBox>,
  id: string,
): Set<string> {
  const out = new Set<string>();
  let cur = byId.get(id);
  while (cur?.parent) {
    out.add(cur.parent);
    cur = byId.get(cur.parent);
  }
  return out;
}
```

- [ ] **Step 2: классификация рёбер + видимость (V-H)**

```typescript
export interface Classification {
  readonly classes: RoutingClass[];
  /** Рёбра лист→свой контейнер и рёбра с отсутствующим концом — не роутим. */
  readonly skipped: RouteEdge[];
}

export function classifyEdges(
  boxes: ReadonlyArray<RouteBox>,
  edges: ReadonlyArray<RouteEdge>,
): Classification {
  const byId = buildBoxIndex(boxes);
  const classes = new Map<string, { excl: Set<string>; edges: RouteEdge[] }>();
  const skipped: RouteEdge[] = [];
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) {
      skipped.push(e);
      continue;
    }
    const excl = new Set([
      ...ancestorsOf(byId, e.from),
      ...ancestorsOf(byId, e.to),
    ]);
    // конец = предок другого конца (лист → свой контейнер): V-H не моделирует
    if (excl.has(e.from) || excl.has(e.to)) {
      skipped.push(e);
      continue;
    }
    const key = [...excl].sort().join("|");
    const cls = classes.get(key);
    if (cls) cls.edges.push(e);
    else classes.set(key, { excl, edges: [e] });
  }
  return {
    classes: [...classes.entries()].map(([key, c]) => ({ key, ...c })),
    skipped,
  };
}

/** Набор препятствий класса БЕЗ overlap: исключённые контейнеры раскрыты до детей,
 * прочие контейнеры опаковые (их дети не входят). */
export function visibleSetFor(
  byParent: ReadonlyMap<string | null, RouteBox[]>,
  excl: ReadonlySet<string>,
): RouteBox[] {
  const out: RouteBox[] = [];
  const expand = (b: RouteBox): void => {
    if (b.kind === "container" && excl.has(b.id)) {
      for (const child of byParent.get(b.id) ?? []) expand(child);
    } else {
      out.push(b);
    }
  };
  for (const b of byParent.get(null) ?? []) expand(b);
  return out;
}
```

- [ ] **Step 3: геометрия — пересечения сегмент×бокс и сегмент×сегмент**

```typescript
/** Ortho-сегмент пересекает ВНУТРЕННОСТЬ прямоугольника (касание границы — нет). */
export function segCrossesBox(
  p1: RoutePoint,
  p2: RoutePoint,
  b: RouteBox,
): boolean {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const left = b.x;
  const right = b.x + b.w;
  const top = b.y;
  const bottom = b.y + b.h;
  if (y1 === y2) {
    return (
      y1 > top && y1 < bottom && Math.max(x1, x2) > left && Math.min(x1, x2) < right
    );
  }
  if (x1 === x2) {
    return (
      x1 > left && x1 < right && Math.max(y1, y2) > top && Math.min(y1, y2) < bottom
    );
  }
  return false; // не-ortho сегменты ядро не считает
}

/** Чужие боксы, через которые проходит маршрут (концы и их предки исключены). */
export function foreignCrossings(
  points: Polyline,
  edge: RouteEdge,
  boxes: ReadonlyArray<RouteBox>,
  byId: ReadonlyMap<string, RouteBox>,
): string[] {
  const skip = new Set([edge.from, edge.to]);
  for (const a of ancestorsOf(byId, edge.from)) skip.add(a);
  for (const a of ancestorsOf(byId, edge.to)) skip.add(a);
  const hit: string[] = [];
  for (const b of boxes) {
    if (skip.has(b.id)) continue;
    for (let i = 0; i + 1 < points.length; i++) {
      if (segCrossesBox(points[i], points[i + 1], b)) {
        hit.push(b.id);
        break;
      }
    }
  }
  return hit;
}

/** Пересечение H-сегмента и V-сегмента (строгое, без касаний). */
function orthoSegsCross(
  h1: RoutePoint,
  h2: RoutePoint,
  v1: RoutePoint,
  v2: RoutePoint,
): boolean {
  const y = h1[1];
  const x = v1[0];
  return (
    y > Math.min(v1[1], v2[1]) &&
    y < Math.max(v1[1], v2[1]) &&
    x > Math.min(h1[0], h2[0]) &&
    x < Math.max(h1[0], h2[0])
  );
}

export function countPolylineCrossings(a: Polyline, b: Polyline): number {
  let n = 0;
  for (let i = 0; i + 1 < a.length; i++) {
    const aH = a[i][1] === a[i + 1][1];
    for (let j = 0; j + 1 < b.length; j++) {
      const bH = b[j][1] === b[j + 1][1];
      if (aH === bH) continue;
      const crossed = aH
        ? orthoSegsCross(a[i], a[i + 1], b[j], b[j + 1])
        : orthoSegsCross(b[j], b[j + 1], a[i], a[i + 1]);
      if (crossed) n++;
    }
  }
  return n;
}

export function polylineLength(points: Polyline): number {
  let len = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    len +=
      Math.abs(points[i + 1][0] - points[i][0]) +
      Math.abs(points[i + 1][1] - points[i][1]);
  }
  return len;
}
```

- [ ] **Step 4: метрики и гейт (строгое улучшение, анти-дрейф)**

```typescript
export interface RouteMetrics {
  readonly foreign: number;
  readonly edgeCross: number;
  readonly length: number;
}

const FOREIGN_WEIGHT = 1.0;
const EDGE_CROSS_WEIGHT = 0.15;
/** Тай-брейк по длине требует ≥5% выигрыша — иначе действующий маршрут остаётся. */
const LENGTH_MARGIN = 0.95;

export function routeScore(m: RouteMetrics): number {
  return m.foreign * FOREIGN_WEIGHT + m.edgeCross * EDGE_CROSS_WEIGHT;
}

export function candidateBeatsCurrent(
  candidate: RouteMetrics,
  current: RouteMetrics,
): boolean {
  const cs = routeScore(candidate);
  const cu = routeScore(current);
  if (cs < cu) return true;
  if (cs > cu) return false;
  return candidate.length < current.length * LENGTH_MARGIN;
}
```

- [ ] **Step 5: юниты ядра (включая фикстуры probe-комнат)**

Скопировать фикстуры:

```bash
cp docs/references/drw-199-probes/boxes-probe.json apps/frontend/src/canvas/fixtures/drw199-probe.json
cp docs/references/drw-199-probes/boxes-probe2.json apps/frontend/src/canvas/fixtures/drw199-probe2.json
```

```typescript
// apps/frontend/src/canvas/edge-routing-core.test.ts
import { describe, expect, test } from "bun:test";
import probe from "./fixtures/drw199-probe.json";
import {
  ancestorsOf,
  buildBoxIndex,
  buildParentIndex,
  candidateBeatsCurrent,
  classifyEdges,
  countPolylineCrossings,
  foreignCrossings,
  type RouteBox,
  type RouteEdge,
  segCrossesBox,
  visibleSetFor,
} from "./edge-routing-core";

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
      box({ id: "inner", kind: "container", parent: "outer", x: 20, y: 20, w: 200, h: 200 }),
      box({ id: "leaf", parent: "inner", x: 40, y: 40, w: 60, h: 40 }),
      box({ id: "sib", parent: "outer", x: 300, y: 300, w: 60, h: 40 }),
    ];
    const ids = visibleSetFor(buildParentIndex(nested), new Set(["outer", "inner"]))
      .map((b) => b.id)
      .sort();
    expect(ids).toEqual(["leaf", "sib"]);
  });
});

describe("геометрия", () => {
  const wall = box({ id: "w", x: 200, y: 0, w: 100, h: 100 });
  test("горизонтальный сегмент сквозь бокс / по касательной", () => {
    expect(segCrossesBox([0, 50], [400, 50], wall)).toBe(true);
    expect(segCrossesBox([0, 0], [400, 0], wall)).toBe(false); // касание границы
    expect(segCrossesBox([0, 150], [400, 150], wall)).toBe(false);
  });
  test("вертикальный сегмент", () => {
    expect(segCrossesBox([250, -50], [250, 200], wall)).toBe(true);
    expect(segCrossesBox([200, -50], [200, 200], wall)).toBe(false);
  });
  test("foreignCrossings исключает концы и их предков", () => {
    const boxes: RouteBox[] = [
      box({ id: "C1", kind: "container", w: 100, h: 100 }),
      box({ id: "a", parent: "C1", x: 10, y: 10, w: 40, h: 40 }),
      box({ id: "b", x: 400, y: 10, w: 40, h: 40 }),
      box({ id: "wall", x: 200, y: 0, w: 50, h: 100 }),
    ];
    const edge: RouteEdge = { id: "e", from: "a", to: "b" };
    const route = [
      [30, 30],
      [420, 30],
    ] as const;
    // пересекает C1 (свой предок — не считается) и wall (чужой — считается)
    expect(foreignCrossings(route, edge, boxes, buildBoxIndex(boxes))).toEqual([
      "wall",
    ]);
  });
  test("пересечение двух ortho-полилиний", () => {
    const a = [
      [0, 50],
      [100, 50],
    ] as const;
    const b = [
      [50, 0],
      [50, 100],
    ] as const;
    expect(countPolylineCrossings(a, b)).toBe(1);
    expect(countPolylineCrossings(a, a)).toBe(0); // параллельные H×H не считаются
  });
});

describe("гейт", () => {
  const m = (foreign: number, edgeCross = 0, length = 100) => ({
    foreign,
    edgeCross,
    length,
  });
  test("кандидат побеждает только при строгом улучшении score", () => {
    expect(candidateBeatsCurrent(m(0), m(1))).toBe(true);
    expect(candidateBeatsCurrent(m(1), m(0))).toBe(false);
  });
  test("равный score: длина решает только с маржой 5%", () => {
    expect(candidateBeatsCurrent(m(0, 0, 94), m(0, 0, 100))).toBe(true);
    expect(candidateBeatsCurrent(m(0, 0, 96), m(0, 0, 100))).toBe(false);
  });
});

describe("фикстура drw-235-probe (паритет с headless-пробой)", () => {
  test("классификация даёт 7 классов, эталонное ребро A3→E2 исключает C1+C4", () => {
    const boxes = probe.boxes as RouteBox[];
    const edges = (probe.edges as Array<{ id: string; from: string; to: string }>);
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
```

- [ ] **Step 6: прогнать тесты**

Run: `cd apps/frontend && bun test src/canvas/edge-routing-core.test.ts`
Expected: PASS (все ~12 тестов).

- [ ] **Step 7: typecheck + commit**

```bash
cd apps/frontend && bun run typecheck
git add apps/frontend/src/canvas/edge-routing-core.ts apps/frontend/src/canvas/edge-routing-core.test.ts apps/frontend/src/canvas/fixtures/
git commit -m "feat(layout): edge-routing ядро — классификация V-H, видимость, метрики, гейт (DRW-199 T1)"
```

---

### Task 2: edge-routing-core — перенос маршрута и раздача портов

**Files:**
- Modify: `apps/frontend/src/canvas/edge-routing-core.ts` (дописать в конец)
- Modify: `apps/frontend/src/canvas/edge-routing-core.test.ts` (дописать)

- [ ] **Step 1: определение сторон и план переноса**

```typescript
/** Сторона бокса, на которой лежит точка (eps для координат пинов libavoid). */
export function sideOfPoint(p: RoutePoint, b: RouteBox, eps = 1.5): Side | null {
  const [x, y] = p;
  if (Math.abs(x - b.x) <= eps) return "L";
  if (Math.abs(x - (b.x + b.w)) <= eps) return "R";
  if (Math.abs(y - b.y) <= eps) return "T";
  if (Math.abs(y - (b.y + b.h)) <= eps) return "B";
  return null;
}

/** Сторона по направлению первого/последнего сегмента (фоллбэк для центр-пинов). */
export function sideOfExit(points: Polyline, b: RouteBox, fromStart: boolean): Side {
  const p0 = fromStart ? points[0] : points[points.length - 1];
  const onSide = sideOfPoint(p0, b);
  if (onSide) return onSide;
  const p1 = fromStart ? points[1] : points[points.length - 2];
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "R" : "L";
  return dy >= 0 ? "B" : "T";
}

export type TransferKind = "straight" | "L" | "Z" | "U" | "detour";

export interface TransferPlan {
  readonly kind: TransferKind;
  readonly srcSide: Side;
  readonly dstSide: Side;
  /** Нормированная позиция средней линии Z-маршрута (0..1 между фасадами боксов). */
  readonly elbowMidPoint?: number;
}

const OPPOSITE: Record<Side, Side> = { L: "R", R: "L", T: "B", B: "T" };

export function planTransfer(
  points: Polyline,
  src: RouteBox,
  dst: RouteBox,
): TransferPlan {
  const srcSide = sideOfExit(points, src, true);
  const dstSide = sideOfExit(points, dst, false);
  const segs = points.length - 1;
  if (segs <= 1) return { kind: "straight", srcSide, dstSide };
  if (segs === 2) return { kind: "L", srcSide, dstSide };
  if (segs === 3 && OPPOSITE[srcSide] === dstSide) {
    // Z: средняя линия перпендикулярна сторонам; нормируем между фасадами
    const horizontalFlow = srcSide === "L" || srcSide === "R";
    const mid = horizontalFlow ? points[1][0] : points[1][1];
    const a =
      srcSide === "R" ? src.x + src.w : srcSide === "L" ? src.x
      : srcSide === "B" ? src.y + src.h : src.y;
    const bF =
      dstSide === "L" ? dst.x : dstSide === "R" ? dst.x + dst.w
      : dstSide === "T" ? dst.y : dst.y + dst.h;
    const span = bF - a;
    const t = span === 0 ? 0.5 : (mid - a) / span;
    if (t > 0 && t < 1) {
      return { kind: "Z", srcSide, dstSide, elbowMidPoint: t };
    }
    return { kind: "detour", srcSide, dstSide }; // средняя линия вне фасадов — ручка не достанет
  }
  if (segs === 3 && srcSide === dstSide) return { kind: "U", srcSide, dstSide };
  return { kind: "detour", srcSide, dstSide };
}
```

- [ ] **Step 2: глобальная раздача портов из маршрутов**

```typescript
export interface PortSlot {
  readonly edgeId: string;
  readonly terminal: "start" | "end";
  readonly frac: number;
}

export interface PortAssignment {
  readonly shapeId: string;
  readonly side: Side;
  readonly ports: PortSlot[];
}

/** Порядок портов на стороне = порядок прилегающих точек маршрутов вдоль стороны.
 * Позиции (i+1)/(n+1). Детерминизм: тай-брейк по edgeId. */
export function assignPorts(
  routes: ReadonlyMap<string, Polyline>,
  edges: ReadonlyArray<RouteEdge>,
  byId: ReadonlyMap<string, RouteBox>,
): PortAssignment[] {
  type Item = { edgeId: string; terminal: "start" | "end"; orderKey: number };
  const groups = new Map<string, Item[]>(); // `${shapeId}|${side}`
  for (const e of edges) {
    const pts = routes.get(e.id);
    if (!pts || pts.length < 2) continue;
    const ends: Array<{ shapeId: string; terminal: "start" | "end" }> = [
      { shapeId: e.from, terminal: "start" },
      { shapeId: e.to, terminal: "end" },
    ];
    for (const { shapeId, terminal } of ends) {
      const b = byId.get(shapeId);
      if (!b) continue;
      const side = sideOfExit(pts, b, terminal === "start");
      // ключ порядка: координата СОСЕДНЕЙ точки маршрута вдоль оси стороны
      const adj = terminal === "start" ? pts[1] : pts[pts.length - 2];
      const orderKey = side === "L" || side === "R" ? adj[1] : adj[0];
      const key = `${shapeId}|${side}`;
      const list = groups.get(key);
      const item = { edgeId: e.id, terminal, orderKey };
      if (list) list.push(item);
      else groups.set(key, [item]);
    }
  }
  const out: PortAssignment[] = [];
  for (const [key, items] of [...groups.entries()].sort()) {
    const [shapeId, side] = key.split("|") as [string, Side];
    items.sort((a, b) => a.orderKey - b.orderKey || a.edgeId.localeCompare(b.edgeId));
    out.push({
      shapeId,
      side,
      ports: items.map((it, i) => ({
        edgeId: it.edgeId,
        terminal: it.terminal,
        frac: (i + 1) / (items.length + 1),
      })),
    });
  }
  return out;
}

export function anchorFor(side: Side, frac: number): { x: number; y: number } {
  if (side === "R") return { x: 1, y: frac };
  if (side === "L") return { x: 0, y: frac };
  if (side === "B") return { x: frac, y: 1 };
  return { x: frac, y: 0 };
}
```

- [ ] **Step 3: юниты переноса и портов** (дописать в `edge-routing-core.test.ts`)

```typescript
import {
  anchorFor,
  assignPorts,
  planTransfer,
  sideOfExit,
  sideOfPoint,
} from "./edge-routing-core";

describe("planTransfer", () => {
  const src = box({ id: "s", x: 0, y: 0, w: 100, h: 100 });
  const dst = box({ id: "d", x: 400, y: 0, w: 100, h: 100 });

  test("прямая R→L", () => {
    const p = planTransfer([[100, 50], [400, 50]], src, dst);
    expect(p).toMatchObject({ kind: "straight", srcSide: "R", dstSide: "L" });
  });

  test("Z-маршрут R→L: midpoint нормирован между фасадами", () => {
    // фасады: src right=100, dst left=400; средняя линия x=250 → t=0.5
    const p = planTransfer(
      [[100, 30], [250, 30], [250, 80], [400, 80]],
      src,
      dst,
    );
    expect(p.kind).toBe("Z");
    expect(p.elbowMidPoint).toBeCloseTo(0.5);
  });

  test("Z со средней линией вне фасадов → detour (ручка не достанет)", () => {
    const p = planTransfer(
      [[100, 30], [600, 30], [600, 80], [400, 80]],
      src,
      dst,
    );
    expect(p.kind).toBe("detour");
  });

  test("same-side U (B→B) распознан как U", () => {
    const p = planTransfer(
      [[50, 100], [50, 300], [450, 300], [450, 100]],
      src,
      dst,
    );
    expect(p).toMatchObject({ kind: "U", srcSide: "B", dstSide: "B" });
  });

  test("5+ сегментов → detour", () => {
    const p = planTransfer(
      [[100, 50], [200, 50], [200, 200], [350, 200], [350, 50], [400, 50]],
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
      ["e-top", [[100, 80], [400, 30]] as unknown as Polyline],
      ["e-bottom", [[100, 220], [400, 270]] as unknown as Polyline],
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
    const line = [[100, 50], [400, 50]] as unknown as Polyline;
    const routes = new Map([["a", line], ["b", line]]);
    const hubR = assignPorts(routes, edges, byId).find((x) => x.shapeId === "hub");
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
```

- [ ] **Step 4: тесты + typecheck + commit**

Run: `cd apps/frontend && bun test src/canvas/edge-routing-core.test.ts && bun run typecheck`
Expected: PASS.

```bash
git add apps/frontend/src/canvas/edge-routing-core.ts apps/frontend/src/canvas/edge-routing-core.test.ts
git commit -m "feat(layout): edge-routing ядро — перенос маршрутов (Z-midpoint) и раздача портов (DRW-199 T2)"
```

---

### Task 3: libavoid-router — lazy WASM-обёртка

**Files:**
- Create: `apps/frontend/src/canvas/libavoid-router.ts`
- Create: `apps/frontend/src/canvas/libavoid-router.test.ts`
- Reference: `apps/frontend/src/dev/libavoid-probe.ts` (рабочий пример API; НЕ менять)

- [ ] **Step 1: обёртка**

```typescript
// apps/frontend/src/canvas/libavoid-router.ts
// DRW-199: тонкая обёртка libavoid-js (WASM). Грузится лениво; недоступна → null
// (пасс деградирует к текущему elbow-поведению). embind-грабли: см. отчёт DRW-244.
import type {
  Polyline,
  RouteBox,
  RouteEdge,
  RoutingClass,
} from "./edge-routing-core";
import { buildParentIndex, visibleSetFor } from "./edge-routing-core";

// Типы libavoid-js даны интерфейсами без структуры — работаем через unknown-обёртку.
// biome-ignore lint/suspicious/noExplicitAny: emscripten-модуль без честных типов
type AvoidModule = any;

let avoidPromise: Promise<AvoidModule | null> | null = null;

/** Vite: bare-specifier wasm заблокирован exports-картой пакета (грабля DRW-244) —
 * берём файл относительным путём, `new URL(..., import.meta.url)` работает в dev и build. */
export function loadAvoid(): Promise<AvoidModule | null> {
  avoidPromise ??= (async () => {
    try {
      const { AvoidLib } = await import("libavoid-js");
      const wasmUrl = new URL(
        "../../node_modules/libavoid-js/dist/libavoid.wasm",
        import.meta.url,
      ).href;
      await AvoidLib.load(wasmUrl);
      return AvoidLib.getInstance();
    } catch (err) {
      console.warn("[shemma] libavoid недоступен — edge-routing пропущен", err);
      return null;
    }
  })();
  return avoidPromise;
}

/** Только для тестов: сброс singleton'а. */
export function resetAvoidForTests(): void {
  avoidPromise = null;
}

export interface RouterOpts {
  readonly bufferDistance: number; // 12
  readonly nudgeDistance: number; // 16
  readonly pinsPerSide: number; // ≥2
}

const SIDE_DIRS: ReadonlyArray<{
  dx: number;
  dy: number;
  visDir: number;
}> = [
  { dx: 0.5, dy: 0, visDir: 1 }, // top (ConnDirUp)
  { dx: 0.5, dy: 1, visDir: 2 }, // bottom (ConnDirDown)
  { dx: 0, dy: 0.5, visDir: 4 }, // left (ConnDirLeft)
  { dx: 1, dy: 0.5, visDir: 8 }, // right (ConnDirRight)
];
const PIN_CLASS = 1;

/** Роутит классы V-H; возвращает полилинии в абсолютных координатах входных боксов. */
export function routeClasses(
  Avoid: AvoidModule,
  boxes: ReadonlyArray<RouteBox>,
  classes: ReadonlyArray<RoutingClass>,
  opts: RouterOpts,
): Map<string, Polyline> {
  const byParent = buildParentIndex(boxes);
  const out = new Map<string, Polyline>();
  for (const cls of classes) {
    const router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value);
    router.setRoutingParameter(
      Avoid.RoutingParameter.shapeBufferDistance,
      opts.bufferDistance,
    );
    router.setRoutingParameter(
      Avoid.RoutingParameter.idealNudgingDistance,
      opts.nudgeDistance,
    );
    router.setRoutingOption(
      Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes,
      true,
    );
    const endpointIds = new Set(cls.edges.flatMap((e) => [e.from, e.to]));
    const refs = new Map<string, unknown>();
    for (const b of visibleSetFor(byParent, cls.excl)) {
      const rect = new Avoid.Rectangle(
        new Avoid.Point(b.x, b.y),
        new Avoid.Point(b.x + b.w, b.y + b.h),
      );
      const ref = new Avoid.ShapeRef(router, rect);
      if (endpointIds.has(b.id)) {
        // сетка exclusive-пинов по сторонам; один classId — libavoid выбирает
        for (const side of SIDE_DIRS) {
          for (let i = 1; i <= opts.pinsPerSide; i++) {
            const t = i / (opts.pinsPerSide + 1);
            const px = side.dx === 0.5 ? t : side.dx;
            const py = side.dy === 0.5 ? t : side.dy;
            const pin = new Avoid.ShapeConnectionPin(
              ref,
              PIN_CLASS,
              px,
              py,
              true,
              0,
              side.visDir,
            );
            pin.setExclusive(true);
          }
        }
      }
      refs.set(b.id, ref);
    }
    const conns: Array<{ edge: RouteEdge; conn: unknown }> = [];
    for (const e of cls.edges) {
      const src = refs.get(e.from);
      const dst = refs.get(e.to);
      if (!src || !dst) continue;
      conns.push({
        edge: e,
        conn: new Avoid.ConnRef(
          router,
          new Avoid.ConnEnd(src, PIN_CLASS),
          new Avoid.ConnEnd(dst, PIN_CLASS),
        ),
      });
    }
    router.processTransaction();
    for (const { edge, conn } of conns) {
      // biome-ignore lint/suspicious/noExplicitAny: emscripten-объект
      const pl = (conn as any).displayRoute();
      const pts: Array<readonly [number, number]> = [];
      for (let i = 0; i < pl.size(); i++) {
        const p = pl.at(i);
        pts.push([p.x, p.y]);
      }
      out.set(edge.id, pts);
    }
    router.delete();
  }
  return out;
}
```

- [ ] **Step 2: smoke-тест в bun (WASM реально грузится и роутит)**

```typescript
// apps/frontend/src/canvas/libavoid-router.test.ts
import { describe, expect, test } from "bun:test";
import type { RouteBox, RouteEdge } from "./edge-routing-core";
import { classifyEdges, foreignCrossings, buildBoxIndex } from "./edge-routing-core";
import { loadAvoid, routeClasses } from "./libavoid-router";

describe("libavoid-router (WASM smoke)", () => {
  test("грузится в bun и обходит препятствие", async () => {
    const Avoid = await loadAvoid();
    expect(Avoid).not.toBeNull();
    const boxes: RouteBox[] = [
      { id: "a", kind: "leaf", parent: null, x: 0, y: 340, w: 60, h: 60 },
      { id: "wall", kind: "leaf", parent: null, x: 580, y: 0, w: 90, h: 480 },
      { id: "b", kind: "leaf", parent: null, x: 900, y: 340, w: 60, h: 60 },
    ];
    const edges: RouteEdge[] = [{ id: "e", from: "a", to: "b" }];
    const { classes } = classifyEdges(boxes, edges);
    const routes = routeClasses(Avoid, boxes, classes, {
      bufferDistance: 12,
      nudgeDistance: 16,
      pinsPerSide: 2,
    });
    const route = routes.get("e");
    expect(route).toBeDefined();
    expect(
      foreignCrossings(route ?? [], edges[0], boxes, buildBoxIndex(boxes)),
    ).toEqual([]);
  });

  test("детерминизм: два прогона — идентичные полилинии", async () => {
    const Avoid = await loadAvoid();
    const boxes: RouteBox[] = [
      { id: "a", kind: "leaf", parent: null, x: 0, y: 0, w: 60, h: 60 },
      { id: "w", kind: "leaf", parent: null, x: 200, y: -40, w: 80, h: 140 },
      { id: "b", kind: "leaf", parent: null, x: 500, y: 0, w: 60, h: 60 },
    ];
    const edges: RouteEdge[] = [{ id: "e", from: "a", to: "b" }];
    const { classes } = classifyEdges(boxes, edges);
    const opts = { bufferDistance: 12, nudgeDistance: 16, pinsPerSide: 2 };
    const r1 = routeClasses(Avoid, boxes, classes, opts).get("e");
    const r2 = routeClasses(Avoid, boxes, classes, opts).get("e");
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
```

ВНИМАНИЕ: если `new URL(..., import.meta.url)` в bun-тесте не резолвится в реальный файл
(путь от src/canvas → apps/frontend/node_modules), починить путь по факту расположения
`libavoid-js` (проверка: `ls apps/frontend/node_modules/libavoid-js/dist/libavoid.wasm`).
В bun node-entry грузит wasm сам — `AvoidLib.load(wasmUrl)` с web-URL допустимо игнорится
node-веткой; тест выше валиден в обоих случаях.

- [ ] **Step 3: тесты + commit**

Run: `cd apps/frontend && bun test src/canvas/libavoid-router.test.ts && bun run typecheck`
Expected: PASS (2 теста, WASM реально загружен).

```bash
git add apps/frontend/src/canvas/libavoid-router.ts apps/frontend/src/canvas/libavoid-router.test.ts
git commit -m "feat(layout): libavoid-обёртка — lazy WASM, exclusive-пины, классы V-H (DRW-199 T3)"
```

---

### Task 4: edge-routing — оркестратор (сбор боксов, гейт, writeback-план, отчёт)

**Files:**
- Create: `apps/frontend/src/canvas/edge-routing.ts`
- Create: `apps/frontend/src/canvas/edge-routing.test.ts`

- [ ] **Step 1: оркестратор**

```typescript
// apps/frontend/src/canvas/edge-routing.ts
// DRW-199: оркестратор edge-routing-пасса. Читает editor, зовёт чистое ядро и
// libavoid-обёртку, применяет гейт и пишет binding'и/props одной транзакцией.
import type { Editor, TLShapeId } from "tldraw";
import {
  anchorFor,
  assignPorts,
  buildBoxIndex,
  candidateBeatsCurrent,
  classifyEdges,
  countPolylineCrossings,
  foreignCrossings,
  planTransfer,
  type Polyline,
  polylineLength,
  type RouteBox,
  type RouteEdge,
  type RouteMetrics,
} from "./edge-routing-core";
import { loadAvoid, routeClasses } from "./libavoid-router";

export interface EdgeRoutingReport {
  routed: number;
  approximated: string[];
  skipped: string[];
  alignedKept: number;
  /** Детуры: лучший достижимый кандидат всё ещё пересекает чужие боксы. */
  inexpressible: Array<{ edgeId: string; foreignBest: number; foreignRoute: number }>;
}

export interface EdgeRoutingOpts {
  readonly alignedEdges?: ReadonlySet<string>; // ключи "from>to" из Ф2
  readonly pinsPerSide?: number;
}

const BUFFER_DISTANCE = 12;
const NUDGE_DISTANCE = 16;

/** Сбор RouteBox'ов scope'а: geo → leaf, schema-container → container.
 * parent = ближайший schema-container-предок В SCOPE, иначе null. */
export function collectRouteBoxes(
  editor: Editor,
  inScope: ReadonlySet<string>,
): RouteBox[] {
  const out: RouteBox[] = [];
  for (const id of inScope) {
    const shape = editor.getShape(id as TLShapeId);
    if (!shape) continue;
    const type = (shape as { type: string }).type;
    if (type !== "geo" && type !== "schema-container") continue;
    const b = editor.getShapePageBounds(id as TLShapeId);
    if (!b) continue;
    let parent: string | null = null;
    let curParent = (shape as { parentId?: string }).parentId;
    while (curParent && inScope.has(curParent)) {
      const p = editor.getShape(curParent as TLShapeId);
      if (!p) break;
      if ((p as { type: string }).type === "schema-container") {
        parent = curParent;
        break;
      }
      curParent = (p as { parentId?: string }).parentId;
    }
    out.push({
      id,
      kind: type === "schema-container" ? "container" : "leaf",
      parent,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
    });
  }
  return out;
}

/** Текущий фактический маршрут стрелки: вершины геометрии в page-space. */
export function currentArrowPolyline(
  editor: Editor,
  arrowId: string,
): Polyline | null {
  const shape = editor.getShape(arrowId as TLShapeId);
  if (!shape) return null;
  const geom = editor.getShapeGeometry(arrowId as TLShapeId);
  const transform = editor.getShapePageTransform(arrowId as TLShapeId);
  if (!geom || !transform) return null;
  const verts = geom.vertices.map((v) => {
    const p = transform.applyToPoint(v);
    return [p.x, p.y] as const;
  });
  return verts.length >= 2 ? verts : null;
}

export async function runEdgeRoutingPass(
  editor: Editor,
  inScope: ReadonlySet<string>,
  byArrow: Record<string, { start?: string; end?: string }>,
  opts: EdgeRoutingOpts = {},
): Promise<EdgeRoutingReport | null> {
  const Avoid = await loadAvoid();
  if (!Avoid) return null;

  const boxes = collectRouteBoxes(editor, inScope);
  const byId = buildBoxIndex(boxes);

  const report: EdgeRoutingReport = {
    routed: 0,
    approximated: [],
    skipped: [],
    alignedKept: 0,
    inexpressible: [],
  };

  const edges: RouteEdge[] = [];
  for (const [aid, t] of Object.entries(byArrow)) {
    if (!t.start || !t.end) continue;
    if (!inScope.has(aid)) continue;
    if (!byId.has(t.start) || !byId.has(t.end)) continue;
    if (opts.alignedEdges?.has(`${t.start}>${t.end}`)) {
      report.alignedKept++;
      continue; // выровненные Ф2 линии не трогаем (спека §3)
    }
    edges.push({ id: aid, from: t.start, to: t.end });
  }
  if (edges.length === 0) return report;

  const { classes, skipped } = classifyEdges(boxes, edges);
  report.skipped = skipped.map((e) => e.id);

  const routes = routeClasses(Avoid, boxes, classes, {
    bufferDistance: BUFFER_DISTANCE,
    nudgeDistance: NUDGE_DISTANCE,
    pinsPerSide: opts.pinsPerSide ?? 3,
  });

  // Метрики: edgeCross считаем против остальных НОВЫХ маршрутов (согласованная картина)
  const routedEdges = edges.filter((e) => routes.has(e.id));
  const metricsFor = (edge: RouteEdge, pts: Polyline): RouteMetrics => {
    let edgeCross = 0;
    for (const other of routedEdges) {
      if (other.id === edge.id) continue;
      const op = routes.get(other.id);
      if (op) edgeCross += countPolylineCrossings(pts, op);
    }
    return {
      foreign: foreignCrossings(pts, edge, boxes, byId).length,
      edgeCross,
      length: polylineLength(pts),
    };
  };

  // Решения per ребро: какие применяем
  const applied = new Map<string, { plan: ReturnType<typeof planTransfer>; route: Polyline }>();
  for (const e of routedEdges) {
    const route = routes.get(e.id);
    const src = byId.get(e.from);
    const dst = byId.get(e.to);
    if (!route || !src || !dst) continue;
    const current = currentArrowPolyline(editor, e.id);
    const plan = planTransfer(route, src, dst);
    if (plan.kind === "U" || plan.kind === "detour") {
      // T6 добавит arc-кандидата; до тех пор — пометка невыразимости
      const routeM = metricsFor(e, route);
      const bestM = current ? metricsFor(e, current) : routeM;
      report.inexpressible.push({
        edgeId: e.id,
        foreignBest: bestM.foreign,
        foreignRoute: routeM.foreign,
      });
      continue;
    }
    const candM = metricsFor(e, route);
    const curM = current ? metricsFor(e, current) : null;
    if (curM && !candidateBeatsCurrent(candM, curM)) {
      report.skipped.push(e.id);
      continue;
    }
    applied.set(e.id, { plan, route });
  }

  // Раздача портов по применяемым маршрутам
  const appliedEdges = routedEdges.filter((e) => applied.has(e.id));
  const appliedRoutes = new Map(
    appliedEdges.map((e) => [e.id, applied.get(e.id)?.route as Polyline]),
  );
  const assignments = assignPorts(appliedRoutes, appliedEdges, byId);

  // Writeback одной транзакцией: anchors + elbowMidPoint
  const bindRecs = editor.store.allRecords().filter((r) => {
    const x = r as { typeName: string; type?: string };
    return x.typeName === "binding" && x.type === "arrow";
  }) as unknown as Array<{
    id: string;
    fromId: string;
    props: Record<string, unknown> & { terminal: "start" | "end" };
  }>;
  const bindByKey = new Map(
    bindRecs.map((b) => [`${b.fromId}|${b.props.terminal}`, b]),
  );

  editor.run(() => {
    for (const a of assignments) {
      for (const port of a.ports) {
        const bind = bindByKey.get(`${port.edgeId}|${port.terminal}`);
        if (!bind) continue;
        editor.store.update(bind.id as Parameters<typeof editor.store.update>[0], (rec) => ({
          ...rec,
          props: {
            ...(rec as { props: object }).props,
            normalizedAnchor: anchorFor(a.side, port.frac),
            isPrecise: true,
          },
        }));
      }
    }
    for (const [edgeId, { plan }] of applied) {
      if (plan.kind === "Z" && plan.elbowMidPoint !== undefined) {
        editor.updateShape({
          id: edgeId as TLShapeId,
          type: "arrow",
          props: { kind: "elbow", elbowMidPoint: plan.elbowMidPoint },
        });
      } else {
        editor.updateShape({
          id: edgeId as TLShapeId,
          type: "arrow",
          props: { kind: "elbow" },
        });
      }
      report.routed++;
    }
  });

  return report;
}
```

- [ ] **Step 2: юниты оркестратора** — `collectRouteBoxes` и гейт-логика на fake-editor (паттерн `growWrappersForShapes`-тестов из DRW-232: минимальный editor-объект с `getShape`/`getShapePageBounds`). Тестировать: (а) сбор боксов с parent-цепочкой schema-container; (б) aligned-рёбра идут в `alignedKept` и не роутятся; (в) U/detour попадают в `inexpressible`, штатные — в `routed` (роутер мокается переданной картой маршрутов — для этого выделить из `runEdgeRoutingPass` чистую функцию `decideEdges(boxes, edges, routes, currents)` и тестировать её; рефактор допустим). Минимум 6 тестов.

- [ ] **Step 3: тесты + typecheck + commit**

Run: `cd apps/frontend && bun test src/canvas/edge-routing.test.ts && bun run typecheck`
Expected: PASS.

```bash
git add apps/frontend/src/canvas/edge-routing.ts apps/frontend/src/canvas/edge-routing.test.ts
git commit -m "feat(layout): edge-routing оркестратор — гейт, раздача портов, writeback, отчёт (DRW-199 T4)"
```

---

### Task 5: интеграция в elk-layout за dev-флагом + live-smoke

**Files:**
- Modify: `apps/frontend/src/canvas/elk-layout.ts` (~строки 1701 и 1015)

- [ ] **Step 1: фрейм-scope** — заменить пару вызовов на:

```typescript
const routingEnabled =
  typeof window !== "undefined" &&
  (window as { __SHEMMA_EDGE_ROUTING?: boolean }).__SHEMMA_EDGE_ROUTING === true;
const routingReport = routingEnabled
  ? await runEdgeRoutingPass(editor, inGraph, byArrow, {
      alignedEdges: alignedEdgesSet ?? undefined,
    })
  : null;
if (routingReport) {
  (window as { __SHEMMA_LAST_ROUTING?: unknown }).__SHEMMA_LAST_ROUTING =
    routingReport;
} else {
  distributeArrowPorts(editor, inGraph, byArrow, frameDir, alignedEdgesSet);
  optimizeScopedElbows(editor, inGraph, byArrow);
}
```

`import { runEdgeRoutingPass } from "./edge-routing";` добавить к импортам.

- [ ] **Step 2: контейнер-scope (~1015)** — то же без `alignedEdges` (там alignedEdgesSet нет):
fallback `distributeArrowPorts(editor, inScope, byArrow, dir); optimizeScopedElbows(editor, inScope, byArrow);` остаётся как есть.

- [ ] **Step 3: smoke юнитов всего frontend**

Run: `cd apps/frontend && bun test src && bun run typecheck`
Expected: все зелёные (747+ новых), 0 fail.

- [ ] **Step 4: live-smoke (КООРДИНАТОР, не сабагент)** — dev-стенд `SHEMMA_PROFILE=dev bun run dev`; в браузере (chrome-devtools) на комнате drw-235-probe: `window.__SHEMMA_EDGE_ROUTING = true` → выделить фрейм → ⌘⌥⇧L (синтетический KeyboardEvent) → проверить `window.__SHEMMA_LAST_ROUTING` (routed > 0), стрелки визуально не сломаны, скриншот. При сломанной нормировке `elbowMidPoint` (риск спеки §11) — поправить формулу в `planTransfer` по фактическому рендеру.

- [ ] **Step 5: commit**

```bash
git add apps/frontend/src/canvas/elk-layout.ts
git commit -m "feat(layout): edge-routing включён в оба scope за флагом __SHEMMA_EDGE_ROUTING (DRW-199 T5)"
```

---

### Task 6: детур-кандидаты (arc-bend) + финал отчёта пасса

**Files:**
- Modify: `apps/frontend/src/canvas/edge-routing-core.ts` (+arc-геометрия)
- Modify: `apps/frontend/src/canvas/edge-routing.ts` (кандидаты в решение)
- Modify: `apps/frontend/src/canvas/edge-routing-core.test.ts`

- [ ] **Step 1: arc-кандидат в ядре**

```typescript
/** Сэмплирует круговую дугу tldraw (bend = сагитта от середины хорды) в полилинию. */
export function sampleArc(
  start: RoutePoint,
  end: RoutePoint,
  bend: number,
  samples = 16,
): Polyline {
  const [x1, y1] = start;
  const [x2, y2] = end;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  // нормаль к хорде; вершина дуги = середина + normal * bend
  const nx = -dy / len;
  const ny = dx / len;
  const apex: RoutePoint = [mx + nx * bend, my + ny * bend];
  // квадратичная Безье через apex — достаточная аппроксимация дуги для метрик
  const pts: RoutePoint[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const a = 1 - t;
    pts.push([
      a * a * x1 + 2 * a * t * apex[0] + t * t * x2,
      a * a * y1 + 2 * a * t * apex[1] + t * t * y2,
    ]);
  }
  return pts;
}

/** Пересечения сэмплированной (не-ortho) полилинии с боксами: проверка по точкам внутри. */
export function sampledForeignCrossings(
  points: Polyline,
  edge: RouteEdge,
  boxes: ReadonlyArray<RouteBox>,
  byId: ReadonlyMap<string, RouteBox>,
): string[] {
  const skip = new Set([edge.from, edge.to]);
  for (const a of ancestorsOf(byId, edge.from)) skip.add(a);
  for (const a of ancestorsOf(byId, edge.to)) skip.add(a);
  const hit: string[] = [];
  for (const b of boxes) {
    if (skip.has(b.id)) continue;
    const inside = points.some(
      ([x, y]) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h,
    );
    if (inside) hit.push(b.id);
  }
  return hit;
}

/** Подбор bend для детура: candidates ±[d, 1.5d, 2d], d = глубина маршрута libavoid
 * от хорды; первый без чужих пересечений, минимальный по |bend|. null — не нашёлся. */
export function pickArcBend(
  route: Polyline,
  edge: RouteEdge,
  boxes: ReadonlyArray<RouteBox>,
  byId: ReadonlyMap<string, RouteBox>,
): number | null {
  const start = route[0];
  const end = route[route.length - 1];
  // максимальное отклонение маршрута от хорды как стартовая глубина
  const [x1, y1] = start;
  const [x2, y2] = end;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  let depth = 0;
  for (const [px, py] of route) {
    const d = Math.abs(((px - x1) * dy - (py - y1) * dx) / len);
    depth = Math.max(depth, d);
  }
  if (depth === 0) return null;
  const candidates = [depth, -depth, depth * 1.5, -depth * 1.5, depth * 2, -depth * 2];
  for (const bend of candidates) {
    const arc = sampleArc(start, end, bend);
    if (sampledForeignCrossings(arc, edge, boxes, byId).length === 0) return bend;
  }
  return null;
}
```

- [ ] **Step 2: подключить в оркестратор** — в ветке `U | detour`: вызвать `pickArcBend(route, e, boxes, byId)`; если bend найден и (метрика arc-полилинии `sampledForeignCrossings`=0) строго лучше текущего маршрута по `candidateBeatsCurrent` → writeback `kind:"arc"`, `bend` (знак сверить с tldraw live в T7; у tldraw bend>0 — выпуклость по нормали слева от хорды) + анкоры из start/end сторон; ребро → `report.approximated`. Иначе — `inexpressible` (как в T4).

- [ ] **Step 3: юниты** — sampleArc симметрия и глубина apex; sampledForeignCrossings ловит точку внутри бокса; pickArcBend на сцене «детур ниже стены» находит bend, на сцене «обхода нет» возвращает null. Минимум 5 тестов.

- [ ] **Step 4: тесты + commit**

Run: `cd apps/frontend && bun test src/canvas && bun run typecheck`
Expected: PASS.

```bash
git add apps/frontend/src/canvas/edge-routing-core.ts apps/frontend/src/canvas/edge-routing.ts apps/frontend/src/canvas/edge-routing-core.test.ts
git commit -m "feat(layout): arc-кандидат для детуров + метрика невыразимости (DRW-199 T6)"
```

---

### Task 7: live-верификация AC (КООРДИНАТОР сам, chrome-devtools)

Без файлов — комнаты dev-стенда. Флаг `__SHEMMA_EDGE_ROUTING=true` в каждой вкладке.

- [ ] **Step 1: AC#1** — drw-235-probe, фрейм t218: ⌘⌥⇧L → 11 рёбер без пересечений с боксами; A3→E2 — либо arc-обход, либо в `__SHEMMA_LAST_ROUTING.inexpressible`. Скриншот → `docs/references/drw-199-probes/t7-ac1.png`.
- [ ] **Step 2: AC#2** — drw-235-probe2, v2-фрейм: 0 новых пересечений ребро-бокс; выровненные Ф2 линии целы (`alignedKept` > 0). Скриншот.
- [ ] **Step 3: AC#3** — синтетика «хаб + 3 цели» (создать узлы на тестовой комнате drw-199-live): порты не переплетаются, порядок портов = порядок целей. Скриншот.
- [ ] **Step 4: AC#4 идемпотентность** — повторный ⌘⇧L на свёрстанной probe-комнате: снапшот store до/после идентичен (сравнить JSON значимых полей x/y/anchors/midpoint).
- [ ] **Step 5: AC#5 детерминизм** — два прогона ⌘⌥⇧L с одного исходного состояния (undo между) дают идентичный результат.
- [ ] **Step 6: AC#6 пины/locked** — locked-фреймы a-elk-tree/dl-test нетронуты; pinned-узел держится.
- [ ] **Step 7: AC#7 prod-сборка** — `cd apps/frontend && bun run build` → в dist есть wasm-ассет; `bunx vite preview` (или открыть dist через release-демон) → пасс работает. Зафиксировать решение (URL-паттерн) в спеке.
- [ ] **Step 8: находки** — каждый дефект чинится немедленно (фикс+юнит), скриншоты в `docs/references/drw-199-probes/`.

---

### Task 8: закрытие — флаг долой, CHANGELOG, спека v1.1, Backlog

**Files:**
- Modify: `apps/frontend/src/canvas/elk-layout.ts` (убрать флаг — пасс по умолчанию, фоллбэк остаётся при `null` от loadAvoid)
- Modify: `CHANGELOG.md` (Unreleased)
- Modify: `docs/superpowers/specs/2026-06-12-layout-phase3-arrow-routing-design.md` (v1.1: фактическая реализация portHints-пункта = skip aligned рёбер; решение wasm-URL; отклонения T5/T7)

- [ ] **Step 1: снять флаг** — `routingEnabled` заменить на `true` (вызов всегда; деградация через `null` из `loadAvoid`). `__SHEMMA_LAST_ROUTING` оставить (диагностика).
- [ ] **Step 2: полный прогон**

Run: `cd apps/frontend && bun test src && bun run typecheck && cd ../.. && bun run lint`
Expected: 0 fail; lint-дельта по затронутым файлам 0.

- [ ] **Step 3: CHANGELOG** — bullet в Unreleased: edge-routing пасс (libavoid-as-layout-hint), V-H, порты, метрик-гейт, отчёт пасса, число новых юнитов.
- [ ] **Step 4: спека v1.1 + Backlog** — `backlog task edit DRW-199 --check-ac …` по факту, notes с результатами live; задача остаётся In Progress до приёмки юзером.
- [ ] **Step 5: commit**

```bash
git add -A apps/frontend/src/canvas CHANGELOG.md docs/superpowers/specs/2026-06-12-layout-phase3-arrow-routing-design.md
git commit -m "feat(layout): edge-routing по умолчанию + CHANGELOG + спека v1.1 (DRW-199 T8)"
```

СТОП после T8: live-приёмка юзером → squash + merge --no-ff (политика merge-needs-acceptance). Релиз/push — только по явному сигналу.

---

## Self-review

1. **Spec coverage:** §2 V-H → T1; §3 пайплайн/lazy-WASM → T3-T5; §4 порты → T2/T4; §5 перенос+детуры → T2/T6; §6 гейт → T1/T4; §8 тест-план → T1-T4/T7; §9 AC → T7; §10 этапность соблюдена; §11 риски — нормировка midpoint (T5 step 4), знак bend (T6 step 2), перф (probe < 5мс, бюджет не закладываем отдельной задачей). Покрыто.
2. **Placeholder scan:** код полный в T1-T4/T6; T4 step 2 описывает тесты словами с явным рефактор-указанием (`decideEdges`) — осознанное исключение, исполнитель имеет паттерн fake-editor из DRW-232-тестов. T5/T7 — интеграция/live, код дан для вставки.
3. **Type consistency:** `RouteBox/RouteEdge/Polyline/Side` — единые из core; `assignPorts` использует те же `RouteEdge`; `routeClasses` принимает `RoutingClass` из `classifyEdges`. `anchorFor` совпадает по семантике с существующим `distributeArrowPorts.anchorFor`.
