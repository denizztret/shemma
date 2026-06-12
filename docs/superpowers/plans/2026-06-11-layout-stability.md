# Layout Stability (Фаза 1: DRW-218 + DRW-233) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Детерминированная и локальная раскладка: несвязные компоненты не деформируют друг друга, auto-direction не дрейфует, scope действия = subject (контейнер раскладывает только себя).

**Architecture:** Партиция root-графа на связные компоненты в нашем коде (новый чистый модуль `component-partition.ts`) → по одному ELK-прогону на компоненту → детерминированный пакинг поперёк направления. Auto-direction скорит только главную компоненту через чистую score-функцию (`direction-choice.ts`) с «липким чемпионом» (`frame.meta.didrawDirectionResolved`). Scope-резолвер (`layout-scope.ts`) направляет триггеры: один выделенный контейнер → изолированная внутренняя раскладка + DRW-232 grow-механики.

**Tech Stack:** TypeScript strict, Bun workspace, elkjs 0.11.1 (frontend, lazy singleton), tldraw 5.x, bun:test (ELK в bun-тестах НЕ запускается — юниты только на чистые функции), Biome.

**Спека:** `docs/superpowers/specs/2026-06-11-layout-stability-design.md`
**Ветка:** `feature/layout-stability` (уже создана, спека закоммичена)

**Контрольные команды:**
- Юниты файла: `bun --cwd apps/frontend test src/canvas/component-partition.test.ts`
- Все frontend-тесты: `bun --cwd apps/frontend test src` (база: 680 pass, 0 fail)
- Typecheck: `bun --cwd apps/frontend run typecheck`
- Все тесты репо: `bun run test` (из корня); линт: `bun run lint`

**Известные грабли (НЕ нарушать):**
- elkjs нельзя инстанцировать в bun-тестах (`elk()` ленивый — НЕ вызывать на module level и не импортировать elk-пути в тестах напрямую; чистые функции из `elk-layout.ts` импортируются безопасно).
- `git stash pop` не использовать; lint-дельту мерять против `git show HEAD:file`.
- Комнаты `draw-test-1`, `a-engine-compare-elk` — юзерские, НЕ менять. Эталоны `a-elk-tree`, `dl-test` — читать/раскладывать копии можно, оригинальные locked-фреймы не трогать.
- Коммиты без trailer'ов (`Co-Authored-By` и т.п.), короткий imperative.

---

### Task 0: Backlog-статусы

**Files:** нет (backlog CLI)

- [ ] **Step 1: Перевести задачи в In Progress**

```bash
backlog task edit DRW-218 -s "In Progress"
backlog task edit DRW-233 -s "In Progress"
```

Expected: оба `task edit` выводят обновлённую карточку со статусом In Progress.

---

### Task 1: `component-partition.ts` — партиция и ранжирование

**Files:**
- Create: `apps/frontend/src/canvas/component-partition.ts`
- Test: `apps/frontend/src/canvas/component-partition.test.ts`

- [ ] **Step 1: Написать падающие тесты партиции и ранжирования**

```typescript
// apps/frontend/src/canvas/component-partition.test.ts
import { describe, expect, it } from "bun:test";
import {
  type ComponentInfo,
  partitionComponents,
  rankComponents,
} from "./component-partition";

describe("partitionComponents", () => {
  it("splits a graph into connected components by collapsed edges", () => {
    const comps = partitionComponents(
      ["a", "b", "c", "d", "e"],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "d", to: "e" },
      ],
    );
    expect(comps).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
  });

  it("keeps isolated nodes as singleton components", () => {
    const comps = partitionComponents(["a", "b"], []);
    expect(comps).toEqual([["a"], ["b"]]);
  });

  it("ignores edges with endpoints outside the id set (cross-frame)", () => {
    const comps = partitionComponents(
      ["a", "b"],
      [{ from: "a", to: "ghost" }],
    );
    expect(comps).toEqual([["a"], ["b"]]);
  });

  it("is deterministic: same input → same output, ids keep input order", () => {
    const ids = ["n3", "n1", "n2"];
    const edges = [{ from: "n2", to: "n3" }];
    const first = partitionComponents(ids, edges);
    expect(partitionComponents(ids, edges)).toEqual(first);
    expect(first).toEqual([["n3", "n2"], ["n1"]]);
  });
});

describe("rankComponents", () => {
  const info = {
    boxA: { leaves: 4, area: 1000 },
    boxB: { leaves: 4, area: 2000 },
    geo1: { leaves: 1, area: 100 },
    geo2: { leaves: 1, area: 100 },
  };

  it("main component = most leaves", () => {
    const ranked = rankComponents([["geo1"], ["boxA", "geo2"]], info);
    expect(ranked[0]!.ids).toEqual(["boxA", "geo2"]);
    expect(ranked[0]!.leaves).toBe(5);
  });

  it("tie-break by total area, then by first id (lexicographic)", () => {
    const byArea = rankComponents([["boxA"], ["boxB"]], info);
    expect(byArea[0]!.ids).toEqual(["boxB"]); // 2000 > 1000
    const byId = rankComponents([["geo2"], ["geo1"]], info);
    expect(byId[0]!.ids).toEqual(["geo1"]); // equal leaves+area → min id
  });

  it("repeated call returns identical order (determinism)", () => {
    const comps = [["geo1"], ["boxB"], ["boxA"], ["geo2"]];
    const a = rankComponents(comps, info);
    const b = rankComponents(comps, info);
    expect(a.map((c: ComponentInfo) => c.ids)).toEqual(
      b.map((c: ComponentInfo) => c.ids),
    );
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `bun --cwd apps/frontend test src/canvas/component-partition.test.ts`
Expected: FAIL — `Cannot find module './component-partition'`.

- [ ] **Step 3: Реализовать `partitionComponents` + `rankComponents`**

```typescript
// apps/frontend/src/canvas/component-partition.ts
/**
 * Connected-component layer of the frame layout (DRW-218).
 *
 * ELK's own `separateConnectedComponents` packs disconnected components by the
 * AGGREGATE bbox — any edit to one component shifts the others. This module
 * makes the split explicit and deterministic: WE partition the collapsed root
 * graph, ELK only ever sees one connected graph per run, and the components are
 * then placed by `packComponents` in a stable, input-independent order.
 *
 * Pure functions, no Editor — unit-tested exhaustively.
 */

export type ComponentInfo = {
  /** Top-level ids (container boxes + loose geo), in input order. */
  ids: string[];
  /** Total leaf nodes across the component (containers count their children). */
  leaves: number;
  /** Total input box area — ranking tie-break. */
  area: number;
};

/**
 * Union-find over the collapsed root edges. Components come out in first-id
 * input order; ids inside a component keep the input order — fully
 * deterministic for identical input.
 */
export function partitionComponents(
  topLevelIds: ReadonlyArray<string>,
  edges: ReadonlyArray<{ from: string; to: string }>,
): string[][] {
  const index = new Map<string, number>();
  topLevelIds.forEach((id, i) => index.set(id, i));
  const parent = topLevelIds.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    let c = i;
    while (parent[c] !== r) {
      const next = parent[c]!;
      parent[c] = r;
      c = next;
    }
    return r;
  };
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a == null || b == null) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  const groups = new Map<number, string[]>();
  topLevelIds.forEach((id, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(id);
    else groups.set(r, [id]);
  });
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids);
}

/**
 * Rank components: most leaves first (the "main" schema), tie-broken by total
 * area, then by the lexicographically smallest first id. Index 0 = main.
 */
export function rankComponents(
  components: ReadonlyArray<ReadonlyArray<string>>,
  info: Readonly<Record<string, { leaves: number; area: number }>>,
): ComponentInfo[] {
  const enriched: ComponentInfo[] = components.map((ids) => {
    let leaves = 0;
    let area = 0;
    for (const id of ids) {
      leaves += info[id]?.leaves ?? 1;
      area += info[id]?.area ?? 0;
    }
    return { ids: [...ids], leaves, area };
  });
  return enriched.sort(
    (a, b) =>
      b.leaves - a.leaves ||
      b.area - a.area ||
      (a.ids[0]! < b.ids[0]! ? -1 : 1),
  );
}
```

- [ ] **Step 4: Запустить тесты — зелёные**

Run: `bun --cwd apps/frontend test src/canvas/component-partition.test.ts`
Expected: PASS (8 тестов).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/canvas/component-partition.ts apps/frontend/src/canvas/component-partition.test.ts
git commit -m "feat(layout): партиция root-графа на связные компоненты + ранжирование (DRW-218)"
```

---

