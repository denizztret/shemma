# Layout Фаза 2 — cross-boundary ordering + глобальное выравнивание (DRW-235) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Task 8 (live-верификация) выполняет координатор сам, НЕ сабагент** (policy: no-subagent-screenshot-trust).

**Goal:** порядок строк в контейнерах учитывает внешние связи, cross-container рёбра выпрямляются в линии (глобальная координация поперёк контейнеров), контейнеры обтягивают результат — без новых перекрытий и с сохранением всех гарантий Фазы 1.

**Architecture:** общий VPSC-решатель `solve1D` в `@shemma/domain` (блоки, fixed-переменные, отдельная проекция constraints) + рефактор frontend-пасса `global-align.ts` прототипа (ordering остаётся, итеративная эвристика заменяется solve1D, добавляются top-level separation, пины, ось-абстракция) + интеграция в `runElkLayout` без флага.

**Tech Stack:** TypeScript strict, Bun workspace, biome; тесты `bun:test`; прототип-базис: ветка `feature/drw-235-global-y-probe` (коммит `7678b1f`).

**Spec:** `docs/superpowers/specs/2026-06-12-layout-phase2-cross-boundary-design.md` v1.0 (принята юзером).

**Ветка:** работа продолжается на `feature/drw-235-global-y-probe` (прототип + спека уже в ней).

---

## Task 1: VPSC-ядро `solve1D` в `@shemma/domain`

**Files:**
- Create: `packages/shemma-domain/src/layout-solver.ts`
- Create: `packages/shemma-domain/src/layout-solver.test.ts`
- Modify: `packages/shemma-domain/src/index.ts` (добавить реэкспорт)

- [ ] **Step 1: Написать падающие тесты ядра**

`packages/shemma-domain/src/layout-solver.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { solve1D } from "./layout-solver";
import type {
  AlignmentGoal,
  SeparationConstraint,
  SolverVar,
} from "./layout-solver";

const v = (id: string, pos: number, size = 62, extra?: Partial<SolverVar>) =>
  ({ id, pos, size, ...extra }) as SolverVar;

describe("solve1D — проекция (constraints, без goals)", () => {
  it("ничего не двигает, если ограничения выполнены", () => {
    const r = solve1D(
      [v("a", 0), v("b", 200)],
      [{ left: "a", right: "b", gap: 108 }],
      [],
    );
    expect(r.a).toBeCloseTo(0, 4);
    expect(r.b).toBeCloseTo(200, 4);
  });

  it("раздвигает нарушенную пару с минимальным суммарным смещением (блок)", () => {
    // желаемые позиции совпадают → блок, центр сохраняется: a=-54, b=+54
    const r = solve1D(
      [v("a", 0), v("b", 0)],
      [{ left: "a", right: "b", gap: 108 }],
      [],
    );
    expect(r.b - r.a).toBeCloseTo(108, 4);
    expect((r.a + r.b) / 2).toBeCloseTo(0, 4);
  });

  it("цепочка из трёх — PAV-поведение (общий блок вокруг среднего)", () => {
    const r = solve1D(
      [v("a", 100), v("b", 100), v("c", 100)],
      [
        { left: "a", right: "b", gap: 100 },
        { left: "b", right: "c", gap: 100 },
      ],
      [],
    );
    expect(r.b - r.a).toBeCloseTo(100, 4);
    expect(r.c - r.b).toBeCloseTo(100, 4);
    expect(r.b).toBeCloseTo(100, 4); // центр блока = средневзвешенное желаний
  });

  it("fixed-переменная не двигается, движется сосед", () => {
    const r = solve1D(
      [v("a", 0, 62, { fixed: true }), v("b", 0)],
      [{ left: "a", right: "b", gap: 108 }],
      [],
    );
    expect(r.a).toBeCloseTo(0, 2);
    expect(r.b).toBeGreaterThanOrEqual(108 - 0.01);
  });
});

describe("solve1D — goals (выравнивание)", () => {
  it("пара без конфликтов сливается в одну координату", () => {
    const r = solve1D(
      [v("a", 0), v("b", 100)],
      [],
      [{ a: "a", b: "b" }],
    );
    expect(Math.abs(r.a - r.b)).toBeLessThan(0.5);
  });

  it("взаимная пара (погоня A3⇄E2): обе садятся на общую координату с учётом floor-ограничения", () => {
    // a заперт снизу ограничением floor→a (gap 260): партнёр обязан подняться к нему
    const r = solve1D(
      [v("floor", 0, 62, { fixed: true }), v("a", 260), v("b", 100)],
      [{ left: "floor", right: "a", gap: 260 }],
      [{ a: "a", b: "b" }],
    );
    expect(r.a).toBeGreaterThanOrEqual(260 - 0.01);
    expect(Math.abs(r.a - r.b)).toBeLessThan(0.5);
  });

  it("goal с offset: pos(a)+offA == pos(b)+offB", () => {
    const r = solve1D(
      [v("box", 0), v("n", 500)],
      [],
      [{ a: "box", b: "n", offsetA: 75 }], // желание: box+75 === n
    );
    expect(Math.abs(r.box + 75 - r.n)).toBeLessThan(0.5);
  });

  it("эталонная топология: три линии при separation внутри колонок", () => {
    // колонки-цепочки C1 (a1<a2<a3) и C4 (e1<e2), цели: a1–e1 (верх) и a3–e2;
    // у C4 две строки против трёх у C1 → e2 обязан «оторваться» от e1 вниз
    const vars = [
      v("a1", 75), v("a2", 183), v("a3", 291),
      v("e1", 100), v("e2", 208),
    ];
    const cons: SeparationConstraint[] = [
      { left: "a1", right: "a2", gap: 108 },
      { left: "a2", right: "a3", gap: 108 },
      { left: "e1", right: "e2", gap: 108 },
    ];
    const goals: AlignmentGoal[] = [
      { a: "a1", b: "e1" },
      { a: "a3", b: "e2" },
    ];
    const r = solve1D(vars, cons, goals);
    expect(Math.abs(r.a1 - r.e1)).toBeLessThan(0.5);
    expect(Math.abs(r.a3 - r.e2)).toBeLessThan(0.5);
    expect(r.e2 - r.e1).toBeGreaterThanOrEqual(108 - 0.01); // C4 «растянулся»
  });
});

describe("solve1D — детерминизм и устойчивость", () => {
  it("перестановка входа не меняет результат", () => {
    const vars = [v("a", 10), v("b", 40), v("c", 70)];
    const cons: SeparationConstraint[] = [
      { left: "a", right: "b", gap: 100 },
      { left: "b", right: "c", gap: 100 },
    ];
    const goals: AlignmentGoal[] = [{ a: "a", b: "c" }];
    const r1 = solve1D(vars, cons, goals);
    const r2 = solve1D(
      [...vars].reverse(),
      [...cons].reverse(),
      [...goals].reverse(),
    );
    for (const id of ["a", "b", "c"]) {
      expect(Math.abs(r1[id]! - r2[id]!)).toBeLessThan(1e-6);
    }
  });

  it("цикл в constraints не зацикливает и не роняет (вырожденный случай)", () => {
    const r = solve1D(
      [v("a", 0), v("b", 50)],
      [
        { left: "a", right: "b", gap: 100 },
        { left: "b", right: "a", gap: 100 },
      ],
      [],
    );
    expect(Number.isFinite(r.a)).toBe(true);
    expect(Number.isFinite(r.b)).toBe(true);
  });

  it("ссылки на неизвестные id игнорируются", () => {
    const r = solve1D(
      [v("a", 0)],
      [{ left: "a", right: "ghost", gap: 10 }],
      [{ a: "a", b: "ghost" }],
    );
    expect(r.a).toBeCloseTo(0, 4);
  });
});

describe("solve1D — интерфейс DRW-242 (overlap removal)", () => {
  it("снимает перекрытия минимальным смещением без goals", () => {
    // три бокса h=100 в одной точке; constraints из пересечения интервалов
    const vars = [v("a", 0, 100), v("b", 10, 100), v("c", 20, 100)];
    const cons: SeparationConstraint[] = [
      { left: "a", right: "b", gap: 100 },
      { left: "b", right: "c", gap: 100 },
      { left: "a", right: "c", gap: 200 },
    ];
    const r = solve1D(vars, cons, []);
    expect(r.b - r.a).toBeGreaterThanOrEqual(100 - 0.01);
    expect(r.c - r.b).toBeGreaterThanOrEqual(100 - 0.01);
    // центр масс сохранён (минимальное суммарное смещение)
    expect((r.a + r.b + r.c) / 3).toBeCloseTo(10, 1);
  });
});
```

- [ ] **Step 2: Прогнать — убедиться, что падают**

Run: `bun --cwd packages/shemma-domain test src/layout-solver.test.ts`
Expected: FAIL — `Cannot find module './layout-solver'`.

- [ ] **Step 3: Реализация `layout-solver.ts`**

```typescript
/**
 * solve1D — одномерный решатель «минимальное суммарное смещение при
 * separation-ограничениях» (VPSC, Dwyer/Marriott «Fast node overlap removal»)
 * с целями выравнивания. ОБЩИЙ для DRW-235 (глобальная координация строк)
 * и DRW-242 (2D-пуш / overlap removal). WebCola — референс алгоритма,
 * НЕ зависимость.
 *
 * Модель:
 *  - переменные = центры элементов по решаемой оси;
 *  - constraints: pos(right) − pos(left) ≥ gap (жёсткие);
 *  - goals: желание pos(a)+offsetA === pos(b)+offsetB (мягкие, веса);
 *  - fixed: переменная не двигается (вес BIG_WEIGHT + исходная позиция
 *    как желание).
 *
 * Алгоритм: внешний цикл «desired по goals (взвешенная медиана, включая
 * собственную позицию — гасит взаимную погоню пар) → project». project —
 * классический VPSC-satisfy: блоки с offset'ами, merge по нарушенным
 * ограничениям, позиция блока = взвешенное среднее желаний; конечность —
 * каждый merge уменьшает число блоков. Страховочный feasibility-пасс по
 * топопорядку закрывает вырожденные конфликты путей.
 *
 * Детерминизм: стабильные сортировки по id, Kahn с лексикографическим
 * tie-break, никакого рандома. Рёбра, замыкающие цикл, отбрасываются
 * детерминированно (вырожденный вход — best effort, не исключение).
 */

export interface SolverVar {
  id: string;
  /** стартовая координата ЦЕНТРА по решаемой оси */
  pos: number;
  /** протяжённость по оси — для построителей ограничений; сам решатель не использует */
  size: number;
  /** вес «желания» (остаться на месте / целей); по умолчанию 1 */
  weight?: number;
  /** pinned: позиция фактически не меняется */
  fixed?: boolean;
}

export interface SeparationConstraint {
  left: string;
  right: string;
  /** pos(right) − pos(left) ≥ gap; pos — центры */
  gap: number;
}

export interface AlignmentGoal {
  a: string;
  b: string;
  /** желание: pos(a) + offsetA === pos(b) + offsetB (по умолчанию 0) */
  offsetA?: number;
  offsetB?: number;
  weight?: number;
}

const BIG_WEIGHT = 1e9;
const EPS = 1e-6;
const MOVE_EPS = 0.01;
const DEFAULT_ROUNDS = 30;

interface Block {
  vars: string[];
  weight: number; // Σ w_i
  wsum: number; // Σ w_i · (desired_i − offset_i)
  pos: number; // wsum / weight
}

function weightedMedian(items: Array<{ v: number; w: number }>): number {
  const s = [...items].sort((p, q) => p.v - q.v);
  const total = s.reduce((acc, it) => acc + it.w, 0);
  let acc = 0;
  for (const it of s) {
    acc += it.w;
    if (acc >= total / 2) return it.v;
  }
  return s[s.length - 1]?.v ?? 0;
}

/** Kahn по constraint-графу; рёбра, замыкающие цикл, отброшены детерминированно. */
function topoOrder(
  ids: ReadonlyArray<string>,
  constraints: ReadonlyArray<SeparationConstraint>,
): { order: string[]; usable: SeparationConstraint[] } {
  const idSet = new Set(ids);
  const sorted = [...constraints]
    .filter((c) => idSet.has(c.left) && idSet.has(c.right) && c.left !== c.right)
    .sort(
      (p, q) => p.left.localeCompare(q.left) || p.right.localeCompare(q.right),
    );
  // отбрасываем рёбра, замыкающие цикл: инкрементальная проверка достижимости
  const adj = new Map<string, string[]>();
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === to) return true;
      for (const nxt of adj.get(cur) ?? []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          stack.push(nxt);
        }
      }
    }
    return false;
  };
  const usable: SeparationConstraint[] = [];
  for (const c of sorted) {
    if (reaches(c.right, c.left)) continue; // замкнул бы цикл — отброс
    usable.push(c);
    (adj.get(c.left) ?? adj.set(c.left, []).get(c.left))?.push(c.right);
  }
  // Kahn со стабильным tie-break
  const indeg = new Map<string, number>();
  for (const id of ids) indeg.set(id, 0);
  for (const c of usable) indeg.set(c.right, (indeg.get(c.right) ?? 0) + 1);
  const ready = [...ids].filter((id) => (indeg.get(id) ?? 0) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    for (const nxt of adj.get(id) ?? []) {
      const d = (indeg.get(nxt) ?? 1) - 1;
      indeg.set(nxt, d);
      if (d === 0) {
        ready.push(nxt);
        ready.sort();
      }
    }
  }
  return { order, usable };
}

/** VPSC-satisfy: позиции, удовлетворяющие constraints, минимально удалённые от desired. */
function project(
  order: ReadonlyArray<string>,
  weights: ReadonlyMap<string, number>,
  desired: ReadonlyMap<string, number>,
  constraints: ReadonlyArray<SeparationConstraint>,
): Map<string, number> {
  const parent = new Map<string, string>();
  const offset = new Map<string, number>();
  const blocks = new Map<string, Block>();
  for (const id of order) {
    parent.set(id, id);
    offset.set(id, 0);
    const w = weights.get(id) ?? 1;
    const d = desired.get(id) ?? 0;
    blocks.set(id, { vars: [id], weight: w, wsum: w * d, pos: d });
  }
  const find = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    return r;
  };
  const posOf = (id: string): number => {
    const b = blocks.get(find(id)) as Block;
    return b.pos + (offset.get(id) as number);
  };
  // merge до неподвижной точки; конечность: каждый merge уменьшает число блоков
  for (let guard = 0; guard <= order.length; guard++) {
    let merged = false;
    for (const c of constraints) {
      const rl = find(c.left);
      const rr = find(c.right);
      if (rl === rr) continue;
      if (posOf(c.left) + c.gap <= posOf(c.right) + EPS) continue;
      const bl = blocks.get(rl) as Block;
      const br = blocks.get(rr) as Block;
      const shift =
        (offset.get(c.left) as number) + c.gap - (offset.get(c.right) as number);
      for (const id of br.vars) {
        offset.set(id, (offset.get(id) as number) + shift);
        parent.set(id, rl);
        bl.vars.push(id);
        const w = weights.get(id) ?? 1;
        bl.weight += w;
        bl.wsum += w * ((desired.get(id) ?? 0) - (offset.get(id) as number));
      }
      blocks.delete(rr);
      bl.pos = bl.wsum / bl.weight;
      merged = true;
    }
    if (!merged) break;
  }
  const out = new Map<string, number>();
  for (const id of order) out.set(id, posOf(id));
  // страховочный feasibility-пасс (вырожденные конфликты путей): вперёд по
  // топопорядку, fixed (вес BIG_WEIGHT) не двигаем
  const byLeft = new Map<string, SeparationConstraint[]>();
  for (const c of constraints) {
    (byLeft.get(c.left) ?? byLeft.set(c.left, []).get(c.left))?.push(c);
  }
  for (const id of order) {
    for (const c of byLeft.get(id) ?? []) {
      const lo = (out.get(c.left) as number) + c.gap;
      const cur = out.get(c.right) as number;
      if (cur < lo - EPS && (weights.get(c.right) ?? 1) < BIG_WEIGHT) {
        out.set(c.right, lo);
      }
    }
  }
  return out;
}

export function solve1D(
  vars: ReadonlyArray<SolverVar>,
  constraints: ReadonlyArray<SeparationConstraint>,
  goals: ReadonlyArray<AlignmentGoal>,
  opts?: { rounds?: number },
): Record<string, number> {
  // нормализация: стабильный порядок по id, отсев ссылок на неизвестные id
  const sortedVars = [...vars].sort((p, q) => p.id.localeCompare(q.id));
  const ids = sortedVars.map((it) => it.id);
  const idSet = new Set(ids);
  const start = new Map<string, number>();
  const weights = new Map<string, number>();
  for (const it of sortedVars) {
    start.set(it.id, it.pos);
    weights.set(it.id, it.fixed ? BIG_WEIGHT : (it.weight ?? 1));
  }
  const { order, usable } = topoOrder(ids, constraints);
  const goalList = [...goals]
    .filter((g) => idSet.has(g.a) && idSet.has(g.b) && g.a !== g.b)
    .sort((p, q) => p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
  const partners = new Map<
    string,
    Array<{ other: string; selfOff: number; otherOff: number; w: number }>
  >();
  for (const g of goalList) {
    const w = g.weight ?? 1;
    const offA = g.offsetA ?? 0;
    const offB = g.offsetB ?? 0;
    (partners.get(g.a) ?? partners.set(g.a, []).get(g.a))?.push({
      other: g.b,
      selfOff: offA,
      otherOff: offB,
      w,
    });
    (partners.get(g.b) ?? partners.set(g.b, []).get(g.b))?.push({
      other: g.a,
      selfOff: offB,
      otherOff: offA,
      w,
    });
  }

  let x = new Map(start);
  const rounds = opts?.rounds ?? DEFAULT_ROUNDS;
  for (let round = 0; round < rounds; round++) {
    const desired = new Map<string, number>();
    for (const id of order) {
      const w = weights.get(id) ?? 1;
      if (w >= BIG_WEIGHT) {
        desired.set(id, start.get(id) ?? 0); // fixed: желание = исходная позиция
        continue;
      }
      const ps = partners.get(id);
      if (!ps || ps.length === 0) {
        desired.set(id, x.get(id) ?? 0); // без целей — остаться на месте
        continue;
      }
      // целевая позиция из каждой цели: pos(other)+otherOff−selfOff;
      // собственная текущая позиция включена — гасит взаимную погоню пар
      const items = ps.map((p) => ({
        v: (x.get(p.other) ?? 0) + p.otherOff - p.selfOff,
        w: p.w,
      }));
      items.push({ v: x.get(id) ?? 0, w });
      desired.set(id, weightedMedian(items));
    }
    const next = project(order, weights, desired, usable);
    let moved = 0;
    for (const id of order) {
      moved = Math.max(moved, Math.abs((next.get(id) ?? 0) - (x.get(id) ?? 0)));
    }
    x = next;
    if (moved < MOVE_EPS) break;
  }
  const out: Record<string, number> = {};
  for (const id of order) out[id] = x.get(id) ?? 0;
  return out;
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `bun --cwd packages/shemma-domain test src/layout-solver.test.ts`
Expected: PASS (все из Step 1). Если «эталонная топология» не сходится к <0.5 —
крутить включение собственной позиции в медиану (вес/демпфирование), НЕ ослаблять тест.

- [ ] **Step 5: Реэкспорт из index.ts**

В `packages/shemma-domain/src/index.ts` добавить строкой к остальным `export *`:

```typescript
export * from "./layout-solver";
```

- [ ] **Step 6: Полный прогон domain + lint**

Run: `bun --cwd packages/shemma-domain test && bunx biome check packages/shemma-domain/src/layout-solver.ts packages/shemma-domain/src/layout-solver.test.ts`
Expected: тесты PASS, lint чистый.

- [ ] **Step 7: Commit**

```bash
git add packages/shemma-domain/src/layout-solver.ts packages/shemma-domain/src/layout-solver.test.ts packages/shemma-domain/src/index.ts
git commit -m "feat(domain): solve1D — VPSC-решатель с целями выравнивания (DRW-235, общий с DRW-242)"
```

---

## Task 2: `global-align.ts` — выравнивание через `solve1D`

**Files:**
- Modify: `apps/frontend/src/canvas/global-align.ts` (заменить внутренний `align()`/`project()` на solve1D)
- Modify: `apps/frontend/src/canvas/global-align.test.ts` (тесты НЕ ослаблять — публичное поведение прежнее)

- [ ] **Step 1: Убедиться, что 12 текущих юнитов зелёные (базис)**

Run: `bun --cwd apps/frontend test src/canvas/global-align.test.ts`
Expected: 12 pass.

- [ ] **Step 2: Заменить решатель внутри `globalAlign`**

В `global-align.ts`: импорт + замена блока «шаг 2: global-y» и функции `align()`.
Удалить локальные `project`/`updateOrder`/`ALIGN_ITERATIONS`/`ALIGN_EPS`; вместо них:

```typescript
import { solve1D } from "@shemma/domain";
import type { AlignmentGoal, SeparationConstraint, SolverVar } from "@shemma/domain";
```

Внутри `globalAlign` функция `align()` становится сборкой входа solve1D
(координаты решателя — ЦЕНТРЫ, в `y`-карте пасса — верхние грани):

```typescript
  const align = (): void => {
    const vars: SolverVar[] = [];
    for (const [id, hh] of h) {
      vars.push({ id, pos: (y.get(id) ?? 0) + hh / 2, size: hh });
    }
    const constraints: SeparationConstraint[] = [];
    for (const cid of colIds) {
      const kids = order[cid] ?? [];
      for (let i = 1; i < kids.length; i++) {
        const prev = kids[i - 1] as string;
        const cur = kids[i] as string;
        constraints.push({
          left: prev,
          right: cur,
          gap: (h.get(prev) ?? 0) / 2 + (h.get(cur) ?? 0) / 2 + rowGap,
        });
      }
    }
    const goals: AlignmentGoal[] = input.crossEdges
      .filter((e) => h.has(e.from) && h.has(e.to))
      .map((e) => ({ a: e.from, b: e.to }));
    const solved = solve1D(vars, constraints, goals);
    for (const [id, hh] of h) {
      const c = solved[id];
      if (c != null) y.set(id, c - hh / 2);
    }
  };