### Task 2: `component-partition.ts` — strays, пакинг, подграфы

**Files:**
- Modify: `apps/frontend/src/canvas/component-partition.ts` (дописать в конец)
- Test: `apps/frontend/src/canvas/component-partition.test.ts` (дописать)

- [ ] **Step 1: Написать падающие тесты splitStrays / packComponents / buildComponentGraphs**

```typescript
// дописать в apps/frontend/src/canvas/component-partition.test.ts
import {
  buildComponentGraphs,
  packComponents,
  splitStrays,
} from "./component-partition";

describe("splitStrays", () => {
  const ci = (ids: string[]): ComponentInfo => ({ ids, leaves: 0, area: 0 });
  const isGeo = (id: string) => id.startsWith("geo");

  it("collects singleton GEO components into strays, keeps the rest", () => {
    const { real, strays } = splitStrays(
      [ci(["boxA", "geo9"]), ci(["geo1"]), ci(["boxB"]), ci(["geo2"])],
      isGeo,
    );
    expect(real.map((c) => c.ids)).toEqual([["boxA", "geo9"], ["boxB"]]);
    expect(strays).toEqual(["geo1", "geo2"]);
  });

  it("a lone container is a REAL component, not a stray", () => {
    const { real, strays } = splitStrays([ci(["boxA"])], isGeo);
    expect(real.map((c) => c.ids)).toEqual([["boxA"]]);
    expect(strays).toEqual([]);
  });
});

describe("packComponents", () => {
  const boxes = [
    { w: 400, h: 300 }, // main
    { w: 100, h: 80 },
    { w: 120, h: 50 },
  ];

  it("TB frame: secondaries stack in a column to the RIGHT of the main", () => {
    const off = packComponents(boxes, "TB", 20);
    expect(off).toEqual([
      { dx: 0, dy: 0 },
      { dx: 420, dy: 0 }, // main.w + gap
      { dx: 420, dy: 100 }, // prev.h + gap accumulated
    ]);
  });

  it("LR frame: secondaries stack in a row BELOW the main", () => {
    const off = packComponents(boxes, "LR", 20);
    expect(off).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 320 }, // main.h + gap
      { dx: 120, dy: 320 }, // prev.w + gap accumulated
    ]);
  });

  it("BT behaves like TB, RL like LR (same cross axis)", () => {
    expect(packComponents(boxes, "BT", 20)).toEqual(
      packComponents(boxes, "TB", 20),
    );
    expect(packComponents(boxes, "RL", 20)).toEqual(
      packComponents(boxes, "LR", 20),
    );
  });

  it("single component → only the zero offset", () => {
    expect(packComponents([{ w: 10, h: 10 }], "TB", 20)).toEqual([
      { dx: 0, dy: 0 },
    ]);
  });
});

describe("buildComponentGraphs", () => {
  it("routes each root edge into its owning component's graph", () => {
    const comps: ComponentInfo[] = [
      { ids: ["a", "b"], leaves: 2, area: 0 },
      { ids: ["c", "d"], leaves: 2, area: 0 },
    ];
    const graphs = buildComponentGraphs(comps, [
      { id: "a>b", sources: ["a"], targets: ["b"] },
      { id: "c>d", sources: ["c"], targets: ["d"] },
    ]);
    expect(graphs[0]!.ids).toEqual(["a", "b"]);
    expect(graphs[0]!.edges.map((e) => e.id)).toEqual(["a>b"]);
    expect(graphs[1]!.edges.map((e) => e.id)).toEqual(["c>d"]);
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `bun --cwd apps/frontend test src/canvas/component-partition.test.ts`
Expected: FAIL — `splitStrays is not exported` (или аналог).

- [ ] **Step 3: Реализовать**

```typescript
// дописать в apps/frontend/src/canvas/component-partition.ts

/**
 * A "stray" is a singleton component consisting of one loose GEO node — a note
 * dropped next to the schema. Strays are merged into ONE pseudo-component
 * (flow-chained along the frame direction by the caller) instead of each
 * becoming its own cross-axis component. A lone CONTAINER is a real schema —
 * never a stray.
 */
export function splitStrays(
  ranked: ReadonlyArray<ComponentInfo>,
  isStrayEligible: (id: string) => boolean,
): { real: ComponentInfo[]; strays: string[] } {
  const real: ComponentInfo[] = [];
  const strays: string[] = [];
  for (const c of ranked) {
    if (c.ids.length === 1 && isStrayEligible(c.ids[0]!)) {
      strays.push(c.ids[0]!);
    } else {
      real.push(c);
    }
  }
  return { real, strays };
}

export type PackedOffset = { dx: number; dy: number };

/**
 * Deterministic component placement: the main component (index 0) keeps its
 * ELK coordinates; the rest stack ACROSS the frame's flow axis in ranked order —
 * TB/BT frame → a column to the RIGHT of the main bbox, LR/RL → a row BELOW it.
 * Reads as "a separate schema beside the flow", never as its continuation.
 */
export function packComponents(
  boxes: ReadonlyArray<{ w: number; h: number }>,
  frameDir: string,
  gap: number,
): PackedOffset[] {
  if (boxes.length === 0) return [];
  const out: PackedOffset[] = [{ dx: 0, dy: 0 }];
  const main = boxes[0]!;
  const verticalFlow = frameDir === "TB" || frameDir === "BT";
  let cursor = 0;
  for (let i = 1; i < boxes.length; i++) {
    const b = boxes[i]!;
    if (verticalFlow) {
      out.push({ dx: main.w + gap, dy: cursor });
      cursor += b.h + gap;
    } else {
      out.push({ dx: cursor, dy: main.h + gap });
      cursor += b.w + gap;
    }
  }
  return out;
}

export type ComponentGraph = {
  ids: string[];
  edges: Array<{ id: string; sources: string[]; targets: string[] }>;
};

/** Split the collapsed root edge list per component (source decides ownership). */
export function buildComponentGraphs(
  components: ReadonlyArray<ComponentInfo>,
  rootEdges: ReadonlyArray<{ id: string; sources: string[]; targets: string[] }>,
): ComponentGraph[] {
  const componentOf = new Map<string, number>();
  components.forEach((c, i) => {
    for (const id of c.ids) componentOf.set(id, i);
  });
  const out: ComponentGraph[] = components.map((c) => ({
    ids: [...c.ids],
    edges: [],
  }));
  for (const e of rootEdges) {
    const i = componentOf.get(e.sources[0] ?? "");
    if (i != null) out[i]!.edges.push(e);
  }
  return out;
}
```

- [ ] **Step 4: Запустить тесты — зелёные**

Run: `bun --cwd apps/frontend test src/canvas/component-partition.test.ts`
Expected: PASS (16 тестов).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/canvas/component-partition.ts apps/frontend/src/canvas/component-partition.test.ts
git commit -m "feat(layout): strays-псевдокомпонент, детерминированный пакинг поперёк направления, подграфы компонент"
```

---

### Task 3: `direction-choice.ts` — score, overlaps, липкий выбор

**Files:**
- Create: `apps/frontend/src/canvas/direction-choice.ts`
- Test: `apps/frontend/src/canvas/direction-choice.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```typescript
// apps/frontend/src/canvas/direction-choice.test.ts
import { describe, expect, it } from "bun:test";
import {
  countBoxOverlaps,
  pickDirectionCandidate,
  type PlanMetrics,
  planScore,
} from "./direction-choice";

const m = (over: Partial<PlanMetrics>): PlanMetrics => ({
  contentW: 100,
  contentH: 100,
  crossings: 0,
  overlaps: 0,
  ...over,
});

describe("planScore", () => {
  it("balanced plan scores its aspect extremity (1.0)", () => {
    expect(planScore(m({}))).toBe(1);
  });
  it("crossings add 0.15 each, overlaps add 0.5 each", () => {
    expect(planScore(m({ crossings: 2 }))).toBeCloseTo(1.3);
    expect(planScore(m({ overlaps: 1 }))).toBeCloseTo(1.5);
  });
  it("aspect extremity is orientation-agnostic (3:1 == 1:3)", () => {
    expect(planScore(m({ contentW: 300 }))).toBe(
      planScore(m({ contentH: 300 })),
    );
  });
});

describe("countBoxOverlaps", () => {
  it("counts intersecting pairs, ignores touching boxes", () => {
    const boxes = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 50, y: 50, w: 100, h: 100 }, // overlaps #0
      { x: 100, y: 0, w: 50, h: 50 }, // touches #0 → no overlap
    ];
    expect(countBoxOverlaps(boxes)).toBe(1);
  });
});