```

Цикл «`orderingSweep` → `align()`» и всё остальное (обтяжка, `runGlobalAlignPass`)
— без изменений в этом таске.

- [ ] **Step 3: Прогнать юниты**

Run: `bun --cwd apps/frontend test src/canvas/global-align.test.ts`
Expected: 12 pass (точные линии, идемпотентность, порядок — как у прототипа).

- [ ] **Step 4: Lint + commit**

```bash
bunx biome check apps/frontend/src/canvas/global-align.ts
git add apps/frontend/src/canvas/global-align.ts
git commit -m "refactor(layout): global-align на solve1D из @shemma/domain (DRW-235)"
```

---

## Task 3: top-level separation + box-vars + re-wrap цикл

Закрывает дефект live-пробы (5 перекрытий на drw-235-probe2). Непартиципирующие
top-level элементы входят в решатель боксами; пары с пересечением по оси потока
получают separation; после решения боксы колонок re-wrap'аются и ограничения
пересобираются (2 раунда).

**Files:**
- Modify: `apps/frontend/src/canvas/global-align.ts`
- Modify: `apps/frontend/src/canvas/global-align.test.ts`
- Modify: `apps/frontend/src/canvas/elk-layout.ts` (передача непартиципирующих top-level)

- [ ] **Step 1: Падающие тесты**

Добавить в `global-align.test.ts`:

```typescript
describe("globalAlign — top-level separation", () => {
  it("выравнивание не вносит перекрытий между loose-узлами с пересечением по x", () => {
    // n1 и n2 в одном x-интервале; цели тянут обоих к одной координате
    const r = globalAlign({
      columns: {
        L: [
          { id: "s1", y: 44, h: 62 },
          { id: "s2", y: 152, h: 62 },
        ],
      },
      columnY: { L: 0 },
      columnX: { L: 0 },
      columnSpanX: { L: [0, 96] },
      loose: [
        { id: "n1", y: 40, h: 62, x: 300, w: 62 },
        { id: "n2", y: 160, h: 62, x: 310, w: 62 },
      ],
      internalEdges: [],
      crossEdges: [
        { from: "s1", to: "n1" },
        { from: "s1", to: "n2" }, // оба тянутся к строке s1
      ],
      rowGap: 46,
      padTop: 44,
      padBottom: 16,
    });
    const top = Math.min(r.absY.n1 ?? 0, r.absY.n2 ?? 0);
    const bot = Math.max(r.absY.n1 ?? 0, r.absY.n2 ?? 0);
    expect(bot - top).toBeGreaterThanOrEqual(62 + 46 - 0.01); // не слиплись
  });

  it("loose-узлы БЕЗ пересечения по x могут встать на одну линию", () => {
    const r = globalAlign({
      columns: {},
      columnY: {},
      columnX: {},
      columnSpanX: {},
      loose: [
        { id: "n1", y: 0, h: 62, x: 0, w: 62 },
        { id: "n2", y: 200, h: 62, x: 400, w: 62 },
      ],
      internalEdges: [],
      crossEdges: [{ from: "n1", to: "n2" }],
      rowGap: 46,
      padTop: 44,
      padBottom: 16,
    });
    expect(Math.abs((r.absY.n1 ?? 0) - (r.absY.n2 ?? 0))).toBeLessThan(0.5);
  });

  it("непартиципирующий top-level бокс не перекрывается растущей колонкой", () => {
    const r = globalAlign({
      columns: {
        C: [
          { id: "k1", y: 44, h: 62 },
          { id: "k2", y: 152, h: 62 },
        ],
      },
      columnY: { C: 0 },
      columnX: { C: 0 },
      columnSpanX: { C: [0, 96] },
      loose: [],
      passive: [{ id: "P", y: 300, h: 100, x: 10, w: 80 }], // под колонкой, x пересекается
      internalEdges: [],
      crossEdges: [],
      rowGap: 46,
      padTop: 44,
      padBottom: 16,
    });
    // P получил separation от низа колонки: если колонка не росла — P не двигается
    expect(r.absY.P ?? 0).toBeGreaterThanOrEqual(300 - 0.01);
  });
});
```

Run: `bun --cwd apps/frontend test src/canvas/global-align.test.ts`
Expected: FAIL — нет полей `columnSpanX`, `passive`, `x/w` у loose.

- [ ] **Step 2: Расширить вход и сборку ограничений**

В `GlobalAlignInput` добавить:

```typescript
  /** x-интервал колонки [minX, maxX] — для top-level separation-пар */
  columnSpanX: Record<string, [number, number]>;
  /** свободные top-level узлы: + x/w для интервалов */
  loose: Array<{ id: string; y: number; h: number; x: number; w: number }>;
  /** непартиципирующие top-level элементы (контейнеры вдоль потока,
   *  sizePinned, не-geo) — двигаются как целые боксы */
  passive?: Array<{ id: string; y: number; h: number; x: number; w: number }>;
```

В `globalAlign`:
1. passive-элементы регистрируются как переменные (`h.set`, `y.set`), НЕ входят
   в колонки/ordering; в `absY` возвращаются как верхняя грань бокса.
2. Сборка top-level пар (внутри `align()`, после колонн-ограничений, на КАЖДОМ
   раунде — границы колонок меняются):

```typescript
    // top-level элементы как интервалы по cross-оси:
    // колонка → [minKid − padTop, maxKid + padBottom] через крайние строки;
    // loose/passive → собственный бокс
    type TopItem = {
      id: string; // id переменной-носителя (крайняя строка колонки или сам элемент)
      lowVar: string; // переменная нижней границы (последняя строка / сам бокс)
      highVar: string; // переменная верхней границы (первая строка / сам бокс)
      topPad: number; // расстояние от центра highVar до верха интервала
      bottomPad: number; // от центра lowVar до низа интервала
      span: [number, number];
      cross: [number, number]; // текущий интервал по решаемой оси
    };
    const tops: TopItem[] = [];
    for (const cid of colIds) {
      const kids = order[cid] ?? [];
      const first = kids[0] as string;
      const last = kids[kids.length - 1] as string;
      if (!first || !last) continue;
      tops.push({
        id: cid,
        highVar: first,
        lowVar: last,
        topPad: (h.get(first) ?? 0) / 2 + padTop,
        bottomPad: (h.get(last) ?? 0) / 2 + padBottom,
        span: input.columnSpanX[cid] ?? [0, 0],
        cross: [
          (y.get(first) ?? 0) - padTop,
          (y.get(last) ?? 0) + (h.get(last) ?? 0) + padBottom,
        ],
      });
    }
    for (const it of [...input.loose, ...(input.passive ?? [])]) {
      tops.push({
        id: it.id,
        highVar: it.id,
        lowVar: it.id,
        topPad: it.h / 2,
        bottomPad: it.h / 2,
        span: [it.x, it.x + it.w],
        cross: [y.get(it.id) ?? 0, (y.get(it.id) ?? 0) + it.h],
      });
    }
    tops.sort(
      (p, q) => p.cross[0] - q.cross[0] || p.id.localeCompare(q.id),
    );
    for (let i = 0; i < tops.length; i++) {
      for (let j = i + 1; j < tops.length; j++) {
        const a = tops[i] as TopItem;
        const b = tops[j] as TopItem;
        if (a.id === b.id) continue;
        const xOverlap = a.span[0] < b.span[1] && b.span[0] < a.span[1];
        if (!xOverlap) continue;
        if (a.highVar === b.highVar) continue; // один и тот же элемент
        // a выше b (порядок по текущему cross-интервалу)
        constraints.push({
          left: a.lowVar,
          right: b.highVar,
          gap: a.bottomPad + topGap + b.topPad,
        });
      }
    }