describe("pickDirectionCandidate", () => {
  it("keeps the incumbent on equal score (no drift)", () => {
    const winner = pickDirectionCandidate(
      { value: "TB", metrics: m({}) },
      [{ value: "LR", metrics: m({}) }],
    );
    expect(winner).toBe("TB");
  });
  it("switches only on STRICT improvement", () => {
    const winner = pickDirectionCandidate(
      { value: "TB", metrics: m({ contentW: 300 }) },
      [{ value: "LR", metrics: m({}) }],
    );
    expect(winner).toBe("LR");
  });
  it("a candidate colliding with pins loses despite better aspect", () => {
    const winner = pickDirectionCandidate(
      { value: "TB", metrics: m({ contentW: 220 }) }, // ratio 2.2
      [{ value: "LR", metrics: m({ overlaps: 4 }) }], // 1 + 2.0 = 3.0
    );
    expect(winner).toBe("TB");
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `bun --cwd apps/frontend test src/canvas/direction-choice.test.ts`
Expected: FAIL — `Cannot find module './direction-choice'`.

- [ ] **Step 3: Реализовать**

```typescript
// apps/frontend/src/canvas/direction-choice.ts
/**
 * Pure scoring for the aspect-aware auto-direction search (DRW-218 AC#6).
 *
 * score = aspectExtremity + 0.15·crossings + 0.5·overlaps. Overlaps are mostly
 * pinned nodes colliding with a candidate layout (pins are post-override — the
 * layout can't move them, so a candidate that lands on top of one must lose).
 *
 * `pickDirectionCandidate` implements the "sticky champion": the incumbent
 * (last auto-applied direction) wins ties — a candidate must be STRICTLY
 * better. With deterministic ELK this kills score-drift between runs.
 */

export type PlanMetrics = {
  contentW: number;
  contentH: number;
  crossings: number;
  overlaps: number;
};

export type Box = { x: number; y: number; w: number; h: number };

const CROSSING_WEIGHT = 0.15;
const OVERLAP_WEIGHT = 0.5;

export function planScore(m: PlanMetrics): number {
  const ratio = Math.max(m.contentW / m.contentH, m.contentH / m.contentW);
  return ratio + CROSSING_WEIGHT * m.crossings + OVERLAP_WEIGHT * m.overlaps;
}

/** Number of strictly-intersecting box pairs (shared edges don't count). */
export function countBoxOverlaps(boxes: ReadonlyArray<Box>): number {
  let n = 0;
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]!;
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j]!;
      if (
        a.x < b.x + b.w &&
        b.x < a.x + a.w &&
        a.y < b.y + b.h &&
        b.y < a.y + a.h
      ) {
        n++;
      }
    }
  }
  return n;
}

export function pickDirectionCandidate<T>(
  incumbent: { value: T; metrics: PlanMetrics },
  candidates: ReadonlyArray<{ value: T; metrics: PlanMetrics }>,
): T {
  let best = incumbent.value;
  let bestScore = planScore(incumbent.metrics);
  for (const c of candidates) {
    const s = planScore(c.metrics);
    if (s < bestScore) {
      bestScore = s;
      best = c.value;
    }
  }
  return best;
}
```

- [ ] **Step 4: Запустить тесты — зелёные**

Run: `bun --cwd apps/frontend test src/canvas/direction-choice.test.ts`
Expected: PASS (7 тестов).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/canvas/direction-choice.ts apps/frontend/src/canvas/direction-choice.test.ts
git commit -m "feat(layout): чистая score-функция auto-direction — overlap-term + липкий чемпион (DRW-218 AC#6)"
```

---

### Task 4: Интеграция партиции в `runElkLayout` step 2

**Files:**
- Modify: `apps/frontend/src/canvas/elk-layout.ts:860-930` (step 2), `:936-992` (flip-пасс), `:994-1026` (dryRun), `:476-482` (`ElkLayoutResult`)
- Modify (поправка спеки): `docs/superpowers/specs/2026-06-11-layout-stability-design.md` §5.2

Тестовая стратегия задачи: сам ELK в bun не гоняется — корректность партиции/пакинга уже покрыта Task 1-3; здесь критерий = существующая сюита остаётся зелёной + typecheck чист. Живое поведение — Task 11.

- [ ] **Step 1: Расширить `ElkLayoutResult.plan` полем `overlaps`**

В `elk-layout.ts:480` заменить:

```typescript
  | { kind: "plan"; contentW: number; contentH: number; crossings: number }
```

на:

```typescript
  | {
      kind: "plan";
      contentW: number;
      contentH: number;
      crossings: number;
      overlaps: number;
    }
```

- [ ] **Step 2: Добавить импорты в `elk-layout.ts`**

К существующим импортам файла добавить:

```typescript
import {
  buildComponentGraphs,
  type ComponentGraph,
  type ComponentInfo,
  packComponents,
  partitionComponents,
  rankComponents,
  splitStrays,
} from "./component-partition";
import { type Box, countBoxOverlaps } from "./direction-choice";
```

- [ ] **Step 3: Заменить единый root-прогон на пер-компонентные**

В `runElkLayout`, внутри существующего `try` (строки 861-916): блок от комментария `// ---- step 2: the frame lays the container boxes...` до `res = await elk().layout(rootGraph);` включительно заменить (сборка `rootChildren`, `rootSeen`/`rootEdges` из схлопнутых рёбер ОСТАЁТСЯ как есть; убирается только старая `__root__` flow-цепочка, `rootGraph` и `res`). Объявление `let res: ElkNode;` перед `try` удалить. Новый код после сборки `rootEdges`:

```typescript
    // ---- DRW-218: partition into connected components; ELK only ever sees a
    // CONNECTED graph (separateConnectedComponents would otherwise pack the
    // components by aggregate bbox — editing one shifts the others). ----
    const topLevelIds = rootChildren.map((n) => n.id);
    if (rootEdges.length === 0) {
      // Degenerate: nothing is connected at the root → ONE pseudo-component
      // flow-chained along the frame direction. Preserves the established UX
      // for both "frame of loose notes" and "frame of unconnected containers"
      // (spec §5.2 amendment): they line up ALONG the direction, no cross-axis
      // stacking when there is no main schema to stack against.
      componentInfos = [{ ids: topLevelIds, leaves: 0, area: 0 }];
      componentGraphs = [
        {
          ids: topLevelIds,
          edges: buildFlowChainEdges({ __strays__: topLevelIds }, new Set()),
        },
      ];
    } else {
      const info: Record<string, { leaves: number; area: number }> = {};
      for (const c of containerShapes) {
        const bs = boxSize[c.id]!;
        info[c.id] = {
          leaves: containerKidsMap[c.id]!.length,
          area: bs.w * bs.h,
        };
      }
      for (const n of rootChildren) {
        if (info[n.id]) continue; // container already counted
        info[n.id] = {
          leaves: 1,
          area: (n.width ?? 0) * (n.height ?? 0),
        };
      }
      const realEdgePairs = rootEdges.map((e) => ({
        from: e.sources[0]!,
        to: e.targets[0]!,
      }));
      const ranked = rankComponents(
        partitionComponents(topLevelIds, realEdgePairs),
        info,
      );
      const geoIds = new Set(looseGeo.map((g) => g.id as string));
      const { real, strays } = splitStrays(ranked, (id) => geoIds.has(id));
      componentInfos = [...real];
      componentGraphs = buildComponentGraphs(real, rootEdges);
      if (strays.length > 0) {
        // All stray notes form one trailing pseudo-component, chained along
        // the frame direction (last in the cross-axis stack).
        componentInfos.push({ ids: strays, leaves: strays.length, area: 0 });
        componentGraphs.push({
          ids: strays,
          edges: buildFlowChainEdges({ __strays__: strays }, new Set()),
        });
      }
    }
    // dryRun (auto-direction search) prices ONLY the main component — secondary
    // components follow the frame direction and never influence the choice (AC#2).
    const runCount = opts?.dryRun ? 1 : componentGraphs.length;
    const nodeById = new Map(rootChildren.map((n) => [n.id, n]));
    const componentLayouts = await Promise.all(
      componentGraphs.slice(0, runCount).map((g) =>
        elk().layout({
          id: "root",
          layoutOptions: {
            "elk.algorithm": algorithm,
            "elk.direction": rootElkDir,
            "elk.edgeRouting": "ORTHOGONAL",
            "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
            "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
            "elk.layered.thoroughness": "12",
            // The graph is connected by construction; pin the option anyway so
            // a future regression can't silently re-enable ELK's own packing.
            "elk.separateConnectedComponents": "false",
            "elk.spacing.nodeNode": String(sp.nodeNode),
            "elk.spacing.edgeNode": String(sp.edgeNode),
            "elk.spacing.edgeEdge": String(sp.edgeEdge),
            "elk.layered.spacing.nodeNodeBetweenLayers": String(sp.between),
            "elk.layered.spacing.edgeNodeBetweenLayers": String(sp.edgeNode),
            "elk.layered.spacing.edgeEdgeBetweenLayers": String(sp.edgeEdge),
          },
          children: g.ids
            .map((id) => nodeById.get(id))
            .filter((n): n is ElkNode => !!n),
          edges: g.edges,
        }),
      ),
    );
    // Deterministic cross-axis packing: main keeps its coords, secondaries
    // stack across the flow axis in ranked order, gap = component spacing.
    const offsets = packComponents(
      componentLayouts.map((r) => ({ w: r.width ?? 0, h: r.height ?? 0 })),
      frameDir,
      sp.comp,
    );
    componentLayouts.forEach((res, i) => {
      const off = offsets[i]!;
      for (const c of res.children ?? []) {
        flat[c.id] = {
          x: (c.x ?? 0) + off.dx,
          y: (c.y ?? 0) + off.dy,
          w: c.width,
          h: c.height,
        };
      }
    });
```

После `catch` старый цикл `for (const c of res.children ?? []) { flat[...] }` (строки 927-929) удалить — позиции уже записаны выше.

`componentInfos` нужен ниже flip-пассу и dryRun — объявить ДО `try` (рядом с `flat`):

```typescript
  // Ranked components (index 0 = main) — set in step 2, read by the flip pass
  // (per-component crossings) and the dryRun metrics (main-only scoring).
  let componentInfos: ComponentInfo[] = [];
  let componentGraphs: ComponentGraph[] = [];
```

(в сниппете Step 3 присваивания уже без `let` — рассчитаны на это hoisted-объявление).

- [ ] **Step 4: Ограничить flip-пасс своей компонентой**

В flip-блоке (строки 936-992): после объявления `scopedEdges` добавить карту компонент и параметризовать `countCrossings`:

```typescript
    const componentOfTop = new Map<string, number>();
    componentInfos.forEach((ci, i) => {
      for (const id of ci.ids) componentOfTop.set(id, i);
    });
    const edgeComponent = (e: { from: string; to: string }): number | undefined =>
      componentOfTop.get(ownerOf[e.from] ?? "");
    const countCrossings = (comp?: number): number => {
      const segs = scopedEdges
        .filter((e) => comp == null || edgeComponent(e) === comp)
        .map((e) => {
          const a = absCenter(flat, ownerOf, e.from);
          const b = absCenter(flat, ownerOf, e.to);
          return a && b ? { a, b, from: e.from, to: e.to } : null;
        })
        .filter((s): s is CrossSeg => s !== null);
      return countStraightCrossings(segs);
    };
```

В цикле по контейнерам заменить замер:

```typescript
      const comp = componentOfTop.get(cid);
      const before = countCrossings(comp);
      mirrorContainer(cid);
      if (countCrossings(comp) >= before) mirrorContainer(cid); // no gain → revert
```

- [ ] **Step 5: dryRun-метрики — только главная компонента + overlaps**

Блок `if (opts?.dryRun)` (строки 998-1026) заменить целиком:

```typescript
  if (opts?.dryRun) {
    // Metrics over the MAIN component only (flat holds just it in dryRun) —
    // a secondary schema must not influence the direction choice (AC#2).
    const mainIds = new Set(componentInfos[0]?.ids ?? []);
    let minx = Number.POSITIVE_INFINITY;
    let miny = Number.POSITIVE_INFINITY;
    let maxx = Number.NEGATIVE_INFINITY;
    let maxy = Number.NEGATIVE_INFINITY;
    const planBoxes: Box[] = [];
    for (const s of scopeNodes) {
      const id = s.id as string;
      if (!mainIds.has(id)) continue;
      const p = flat[id];
      if (!p) continue;
      minx = Math.min(minx, p.x);
      miny = Math.min(miny, p.y);
      maxx = Math.max(maxx, p.x + (p.w ?? 0));
      maxy = Math.max(maxy, p.y + (p.h ?? 0));
      // Pinned tops are post-override: the metric must see their FROZEN spot,
      // not the planned one — handled below; skip them here.
      if (!forceUnpin && s.meta?.pinned) continue;
      planBoxes.push({ x: p.x, y: p.y, w: p.w ?? 0, h: p.h ?? 0 });
    }
    for (const s of scopeNodes) {
      if (forceUnpin || !s.meta?.pinned) continue;
      const sz = effectiveSizeFromProps(s);
      planBoxes.push({ x: s.x, y: s.y, w: sz.w, h: sz.h });
    }
    const overlaps = countBoxOverlaps(planBoxes);
    const mainEdgeIds = (e: { from: string; to: string }): boolean =>
      mainIds.has(ownerOf[e.from] ?? "") && mainIds.has(ownerOf[e.to] ?? "");
    const segs = nodeEdges
      .filter((e) => inGraph.has(e.from) && inGraph.has(e.to) && mainEdgeIds(e))
      .map((e) => {
        const a = absCenter(flat, ownerOf, e.from);
        const b = absCenter(flat, ownerOf, e.to);
        return a && b ? { a, b, from: e.from, to: e.to } : null;
      })
      .filter((s): s is CrossSeg => s !== null);
    const crossings = countStraightCrossings(segs);
    return {
      kind: "plan",
      contentW: Math.max(1, Number.isFinite(minx) ? maxx - minx : 1),
      contentH: Math.max(1, Number.isFinite(miny) ? maxy - miny : 1),
      crossings,
      overlaps,
    };
  }
```

- [ ] **Step 6: Поправка спеки §5.2 (вырожденный случай)**

В `docs/superpowers/specs/2026-06-11-layout-stability-design.md` §5.2 заменить третий буллет:

```markdown
- Вырожденный случай «во фрейме нет НИ ОДНОГО ребра на корне» (только несвязанные узлы и/или контейнеры) → ВСЕ top-level элементы образуют единственный псевдо-компонент с flow-цепочкой вдоль направления — текущее поведение «несвязанные дети выстраиваются по направлению» (квик-фаза S6 rebuild) сохранено и для контейнеров. Поперечная стопка включается только когда есть настоящая главная компонента (≥1 ребро).
```

- [ ] **Step 7: Typecheck + полная сюита**

Run: `bun --cwd apps/frontend run typecheck && bun --cwd apps/frontend test src`
Expected: typecheck чист; 696+ pass / 0 fail (680 базовых + новые из Task 1-3).

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/canvas/elk-layout.ts docs/superpowers/specs/2026-06-11-layout-stability-design.md
git commit -m "feat(layout): пер-компонентные ELK-прогоны + детерминированный пакинг, flip/score в пределах компоненты (DRW-218 AC#1)"
```

---

### Task 5: `autoLayoutFrame` — липкий чемпион, inherited-eligibility, параллельные кандидаты

**Files:**
- Modify: `apps/frontend/src/canvas/elk-layout.ts:1312-1396` (`autoLayoutFrame`)

- [ ] **Step 1: Добавить импорт и helper записи resolved-направления**

Импорт (к блоку из Task 4): добавить `pickDirectionCandidate` в импорт из `./direction-choice`.

Перед `autoLayoutFrame` добавить:

```typescript
/**
 * Engine-owned memory of the last auto-applied frame direction — the "sticky
 * champion" of the aspect search (DRW-218 AC#2). history:"ignore": layout undo
 * восстанавливает позиции, а чемпион остаётся — иначе ⌘Z воскрешал бы дрейф.
 */
function writeResolvedDir(
  editor: Editor,
  frameId: TLShapeId,
  dir: string,
): void {
  const f = editor.getShape(frameId);
  if (!f || (f.meta?.didrawDirectionResolved as string | undefined) === dir)
    return;
  editor.run(
    () => {
      editor.updateShape({
        id: frameId,
        type: "frame",
        meta: { ...(f.meta ?? {}), didrawDirectionResolved: dir },
      } as never);
    },
    { history: "ignore" },
  );
}
```

- [ ] **Step 2: Переписать тело `autoLayoutFrame`**

Заменить функцию (строки 1322-1381) на:

```typescript
export async function autoLayoutFrame(
  editor: Editor,
  ids: TLShapeId[],
  opts?: { forceUnpin?: boolean; forceDirections?: boolean },
): Promise<ElkLayoutResult> {
  const frameId = selectionFrame(editor, ids) ?? fallbackFrame(editor);
  const frame = frameId ? editor.getShape(frameId) : null;
  const pinnedDir = frame?.meta?.didrawDirection as string | undefined;
  const inherited = frame?.meta?.didrawDirectionInherited === true;
  // Auto-direction only when there IS a frame and the user hasn't EXPLICITLY
  // pinned its direction. An import-inherited direction (marker set, AC#5)
  // stays auto-eligible — it seeds the incumbent below instead of disabling
  // the search. Frameless / locked → runElkLayout decides as before.
  if (!frame || !frameId || (pinnedDir && !inherited)) {
    return runElkLayout(editor, ids, opts);
  }

  // Incumbent (sticky champion): the last auto-applied direction, else the
  // imported one, else the default. Candidates must STRICTLY beat it.
  const base =
    (frame.meta?.didrawDirectionResolved as string | undefined) ||
    pinnedDir ||
    DEFAULT_FRAME_DIR;
  const perp = perpendicular(base);
  const ratioOf = (p: { contentW: number; contentH: number }): number =>
    Math.max(p.contentW / p.contentH, p.contentH / p.contentW);
  const applyConfig = async (
    dir: string,
    mode: InheritMode,
  ): Promise<ElkLayoutResult> => {
    const r = await runElkLayout(editor, ids, {
      ...opts,
      frameDirOverride: dir,
      inheritMode: mode,
    });
    if (r.kind === "ok") writeResolvedDir(editor, frameId, dir);
    return r;
  };

  const basePlan = await runElkLayout(editor, ids, {
    ...opts,
    frameDirOverride: base,
    inheritMode: "auto",
    dryRun: true,
  });
  // Fast path: a balanced incumbent is applied verbatim — no search, no drift.
  if (basePlan.kind !== "plan" || ratioOf(basePlan) <= ASPECT_SEARCH_THRESHOLD) {
    return applyConfig(base, "auto");
  }

  // Lopsided → search; candidates dry-run in parallel (perf, AC#6) and are
  // priced on the MAIN component only (runElkLayout dryRun, AC#2).
  const candidates: Array<{ dir: string; mode: InheritMode }> = [
    { dir: perp, mode: "auto" },
    { dir: base, mode: "perp" },
    { dir: perp, mode: "perp" },
  ];
  const plans = await Promise.all(
    candidates.map((c) =>
      runElkLayout(editor, ids, {
        ...opts,
        frameDirOverride: c.dir,
        inheritMode: c.mode,
        dryRun: true,
      }),
    ),
  );
  const winner = pickDirectionCandidate(
    { value: { dir: base, mode: "auto" as InheritMode }, metrics: basePlan },
    candidates.flatMap((c, i) => {
      const p = plans[i];
      return p && p.kind === "plan" ? [{ value: c, metrics: p }] : [];
    }),
  );
  return applyConfig(winner.dir, winner.mode);
}
```

- [ ] **Step 3: Typecheck + сюита**

Run: `bun --cwd apps/frontend run typecheck && bun --cwd apps/frontend test src`
Expected: чисто / 0 fail. (Сам поиск live-проверяется в Task 11: повторные ⌘⇧L не меняют направление.)

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/canvas/elk-layout.ts
git commit -m "feat(layout): auto-direction — липкий чемпион didrawDirectionResolved + inherited-eligibility + параллельный поиск (DRW-218 AC#2/5/6)"
```

---

### Task 6: Backend — import-маркер направления фрейма (AC#5)

**Files:**
- Modify: `apps/backend/src/routes/schema.ts:381-415` (`makeFrameShape`), `:730` (callsite)
- Test: `apps/backend/src/routes/schema.test.ts` (дописать)

- [ ] **Step 1: Написать падающий тест**

В `apps/backend/src/routes/schema.test.ts` найти существующий тест `"subgraph WITHOUT explicit direction gets meta.didrawDirectionInherited=true"` (строка ~1323) и рядом с ним (тот же describe, та же обвязка создания) добавить:

```typescript
test("schema frame records the imported top-level direction as INHERITED", async () => {
  const res = await fetch(`${baseUrl}/api/schema?space=${space}&room=${room}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw: "flowchart LR\n  a[A] --> b[B]" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; frameId: string };
  expect(body.ok).toBe(true);
  const state = await fetch(
    `${baseUrl}/api/state?space=${space}&room=${room}`,
  ).then((r) => r.json() as Promise<{ records: Array<Record<string, any>> }>);
  const frame = state.records.find((r) => r.id === body.frameId);
  expect(frame?.meta?.didrawDirection).toBe("LR");
  expect(frame?.meta?.didrawDirectionInherited).toBe(true);
});
```

NB: точную обвязку (`baseUrl`/`space`/`room`, формат `/api/state`) скопировать из соседних тестов этого файла — там уже есть POST `/api/schema` + чтение стора; тест выше привести к их фактическому хелперу.

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `bun --cwd apps/backend test src/routes/schema.test.ts`
Expected: FAIL на `expect(frame?.meta?.didrawDirection).toBe("LR")` — поле отсутствует.

- [ ] **Step 3: Реализовать**

`makeFrameShape` (строка 381): добавить в opts поле `direction?: string` и в `meta`:

```typescript
function makeFrameShape(opts: {
  frameId: string;
  label: string;
  raw: string;
  position: { x: number; y: number };
  parentId: string;
  direction?: string;
}): TLRecord {
```

…и в литерале `meta` (после `didrawOverlays: {}`):

```typescript
      // DRW-218 AC#5: the imported top-level direction is recorded as
      // INHERITED — the frontend lays the frame out along it, but the
      // aspect-aware auto-direction stays eligible to re-infer it. An explicit
      // user pick in the UI clears the marker (SchemaContainerActions).
      ...(opts.direction
        ? {
            didrawDirection: opts.direction === "TD" ? "TB" : opts.direction,
            didrawDirectionInherited: true,
          }
        : {}),
```

Callsite (строка 730) — пробросить переменную `direction`, уже находящуюся в scope (используется строкой выше в `generateMermaid({ actions: parsedActions, direction })`):

```typescript
      const frameShape = makeFrameShape({ frameId, label, raw, position, parentId: pageId, direction });
```

- [ ] **Step 4: Запустить — зелёный + сюита backend**

Run: `bun --cwd apps/backend test src/routes/schema.test.ts && bun --cwd apps/backend test`
Expected: новый тест PASS; backend-сюита (1227+) 0 fail. Если существующие тесты зафиксировали отсутствие `didrawDirection` у фрейма — обновить их ожидания (поведение меняется осознанно, AC#5).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/schema.ts apps/backend/src/routes/schema.test.ts
git commit -m "feat(schema): импорт пишет direction фрейма с маркером inherited — auto-direction остаётся eligible (DRW-218 AC#5)"
```

---

### Task 7: UI — явный выбор направления фрейма чистит маркеры

**Files:**
- Modify: `apps/frontend/src/shapes/schema-container/SchemaContainerActions.ts:91-103` (frame-ветка)
- Modify: `apps/frontend/src/settings/SettingsPopover.tsx:868-883` (frame «•»)

- [ ] **Step 1: frame-ветка `setContainerDirection` — чистить `didrawDirectionInherited` + `didrawDirectionResolved`**

Заменить frame-ветку (строки 91-103):

```typescript
      if (shape.type === "frame") {
        const meta = (shape.meta ?? {}) as Record<string, unknown>;
        const markerSet =
          meta.didrawDirectionInherited === true ||
          meta.didrawDirectionResolved != null;
        if (meta.didrawDirection !== direction || markerSet) {
          // Explicit user pick: pin the direction AND clear the import-inherited
          // marker + the engine's last-resolved champion — auto-direction must
          // not re-infer a frame the user именно что закрепил (DRW-218 AC#5).
          editor.updateShape({
            id: shape.id,
            type: "frame",
            meta: {
              ...meta,
              didrawDirection: direction,
              didrawDirectionInherited: false,
              didrawDirectionResolved: null,
            },
          } as never);
        }
        accepted.push(id);
        continue;
      }
```

- [ ] **Step 2: frame «•» (сброс в auto) — чистить и `didrawDirectionResolved`**

В `SettingsPopover.tsx` (строки ~869-877, ветка `if (allFrames && d === "custom")`) заменить запись меты:

```typescript
              editor.updateShape({
                id: s.id as unknown as TLShapeId,
                type: "frame",
                // «•» = "пере-выбери сам": снять и направление, и липкого
                // чемпиона — иначе авто-поиск стартует с прежнего resolved.
                meta: {
                  ...(sh?.meta ?? {}),
                  didrawDirection: null,
                  didrawDirectionResolved: null,
                },
              } as never);
```

- [ ] **Step 3: Typecheck + сюита**

Run: `bun --cwd apps/frontend run typecheck && bun --cwd apps/frontend test src`
Expected: чисто / 0 fail.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/shapes/schema-container/SchemaContainerActions.ts apps/frontend/src/settings/SettingsPopover.tsx
git commit -m "feat(layout): явный выбор направления фрейма чистит inherited/resolved-маркеры; «•» сбрасывает чемпиона"
```

---

### Task 8: `layout-scope.ts` — резолвер scope триггеров

**Files:**
- Create: `apps/frontend/src/canvas/layout-scope.ts`
- Test: `apps/frontend/src/canvas/layout-scope.test.ts`
- Modify: `apps/frontend/src/canvas/elk-layout.ts:484-534` (перенос `ancestorFrame`/`selectionFrame`/`fallbackFrame` + импорт)

- [ ] **Step 1: Написать падающие тесты (fake editor, по образцу `growWrappersForShapes`-тестов в `elk-layout.test.ts`)**

```typescript
// apps/frontend/src/canvas/layout-scope.test.ts
import { describe, expect, it } from "bun:test";
import type { Editor, TLShape, TLShapeId } from "tldraw";
import { resolveLayoutScope } from "./layout-scope";

// Minimal fake: enough for getShape / getCurrentPageShapes walks.
function fakeEditor(shapes: Array<Partial<TLShape> & { id: string }>): Editor {
  const byId = new Map(shapes.map((s) => [s.id, s as TLShape]));
  return {
    getShape: (id: TLShapeId) => byId.get(id as string),
    getCurrentPageShapes: () => [...byId.values()],
    getViewportPageBounds: () => ({ center: { x: 0, y: 0 } }),
    getShapePageBounds: () => undefined,
  } as unknown as Editor;
}

const frame = { id: "shape:f1", type: "frame", parentId: "page:1", meta: {} };
const container = (id: string, parentId: string) => ({
  id,
  type: "schema-container",
  parentId,
  props: {},
  meta: {},
});
const geo = (id: string, parentId: string) => ({
  id,
  type: "geo",
  parentId,
  meta: {},
});

describe("resolveLayoutScope", () => {
  it("exactly one selected schema-container → container scope (DRW-233)", () => {
    const ed = fakeEditor([frame, container("shape:c1", "shape:f1")]);
    expect(resolveLayoutScope(ed, ["shape:c1" as TLShapeId])).toEqual({
      kind: "container",
      containerId: "shape:c1",
    });
  });

  it("a selected leaf inside a frame → frame scope", () => {
    const ed = fakeEditor([frame, geo("shape:g1", "shape:f1")]);
    expect(resolveLayoutScope(ed, ["shape:g1" as TLShapeId])).toEqual({
      kind: "frame",
      frameId: "shape:f1",
    });
  });

  it("multi-selection that includes a container → frame scope (not container)", () => {
    const ed = fakeEditor([
      frame,
      container("shape:c1", "shape:f1"),
      geo("shape:g1", "shape:f1"),
    ]);
    expect(
      resolveLayoutScope(ed, ["shape:c1", "shape:g1"] as TLShapeId[]),
    ).toEqual({ kind: "frame", frameId: "shape:f1" });
  });

  it("≥2 page-level nodes without a frame → loose scope", () => {
    const ed = fakeEditor([geo("shape:g1", "page:1"), geo("shape:g2", "page:1")]);
    expect(
      resolveLayoutScope(ed, ["shape:g1", "shape:g2"] as TLShapeId[]),
    ).toEqual({ kind: "loose", ids: ["shape:g1", "shape:g2"] });
  });

  it("page-level single container → container scope (frameless container)", () => {
    const ed = fakeEditor([container("shape:c1", "page:1")]);
    expect(resolveLayoutScope(ed, ["shape:c1" as TLShapeId])).toEqual({
      kind: "container",
      containerId: "shape:c1",
    });
  });

  it("empty selection + единственный фрейм → fallback frame scope", () => {
    const ed = fakeEditor([frame]);
    expect(resolveLayoutScope(ed, [])).toEqual({
      kind: "frame",
      frameId: "shape:f1",
    });
  });

  it("nothing layoutable → none with a reason", () => {
    const ed = fakeEditor([]);
    const r = resolveLayoutScope(ed, []);
    expect(r.kind).toBe("none");
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `bun --cwd apps/frontend test src/canvas/layout-scope.test.ts`
Expected: FAIL — модуль не существует.

- [ ] **Step 3: Создать `layout-scope.ts` (перенос хелперов из `elk-layout.ts`)**

Функции `ancestorFrame` (elk-layout.ts:485-495), `selectionFrame` (:502-508), `fallbackFrame` (:515-530) ПЕРЕНЕСТИ сюда дословно (с их doc-комментариями), сделать `export`. В `elk-layout.ts` удалить их и импортировать из `./layout-scope` (`childrenOf` остаётся в elk-layout). Новый модуль:

```typescript
// apps/frontend/src/canvas/layout-scope.ts
import type { Editor, TLShape, TLShapeId } from "tldraw";

// … сюда переносятся ancestorFrame / selectionFrame / fallbackFrame (export) …

/**
 * Scope = subject (DRW-233 / DRW-218 AC#7): что выделено, то и раскладывается.
 *   - ровно один schema-container → его содержимое (даже page-level);
 *   - иначе фрейм выделения → весь фрейм;
 *   - иначе ≥2 page-level узлов → frameless loose;
 *   - иначе fallback-фрейм (viewport/единственный);
 *   - иначе none.
 */
export type LayoutScope =
  | { kind: "frame"; frameId: TLShapeId }
  | { kind: "container"; containerId: TLShapeId }
  | { kind: "loose"; ids: TLShapeId[] }
  | { kind: "none"; reason: string };

export function resolveLayoutScope(
  editor: Editor,
  ids: TLShapeId[],
): LayoutScope {
  if (ids.length === 1) {
    const s = editor.getShape(ids[0]!);
    if (s?.type === "schema-container") {
      return { kind: "container", containerId: s.id };
    }
  }
  const frameId = selectionFrame(editor, ids);
  if (frameId) return { kind: "frame", frameId };
  const loose = ids
    .map((id) => editor.getShape(id))
    .filter(
      (s): s is TLShape =>
        !!s &&
        (s.type === "geo" || s.type === "schema-container") &&
        s.parentId.startsWith("page:"),
    );
  if (loose.length >= 2) return { kind: "loose", ids: loose.map((s) => s.id) };
  const fb = fallbackFrame(editor);
  if (fb) return { kind: "frame", frameId: fb };
  return {
    kind: "none",
    reason:
      "no schema frame found — select ≥2 connected nodes on the board, or draw a frame",
  };
}
```

- [ ] **Step 4: Запустить юниты + полную сюиту (перенос не сломал elk-layout)**

Run: `bun --cwd apps/frontend test src/canvas/layout-scope.test.ts && bun --cwd apps/frontend run typecheck && bun --cwd apps/frontend test src`
Expected: всё зелёное.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/canvas/layout-scope.ts apps/frontend/src/canvas/layout-scope.test.ts apps/frontend/src/canvas/elk-layout.ts
git commit -m "feat(layout): resolveLayoutScope — scope=subject, контейнер-выделение даёт container-scope (DRW-233)"
```

---

### Task 9: Контейнер-scope в `runElkLayout`

**Files:**
- Modify: `apps/frontend/src/canvas/elk-layout.ts` — извлечение `collectArrowEdges`/`distributeArrowPorts`/`optimizeScopedElbows`, новая `runContainerScoped`, диспетчеризация scope в начале `runElkLayout` (строки 680-720)

- [ ] **Step 1: Извлечь сборку рёбер в `collectArrowEdges`**

Инлайн-блок `runElkLayout` строк 769-788 (`byArrow` + `nodeEdges`) вынести в функцию рядом (код тот же, дословно):

```typescript
/** Arrow-binding map (arrowId → start/end shape) + node→node edge list. */
function collectArrowEdges(editor: Editor): {
  byArrow: Record<string, { start?: string; end?: string }>;
  nodeEdges: Array<{ from: string; to: string }>;
} {
  const byArrow: Record<string, { start?: string; end?: string }> = {};
  for (const r of editor.store.allRecords()) {
    const rec = r as {
      typeName: string;
      type?: string;
      fromId?: string;
      toId?: string;
      props?: { terminal?: string };
    };
    if (rec.typeName !== "binding" || rec.type !== "arrow") continue;
    const t = rec.props?.terminal;
    if (!rec.fromId || !rec.toId || (t !== "start" && t !== "end")) continue;
    const slot = byArrow[rec.fromId] ?? {};
    slot[t] = rec.toId;
    byArrow[rec.fromId] = slot;
  }
  const nodeEdges: Array<{ from: string; to: string }> = [];
  for (const t of Object.values(byArrow)) {
    if (t.start && t.end) nodeEdges.push({ from: t.start, to: t.end });
  }
  return { byArrow, nodeEdges };
}
```

В `runElkLayout` заменить блок на `const { byArrow, nodeEdges } = collectArrowEdges(editor);`.

- [ ] **Step 2: Извлечь порт-пасс и midpoint-пасс**

Блок строк 1145-1265 (порт-распределение, от `const flowV = …` до закрывающего `editor.run` с `bindingUpdates`) вынести в функцию `distributeArrowPorts(editor, inGraph, byArrow, flowDir)` — код дословно, `frameDir` заменяется параметром `flowDir`. Блок 1267-1297 (elbow-обстаклы) — в `optimizeScopedElbows(editor, inGraph, byArrow)`. В конце `runElkLayout` вызвать обе:

```typescript
  distributeArrowPorts(editor, inGraph, byArrow, frameDir);
  optimizeScopedElbows(editor, inGraph, byArrow);
```

Сигнатуры:

```typescript
function distributeArrowPorts(
  editor: Editor,
  inGraph: ReadonlySet<string>,
  byArrow: Record<string, { start?: string; end?: string }>,
  flowDir: string,
): void {
  const flowV = flowDir === "TB" || flowDir === "BT";
  // … остальной код блока без изменений …
}

function optimizeScopedElbows(
  editor: Editor,
  inGraph: ReadonlySet<string>,
  byArrow: Record<string, { start?: string; end?: string }>,
): void {
  // … код блока без изменений …
}
```

Run: `bun --cwd apps/frontend run typecheck && bun --cwd apps/frontend test src`
Expected: чисто (чистый рефактор).

- [ ] **Step 3: Реализовать `runContainerScoped`**

Добавить после `layoutContainerInternal`:

```typescript
/**
 * DRW-233: container scope — lay out ONLY the selected container's children
 * (its own dir/spacing/engine), then resolve the new box against the world via
 * the DRW-232 mechanics (push overlapping siblings + refit ancestors). The
 * frame's own arrangement, sibling containers and the frame direction decision
 * are NOT touched (DRW-218 AC#7 falls out constructively).
 */
async function runContainerScoped(
  editor: Editor,
  containerId: TLShapeId,
  opts?: { forceUnpin?: boolean; forceDirections?: boolean; dryRun?: boolean },
): Promise<ElkLayoutResult> {
  const container = editor.getShape(containerId);
  if (!container) return { kind: "noop", reason: "container vanished" };
  const frameId = ancestorFrame(editor, containerId);
  const frame = frameId ? editor.getShape(frameId) : null;
  if (frame?.meta?.didrawLocked) {
    return { kind: "noop", reason: "frame locked — unlock to re-layout" };
  }
  const kids = childrenOf(editor, containerId).filter((k) => k.type === "geo");
  if (kids.length === 0) {
    return { kind: "noop", reason: "container has no layoutable nodes" };
  }
  const forceUnpin = opts?.forceUnpin === true;
  const { byArrow, nodeEdges } = collectArrowEdges(editor);
  const frameDir =
    (frame?.meta?.didrawDirection as string) ||
    (frame?.meta?.didrawDirectionResolved as string) ||
    DEFAULT_FRAME_DIR;
  const kidIds = new Set(kids.map((k) => k.id as string));
  const dir = resolveContainerDir(
    container,
    kidIds,
    frameDir,
    nodeEdges,
    opts?.forceDirections === true,
  );
  const geoBaseW: Record<string, number> = {};
  let box: Awaited<ReturnType<typeof layoutContainerInternal>>;
  try {
    box = await layoutContainerInternal(container, kids, {
      editor,
      dir,
      frameSpacing: readSpacing(frame?.meta),
      nodeEdges,
      geoBaseW,
    });
  } catch (e) {
    return {
      kind: "error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (opts?.dryRun) {
    return {
      kind: "plan",
      contentW: Math.max(1, box.w),
      contentH: Math.max(1, box.h),
      crossings: 0,
      overlaps: 0,
    };
  }
  const updates: Record<string, unknown>[] = [];
  const affected: string[] = [];
  for (const [id, p] of Object.entries(box.childPos)) {
    const s = editor.getShape(id as TLShapeId);
    if (!s) continue;
    if (!forceUnpin && s.meta?.pinned) continue; // pin discipline as in the frame pass
    updates.push({ id, type: s.type, x: p.x, y: p.y });
    affected.push(id);
  }
  if (updates.length === 0) {
    return { kind: "noop", reason: "everything is pinned — nothing to lay out" };
  }
  editor.markHistoryStoppingPoint();
  withAutoFlipSuppressed(() =>
    editor.run(() => {
      editor.updateShapes(updates as never);
      if (forceUnpin || !container.meta?.didrawSizePinned) {
        editor.updateShape({
          id: containerId,
          type: container.type,
          props: { w: box.w, h: box.h },
        } as never);
      }
      // DRW-232 mechanics: push overlapping siblings aside (translation, not
      // re-layout) and refit ancestor wrappers around the new box.
      reflowAfterFit(editor, [containerId as string]);
    }),
  );
  // Re-anchor only the arrows fully inside this container (cross-scope arrows
  // keep their anchors — same invariant as the frame pass's inGraph filter).
  const inScope: ReadonlySet<string> = new Set<string>([
    ...kidIds,
    containerId as string,
  ]);
  distributeArrowPorts(editor, inScope, byArrow, dir);
  optimizeScopedElbows(editor, inScope, byArrow);
  return {
    kind: "ok",
    applied: updates.length,
    frameId: (frameId as string | null) ?? "",
    affected: [...affected, containerId as string],
  };
}
```

- [ ] **Step 4: Диспетчеризация scope в `runElkLayout` и `autoLayoutFrame`**

Начало `runElkLayout` (блок строк 680-720, от комментария `// Scope priority…` до `const scopeNodes…`) заменить на:

```typescript
  const scope = resolveLayoutScope(editor, ids);
  if (scope.kind === "none") return { kind: "noop", reason: scope.reason };
  if (scope.kind === "container") {
    return runContainerScoped(editor, scope.containerId, opts);
  }
  const frameId = scope.kind === "frame" ? scope.frameId : null;
  const looseNodes: TLShape[] =
    scope.kind === "loose"
      ? scope.ids
          .map((id) => editor.getShape(id))
          .filter((s): s is TLShape => !!s)
      : [];
  const frame = frameId ? editor.getShape(frameId) : null;
  if (frameId) {
    if (!frame) return { kind: "noop", reason: "frame vanished" };
    // Lock: a locked frame ignores ALL layout — even forceUnpin.
    if (frame.meta?.didrawLocked) {
      return { kind: "noop", reason: "frame locked — unlock to re-layout" };
    }
  }
  const scopeNodes: TLShape[] = frameId
    ? childrenOf(editor, frameId)
    : looseNodes;
```

В `autoLayoutFrame` (Task 5) первой строкой добавить ранний выход на контейнер-scope (поиск направления — операция уровня фрейма):

```typescript
  const scopeProbe = resolveLayoutScope(editor, ids);
  if (scopeProbe.kind === "container") return runElkLayout(editor, ids, opts);
```

Импорт в `elk-layout.ts` дополнить: `import { ancestorFrame, fallbackFrame, type LayoutScope, resolveLayoutScope, selectionFrame } from "./layout-scope";` (фактический список — по použитым именам).

- [ ] **Step 5: Typecheck + полная сюита + линт**

Run: `bun --cwd apps/frontend run typecheck && bun --cwd apps/frontend test src && bun run lint`
Expected: всё чисто. Существующие вызовы (`App.tsx`, `SettingsPopover.tsx`) менять НЕ нужно: они передают выделение как есть, scope решается внутри.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/canvas/elk-layout.ts
git commit -m "feat(layout): контейнер-scope — изолированная раскладка выделенного контейнера + push/envelope соседей (DRW-233, DRW-218 AC#7)"
```

---

### Task 10: Node-харнесс идемпотентности (dev-инструмент, не CI)

**Files:**
- Create: `scratch/idempotence-harness.mjs` (scratch/ в .gitignore — артефакт не коммитится; результат фиксируется в notes задачи Backlog)

- [ ] **Step 1: Написать харнесс**

```javascript
// scratch/idempotence-harness.mjs — запускать ЧЕРЕЗ NODE (bun вешает elk-worker):
//   node scratch/idempotence-harness.mjs
// Проверяет конструктивные допущения спеки §9.2 на фикстурном графе:
//   1) детерминизм elkjs: два прогона одного графа → байт-в-байт координаты;
//   2) связный подграф + наш пакинг детерминированы при добавлении 2-й компоненты
//      (главная не сдвигается).
import ELK from "elkjs/lib/elk.bundled.js";

const elk = new ELK();
const opts = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.separateConnectedComponents": "false",
  "elk.spacing.nodeNode": "92",
  "elk.layered.spacing.nodeNodeBetweenLayers": "200",
};
const node = (id) => ({ id, width: 220, height: 80 });
const edge = (a, b) => ({ id: `${a}>${b}`, sources: [a], targets: [b] });
const main = {
  id: "root",
  layoutOptions: opts,
  children: ["a", "b", "c", "d", "e", "f"].map(node),
  edges: [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "e"), edge("d", "f"), edge("e", "f")],
};
const coords = (res) =>
  JSON.stringify((res.children ?? []).map((c) => [c.id, c.x, c.y, c.width, c.height]));

const r1 = await elk.layout(structuredClone(main));
const r2 = await elk.layout(structuredClone(main));
const deterministic = coords(r1) === coords(r2);
console.log("ELK determinism (same graph twice):", deterministic ? "PASS" : "FAIL");
if (!deterministic) process.exit(1);

// Вторая компонента раскладывается ОТДЕЛЬНЫМ прогоном — главная не участвует.
const second = {
  id: "root",
  layoutOptions: opts,
  children: ["x", "y", "z"].map(node),
  edges: [edge("x", "y"), edge("y", "z")],
};
const r3 = await elk.layout(structuredClone(main)); // прогон ПОСЛЕ другого графа
await elk.layout(structuredClone(second));
const r4 = await elk.layout(structuredClone(main));
const stable = coords(r3) === coords(r1) && coords(r4) === coords(r1);
console.log("Main component unaffected by other runs:", stable ? "PASS" : "FAIL");
process.exit(stable ? 0 : 1);
```

- [ ] **Step 2: Запустить и зафиксировать результат**

Run: `node scratch/idempotence-harness.mjs`
Expected: обе строки `PASS`, exit 0. Результат (вывод + дата) записать в notes:

```bash
backlog task edit DRW-218 --notes "node-харнесс идемпотентности (spec §9.2): ELK determinism PASS, main-component stability PASS — $(date +%F)"
```

(если `--notes` затирает существующие notes — использовать `backlog task edit DRW-218 --append-notes` при наличии такого флага; проверить `backlog task edit --help`.)

---

### Task 11: Live-верификация (ВЫПОЛНЯЕТ КООРДИНАТОР, не сабагент)

**Files:** нет (chrome-devtools MCP + dev-стенд)

Политика: визуальную проверку делает main-агент сам через chrome-devtools MCP (зафиксированный процесс: отчётам сабагентов о visual-верификации не доверять). Сабагентам эту задачу НЕ делегировать.

- [ ] **Step 1: Поднять dev-стенд** — `SHEMMA_PROFILE=dev bun run dev` (vite :5173 + backend :8788), открыть вкладку через chrome-devtools.

- [ ] **Step 2: Фикстура-репро DRW-218 (AC#3)** — создать тест-комнату `drw-218-stability` (space `di-draw`): схема A (4 контейнера, ≥10 узлов, связная) + НЕсвязная цепочка B из 5 узлов в том же фрейме. Сценарии:
  - (а) ⌘⇧L → B встаёт ПОПЕРЁК направления фрейма, A не сдвинулась ни на пиксель (сравнить координаты узлов A до/после через `evaluate_script`);
  - (б) повторные ⌘⇧L ×3 → ноль дрейфа (координаты идентичны);
  - (в) смена направления ОДНОГО контейнера A → изменились только его внутренности (+ возможный envelope-push), направление фрейма и соседние контейнеры не изменились;
  - (г) выделить контейнер → «Упорядочить» → разложился только он (DRW-233 AC#1);
  - (д) выделить фрейм → «Упорядочить» → весь фрейм (DRW-233 AC#2);
  - (е) пин узла в зоне раскладки → кандидат с наездом проигрывает / пин держится.

- [ ] **Step 3: Эталоны (AC#4)** — комнаты `a-elk-tree`, `dl-test`: переразложить НЕ-locked копии, визуально сравнить до/после (скриншоты). Деградации нет = чисто, направления работают, контейнеры не расползлись. Locked-оригиналы НЕ трогать.

- [ ] **Step 4: Импорт-маркер (AC#5)** — импортировать `flowchart LR`-схему → фрейм лёг LR; ⌘⇧L на лопсайдной схеме → направление может переинфериться; явный выбор направления в панели → повторные ⌘⇧L держат выбор.

- [ ] **Step 5: Зафиксировать результаты** — скриншоты ключевых состояний, итоги по каждому сценарию в notes DRW-218/DRW-233. Тест-комнату `drw-218-stability` оставить до приёмки юзером, потом удалить.

---

### Task 12: Финализация

**Files:**
- Modify: `CHANGELOG.md` (секция Unreleased)

- [ ] **Step 1: CHANGELOG**

В `CHANGELOG.md` в секцию `## Unreleased` (создать по образцу прошлых записей, если нет) добавить:

```markdown
### Layout: стабильность и детерминизм (DRW-218, DRW-233)

- Несвязные компоненты фрейма раскладываются независимо и размещаются детерминированно поперёк направления (главная схема — первой); добавление второй схемы больше не перестраивает базовую.
- Auto-direction оценивает только главную компоненту и «липнет» к последнему выбору (`didrawDirectionResolved`): повторное «Упорядочить» не меняет направление без реального выигрыша.
- Импортированное mermaid-направление фрейма записывается как наследуемое (`didrawDirectionInherited`) — раскладка следует ему, но авто-выбор остаётся доступен; явный выбор в панели закрепляет направление.
- Расстановка с выделенным контейнером раскладывает только его содержимое (соседи отодвигаются, фрейм дорастает) — без перестройки всего фрейма.
- В score авто-выбора добавлен штраф за наезды на закреплённые узлы; кандидаты просчитываются параллельно.
```

- [ ] **Step 2: AC-чеклисты Backlog**

```bash
backlog task edit DRW-218 --check-ac 1 --check-ac 2 --check-ac 3 --check-ac 4 --check-ac 5 --check-ac 6 --check-ac 7
backlog task edit DRW-233 --check-ac 1 --check-ac 2 --check-ac 3 --check-ac 4
backlog task edit DRW-218 -s Done
backlog task edit DRW-233 -s Done
```

(точный флаг отметки AC проверить через `backlog task edit --help`; статусы Done — только после зелёного Task 11.)

- [ ] **Step 3: Полный прогон + коммит**

Run: `bun run test && bun run lint`
Expected: все пакеты 0 fail; lint-дельта по изменённым файлам = 0 (мерять против `git show HEAD:<file>`, НЕ через stash).

```bash
git add CHANGELOG.md
git commit -m "docs: changelog — layout-стабильность Фазы 1 (DRW-218, DRW-233)"
```

- [ ] **Step 4: Стоп-точка — приёмка юзера**

Merge в `main` / тег / релиз НЕ делать: финальная приёмка (live-тест юзером) обязательна перед merge. Сообщить юзеру о готовности с итогами Task 11.

---

## Зависимости задач

```
T0 → T1 → T2 → T3 → T4 → T5 → T7 ┐
                 T6 (backend, независима после T5-понимания, фактически — после T3) ┤→ T9 → T10 → T11 → T12
                 T8 (независима, нужна для T5/T9) ┘
```

Рекомендуемый порядок исполнения: T0, T1, T2, T3, T8, T4, T5, T6, T7, T9, T10, T11, T12. (T8 до T5, потому что T5 ссылается на resolveLayoutScope через ранний выход в T9-step4 — если исполняется строго по порядку T5 раньше T8/T9, ранний выход добавляется в T9, как и написано.)

## Что НЕ делает этот план (по спеке §3)

Cross-boundary ordering (DRW-235), port-ordering/obstacle routing (DRW-199), рекурсия вложенности (DRW-200), кеш компонент, ELK-playground (DRW-115) — следующие фазы.