```

где `topGap = rowGap` (зазор между top-level соседями; при желании — отдельный
параметр, НО без нового пресета: используем rowGap).

3. Re-wrap цикл: внешний цикл «ordering → align» уже пересобирает ограничения
   каждый раунд (align строит их заново) — отдельный второй цикл НЕ нужен;
   достаточно поднять минимум раундов до 2 после стабилизации порядка:
   в цикле `for (let sweep = 0; ...)` заменить условие выхода
   `if (sweep > 0 && !changed) break;` на
   `if (sweep > 0 && !changed && sweep >= 2) break;`.

- [ ] **Step 3: Прогнать юниты** — все (старые 12 + новые 3) PASS. В старых
тестах добавить `columnSpanX` (непересекающиеся интервалы: C1 [0,96],
C2 [300,396], C3 [600,696], C4 [900,996]) и `x/w` у loose (X-цепочка: x = 0/300/600,
w = 62) — данные, не семантика.

- [ ] **Step 4: Передача из `elk-layout.ts`**

В хуке `runElkLayout` (блок DRW-235): собрать `columnSpanX` (из `flat[cid].x` и
`flat[cid].w`), `x/w` для loose (из `flat`), и `passive` — top-level элементы
компоненты, не попавшие ни в колонки, ни в loose (контейнеры вдоль потока,
sizePinned-контейнеры): id, бокс из `flat`. Писать обратно: `flat[id].y = absY[id]`
для passive. Код по образцу существующей сборки в `runGlobalAlignPass`
(расширить `GlobalAlignPassArgs` полями `passive`, `columnSpanX` — собираются
caller'ом из `flat`).

- [ ] **Step 5: Полный фронтенд-прогон + commit**

```bash
bun --cwd apps/frontend test src
git add apps/frontend/src/canvas/global-align.ts apps/frontend/src/canvas/global-align.test.ts apps/frontend/src/canvas/elk-layout.ts
git commit -m "feat(layout): top-level separation в глобальном выравнивании — пасс не вносит перекрытий (DRW-235)"
```

---

## Task 4: пины

**Files:**
- Modify: `apps/frontend/src/canvas/global-align.ts`
- Modify: `apps/frontend/src/canvas/elk-layout.ts` (гейт прототипа «бейл при пинах» заменяется передачей пинов)
- Modify: `apps/frontend/src/canvas/global-align.test.ts`

- [ ] **Step 1: Падающие тесты**

```typescript
describe("globalAlign — пины", () => {
  it("pinned-узел не двигается, партнёр выравнивается к нему", () => {
    const r = globalAlign({
      columns: {},
      columnY: {},
      columnX: {},
      columnSpanX: {},
      loose: [
        { id: "p", y: 500, h: 62, x: 0, w: 62 },
        { id: "m", y: 100, h: 62, x: 400, w: 62 },
      ],
      pinned: new Set(["p"]),
      internalEdges: [],
      crossEdges: [{ from: "p", to: "m" }],
      rowGap: 46,
      padTop: 44,
      padBottom: 16,
    });
    expect(Math.abs((r.absY.p ?? 0) - 500)).toBeLessThan(0.5);
    expect(Math.abs((r.absY.m ?? 0) - 500)).toBeLessThan(0.5);
  });

  it("колонка с pinned-ребёнком не переупорядочивается", () => {
    const r = globalAlign({
      columns: {
        C: [
          { id: "a", y: 44, h: 62 },
          { id: "b", y: 152, h: 62 },
        ],
      },
      columnY: { C: 0 },
      columnX: { C: 0 },
      columnSpanX: { C: [0, 96] },
      loose: [{ id: "ext", y: 40, h: 62, x: 300, w: 62 }],
      pinned: new Set(["b"]),
      internalEdges: [],
      crossEdges: [{ from: "b", to: "ext" }], // score тянет b наверх
      rowGap: 46,
      padTop: 44,
      padBottom: 16,
    });
    expect(r.order.C).toEqual(["a", "b"]); // порядок не изменился
  });
});
```

Run: Expected FAIL — поля `pinned` нет.

- [ ] **Step 2: Реализация**

`GlobalAlignInput` + `pinned?: ReadonlySet<string>`. В `globalAlign`:
- `orderingSweep`: колонка, у которой `kids.some((k) => pinned.has(k))`, —
  пропускается (порядок сохраняется), как у flip-пасса Фазы 1;
- `align()`: `vars.push({ ..., fixed: input.pinned?.has(id) })`.

В `elk-layout.ts`: гейт прототипа `if (forceUnpin || !pinnedSeen)` заменить на
безусловный запуск пасса с `pinned`: при `forceUnpin` — пустой Set, иначе —
Set pinned-узлов/loose. sizePinned-контейнер при !forceUnpin уходит в `passive`
(Task 3) и помечается `pinned` (бокс-вар fixed). Writeback в `flat` для
pinned-элементов НЕ делается (их позиции и так не применяются apply-пассом —
поведение Фазы 1 сохраняется, двойная защита).

- [ ] **Step 3: Прогон + commit**

```bash
bun --cwd apps/frontend test src/canvas/global-align.test.ts
git add apps/frontend/src/canvas/global-align.ts apps/frontend/src/canvas/elk-layout.ts apps/frontend/src/canvas/global-align.test.ts
git commit -m "feat(layout): pin-дисциплина в глобальном выравнивании — fixed-вары и пропуск ordering (DRW-235)"
```

---

## Task 5: ось-абстракция — TB/BT-доски

**Files:**
- Modify: `apps/frontend/src/canvas/elk-layout.ts` (адаптер в хуке)
- Modify: `apps/frontend/src/canvas/global-align.test.ts` (юнит не нужен — адаптер тестируется через хук; добавить тест адаптера в elk-layout-тестах, если они есть для хука, иначе live-проверка в Task 8)

`globalAlign` остаётся одноосным («cross-координата»). Для TB/BT-досок хук
транспонирует вход/выход:

- [ ] **Step 1: Вынести сборку входа пасса в хелпер с осью**

В хуке `runElkLayout` ввести:

```typescript
const axisVertical = frameDir === "LR" || frameDir === "RL"; // решаем y
```

При `axisVertical === false` (TB/BT): колонки = контейнеры с `resolvedDirs[cid]`
∈ {"LR","RL"}; в `columns` подставляются `y: p.x, h: p.w ?? 0`; `columnY` = flat.x,
`columnX` = flat.y (порядок «колонок» вдоль потока = по y); `columnSpanX` =
[flat.y, flat.y + h] (интервалы по перпендикуляру); loose/passive — симметрично
(x↔y, w↔h). Результат: `absY` пишется в `flat[id].x`, бокс колонки — в
`flat[cid].x/.w`. Для RL и BT поток инвертирован: `columnX` подаётся с минусом
(`-flat.x` / `-flat.y`), чтобы направленный первый свип шёл от истока потока.

Реализовать через маленький адаптер (две чистые функции `readAxis`/`writeAxis`
рядом с хуком), не дублируя сборку.

- [ ] **Step 2: Прогон всех фронтенд-тестов**

Run: `bun --cwd apps/frontend test src`
Expected: PASS (TB/BT-поведение проверяется live в Task 8).

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/canvas/elk-layout.ts
git commit -m "feat(layout): ось-абстракция глобального выравнивания — TB/BT-доски и RL/BT-порядок свипа (DRW-235)"
```

---

## Task 6: интеграция — флаг долой, flip-interplay, layered-gate

**Files:**
- Modify: `apps/frontend/src/canvas/elk-layout.ts`
- Modify: `apps/frontend/src/canvas/global-align.ts` (удалить `isGlobalAlignEnabled`)

- [ ] **Step 1: Удалить флаг**

- Удалить `isGlobalAlignEnabled` из `global-align.ts` и его импорт.
- Условие хука: `if (algorithm === "layered" && !opts?.dryRun)` (направление
  обрабатывает ось-адаптер Task 5; dryRun уже отсечён ранним return'ом — оставить
  проверку для ясности или убрать, если хук стоит после dryRun-блока).

- [ ] **Step 2: Flip-interplay**

Ordering строго сильнее зеркального flip для участвующих колонок. В flip-пассе
(блок `for (const c of containerShapes)` со `mirrorContainer`) добавить пропуск:

```typescript
      // DRW-235: участвующие в глобальном ordering колонки не флипуем —
      // ordering уже выбрал порядок по внешним связям (строго сильнее зеркала)
      if (alignedColumnIds.has(cid)) continue;
```

где `alignedColumnIds: Set<string>` — id колонок, отобранных для пасса
(вычисление колонок поднять ДО flip-блока; сам пасс остаётся на своём месте
после flip — flip теперь трогает только непартиципирующие контейнеры).

- [ ] **Step 3: Полный прогон + lint-дельта**

Run: `bun --cwd apps/frontend test src && bunx biome check apps/frontend/src/canvas/elk-layout.ts apps/frontend/src/canvas/global-align.ts`
Expected: тесты PASS; lint-дельта против baseline — ноль новых диагностик.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/canvas/elk-layout.ts apps/frontend/src/canvas/global-align.ts
git commit -m "feat(layout): глобальное выравнивание — штатная часть layered-пасса; флаг убран, flip только для непартиципирующих (DRW-235)"
```

---

## Task 7: portHints + точные анкоры выровненных рёбер

**Files:**
- Modify: `apps/frontend/src/canvas/global-align.ts` (`runGlobalAlignPass` возвращает portHints)
- Modify: `apps/frontend/src/canvas/elk-layout.ts` (`distributeArrowPorts` принимает alignedEdges)
- Modify: `apps/frontend/src/canvas/global-align.test.ts`

- [ ] **Step 1: Падающий тест**

```typescript
describe("runGlobalAlignPass — portHints", () => {
  it("возвращает выровненные рёбра с точками на границах колонок", () => {
    const flat = {
      C1: { x: 0, y: 0, w: 96, h: 260 },
      C2: { x: 300, y: 40, w: 96, h: 260 },
      a: { x: 16, y: 44, w: 62, h: 62 },
      b: { x: 16, y: 44, w: 62, h: 62 },
    };
    const res = runGlobalAlignPass({
      flat,
      columns: [
        { id: "C1", kidIds: ["a"] },
        { id: "C2", kidIds: ["b"] },
      ],
      looseIds: [],
      nodeEdges: [{ from: "a", to: "b" }],
      components: [["C1", "C2"]],
      rowGap: 46,
      compGap: 130,
      padTop: 44,
      padBottom: 16,
    });
    const hint = res.portHints.get("a>b");
    expect(hint).toBeDefined();
    // после выравнивания a и b на одном cy: точки на правой грани C1 и левой C2
    expect(hint?.source.x).toBeCloseTo(96, 1);
    expect(hint?.target.x).toBeCloseTo(300, 1);
    expect(Math.abs((hint?.source.y ?? 0) - (hint?.target.y ?? 1))).toBeLessThan(0.5);
  });
});
```

Run: Expected FAIL — `runGlobalAlignPass` возвращает void.

- [ ] **Step 2: Реализация в `runGlobalAlignPass`**

Возвращаемый тип:

```typescript
export interface GlobalAlignPassResult {
  /** cross-рёбра, выровненные в линию (|Δcentre| < 0.5): ключ "from>to" */
  portHints: Map<string, { source: { x: number; y: number }; target: { x: number; y: number } }>;
}
```

После writeback: для каждого cross-ребра участников, если |Δцентров по cross-оси|
< 0.5 — посчитать точки на границах боксов-владельцев (правая грань source-бокса /
левая грань target-бокса для LR; симметрично для других направлений — в
координатах `flat`, ось уже нормализована адаптером Task 5) и положить в карту.
Вернуть `{ portHints }`.

- [ ] **Step 3: Потребитель — `distributeArrowPorts`**

Сигнатура: `+ alignedEdges?: ReadonlySet<string>` (ключи `"start>end"` по shape-id).
В цикле распределения: арроу, чьё `"${t.start}>${t.end}"` в `alignedEdges`,
НЕ участвует в группе `(i+1)/(n+1)` — обоим его терминалам ставится центр грани
(`frac = 0.5`), остальные в группе распределяются без него. В `runElkLayout`
хук сохраняет результат пасса и передаёт `alignedEdges` (ключи из portHints,
переведённые в пары shape-id) в `distributeArrowPorts`.

- [ ] **Step 4: Прогон + commit**

```bash
bun --cwd apps/frontend test src
git add apps/frontend/src/canvas/global-align.ts apps/frontend/src/canvas/global-align.test.ts apps/frontend/src/canvas/elk-layout.ts
git commit -m "feat(layout): portHints выровненных рёбер + центр-анкоры в port-пассе (DRW-235, интерфейс Фазы 3)"
```

---

## Task 8: live-верификация AC (координатор, НЕ сабагент)

**Files:** нет правок кода (фиксы — отдельными коммитами при находках).

- [ ] **Step 1:** dev-стенд (`SHEMMA_PROFILE=dev bun run dev`), вкладка через chrome-devtools MCP.
- [ ] **Step 2: AC#1+#2 (эталоны)** — `?space=di-draw&room=drw-235-probe`, ⌘⌥⇧L
      на фрейме (БЕЗ флага — его больше нет): порядок C2=[B1,B2], C3=[D1,D2,D3],
      C4=[E1,E2]; цепочка/ряд/пара — |Δcy| < 1px (проверка координат скриптом);
      скриншот.
- [ ] **Step 3: AC#3+#4 (перекрытия, идемпотентность)** — `room=drw-235-probe2`:
      siblings-overlap счётчик = 0 после пасса; повторный пасс на обеих комнатах —
      0 сдвигов; скриншоты.
- [ ] **Step 4: AC#5 (локальность/пины)** — на drw-235-probe: запинить узел
      (двинуть рукой), обычный ⌘⇧L → pinned держится; X-цепочка (вторая
      компонента) не сдвинулась от правки первой.
- [ ] **Step 5: AC#6+#7** — TB-доска (создать копию эталона с направлением TB
      force-пассом или комнату `dl-test`-типа): лейны вертикальные, колонки→строки;
      locked-фреймы a-elk-tree/dl-test — байт-в-байт нетронуты.
- [ ] **Step 6:** результаты + скриншоты → notes DRW-235; найденные дефекты —
      фикс-коммиты и повторный прогон шага.

---

## Task 9: закрытие — CHANGELOG, backend-parity задача, чистка

**Files:**
- Modify: `CHANGELOG.md` (Unreleased: фича-пункт Фазы 2)
- Modify: `docs/superpowers/specs/2026-06-12-layout-phase2-cross-boundary-design.md` (статус → «реализована, AC пройдены» + отступления, если были)
- Backlog: новая задача + правка DRW-235

- [ ] **Step 1: CHANGELOG** — пункт в Unreleased: глобальная координация строк
      (DRW-235): порядок по внешним связям, cross-рёбра в линию, обтяжка,
      VPSC-solver в domain, без новых перекрытий, пины/идемпотентность сохранены.
- [ ] **Step 2: Backlog-задача backend parity** (через `backlog task create`,
      milestone m-8, приоритет medium): «shemma_layout выравнивает как ⌘⇧L» —
      TL;DR: интегрировать solve1D-пасс в backend-пайплайн
      (`apps/backend/src/domain/layout.ts`), чтобы MCP-layout давал тот же
      результат, что фронтенд-пасс. Зависимость: эта фаза. Файл переименовать
      в `drw-NNN-backend-layout-parity.md`.
- [ ] **Step 3: DRW-235 notes** — итоги фазы (что вошло, что вынесено), статус
      In Progress → ждёт финальной приёмки юзером.
- [ ] **Step 4: Полный workspace-прогон**

Run: `bun run test && bun run lint`
Expected: все пакеты зелёные (известный флак CLI banner — DRW-243, не блокер);
lint-дельта по файлам ветки — ноль.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-06-12-layout-phase2-cross-boundary-design.md
git commit -m "docs: changelog + статус спеки — Фаза 2 cross-boundary ordering (DRW-235)"
```

**После Task 9 — СТОП:** финальная приёмка юзером (live), squash + `--no-ff` merge
в main — только после его «принято» (policy: merge-needs-acceptance).

---

## Self-review (выполнен)

- Spec coverage: §3.1→Task 1; §3.2→Tasks 3,4; §3.3→прототип (уже в ветке) + Task 2;
  §3.4→Task 5; §3.5→Task 3 (re-wrap в общем цикле) + re-pack уже в прототипе;
  §3.6→Task 7; §3.7→Tasks 6,9 (parity = Backlog-задача, спека это допускает);
  AC#1-7→Task 8; AC#8→Task 1; AC#9→Tasks 6,9.
- Placeholders: код приведён для всех новых/изменяемых функций; для механических
  правок (импорты, поля типов, сбор из flat) — точные указания места и образца.
- Консистентность типов: `solve1D(vars, constraints, goals, opts)`;
  `AlignmentGoal.offsetA/offsetB`; `GlobalAlignInput.columnSpanX/passive/pinned`;
  `GlobalAlignPassResult.portHints` — сверены между тасками.
