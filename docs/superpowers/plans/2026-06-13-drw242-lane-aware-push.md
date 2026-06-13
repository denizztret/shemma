# DRW-242 lane-aware push — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Точечный push (`resolveOverlapsAlongFlow`) перестаёт сдвигать узлы, не пересекающиеся с выросшим боксом по поперечной оси — группирует box-узлы в поперечные полосы и гоняет существующий `resolveOverlaps1D` независимо в каждой.

**Architecture:** Одна правка чистой геометрии в `apps/frontend/src/canvas/resolve-overlaps.ts`: новый хелпер `groupLanes` + переписанное тело `resolveOverlapsAlongFlow` (per-lane 1D). `resolveOverlaps1D`/`flowAxis`/`growOnlyBox` не трогаются. Frontend-only (backend resolve-overlaps не вызывает). Единственный вызывающий — `resolveOverlapsInWrapper` (`elk-layout.ts:2255`) — чинит оба пути (контейнер-scope DRW-233 + ручной ⌘⇧F) без плaмбинга. Спека: `docs/superpowers/specs/2026-06-13-drw242-lane-aware-push-design.md`.

**Tech Stack:** TypeScript (strict), bun:test, Biome.

**Ветка:** `feature/drw-242-lane-aware-push` (уже активна).

**Решения юзера:** `LANE_EPS = 1` px; фикс универсальный (оба пути); AC#2 = «не регрессировать push внутри полосы». Live-верификацию (Task 3) делает координатор сам (chrome-devtools), НЕ сабагент.

---

### Task 1: `groupLanes` — разбиение узлов на поперечные полосы

**Files:**
- Modify: `apps/frontend/src/canvas/resolve-overlaps.ts` (добавить экспорт-хелпер + константу)
- Test: `apps/frontend/src/canvas/resolve-overlaps.test.ts`

- [ ] **Step 1: Написать падающие тесты `groupLanes`**

Добавить импорт `groupLanes`, `type CrossAxis`, `LANE_EPS` в шапку теста (к существующим из `./resolve-overlaps`). Добавить блок:

```typescript
describe("groupLanes — поперечные полосы", () => {
  const node = (
    id: string, x: number, y: number, w: number, h: number, pinned = false,
  ): FlowNode => ({ id, x, y, w, h, pinned });

  test("все узлы выровнены поперечно → одна полоса", () => {
    // flow=x → cross=y; y-интервалы перекрываются → одна полоса
    const lanes = groupLanes(
      [node("a", 0, 0, 50, 40), node("b", 200, 5, 50, 40)],
      "y",
    );
    expect(lanes.length).toBe(1);
    expect(lanes[0].map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  test("чистый поперечный зазор > LANE_EPS → две полосы", () => {
    // y-интервалы [0,40] и [100,140] не пересекаются → две полосы
    const lanes = groupLanes(
      [node("a", 0, 0, 50, 40), node("b", 0, 100, 50, 40)],
      "y",
    );
    expect(lanes.length).toBe(2);
  });

  test("перекрытие ровно на LANE_EPS → разные полосы (строгое >)", () => {
    // a:[0,40], b:[39,79] → перекрытие = 40-39 = 1 = LANE_EPS → НЕ объединять
    const lanes = groupLanes(
      [node("a", 0, 0, 50, 40), node("b", 0, 39, 50, 40)],
      "y",
    );
    expect(lanes.length).toBe(2);
  });

  test("перекрытие чуть больше LANE_EPS → одна полоса", () => {
    // a:[0,40], b:[38,78] → перекрытие = 2 > 1 → одна полоса
    const lanes = groupLanes(
      [node("a", 0, 0, 50, 40), node("b", 0, 38, 50, 40)],
      "y",
    );
    expect(lanes.length).toBe(1);
  });

  test("транзитивный мост: A∩B, B∩C, A∌C → одна полоса", () => {
    // y: A[0,100], B[90,190], C[180,280] — A и C не пересекаются напрямую,
    // но связаны через B → одна связная полоса
    const lanes = groupLanes(
      [node("a", 0, 0, 50, 100), node("b", 0, 90, 50, 100), node("c", 0, 180, 50, 100)],
      "y",
    );
    expect(lanes.length).toBe(1);
    expect(lanes[0].length).toBe(3);
  });

  test("cross='x' (вертикальный поток): полосы по x-интервалам", () => {
    // flow=y → cross=x; x[0,50] и x[200,250] → две полосы
    const lanes = groupLanes(
      [node("a", 0, 0, 50, 40), node("b", 200, 0, 50, 40)],
      "x",
    );
    expect(lanes.length).toBe(2);
  });

  test("детерминизм: полосы по возрастанию начала интервала", () => {
    const lanes = groupLanes(
      [node("b", 0, 200, 50, 40), node("a", 0, 0, 50, 40)],
      "y",
    );
    expect(lanes.map((l) => l[0].id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Запустить — убедиться что падает**

Run: `bun --cwd apps/frontend test src/canvas/resolve-overlaps.test.ts`
Expected: FAIL — `groupLanes`/`LANE_EPS`/`CrossAxis` не экспортированы.

- [ ] **Step 3: Реализовать `groupLanes`**

В `resolve-overlaps.ts` после `FlowAxis`/`flowAxis` (перед `resolveOverlapsAlongFlow`) добавить:

```typescript
/** Поперечная ось относительно оси потока: flow="x" → cross="y", и наоборот. */
export type CrossAxis = "x" | "y";

/** Минимальное поперечное перекрытие (px), чтобы считать узлы одной полосой. */
export const LANE_EPS = 1;

function crossInterval(n: FlowNode, cross: CrossAxis): [number, number] {
  return cross === "y" ? [n.y, n.y + n.h] : [n.x, n.x + n.w];
}

/**
 * Группирует узлы в поперечные полосы: два узла в одной полосе ⟺ их интервалы по
 * поперечной оси перекрываются больше чем на {@link LANE_EPS}. Связность
 * транзитивна (полоса = связная компонента графа перекрытий). Узлы сортируются по
 * началу поперечного интервала (tie-break по id); поскольку отсортированы по
 * началу, покрытие полосы непрерывно, и связные компоненты = слитые перекрывающиеся
 * интервалы. Детерминирован.
 */
export function groupLanes(
  nodes: ReadonlyArray<FlowNode>,
  cross: CrossAxis,
): FlowNode[][] {
  const sorted = [...nodes].sort((a, b) => {
    const da = crossInterval(a, cross)[0];
    const db = crossInterval(b, cross)[0];
    return da - db || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const lanes: FlowNode[][] = [];
  let cur: FlowNode[] = [];
  let curEnd = Number.NEGATIVE_INFINITY;
  for (const n of sorted) {
    const [s, e] = crossInterval(n, cross);
    // Перекрытие с покрытием текущей полосы = curEnd - s (узлы отсортированы по s).
    if (cur.length > 0 && curEnd - s > LANE_EPS) {
      cur.push(n);
      curEnd = Math.max(curEnd, e);
    } else {
      if (cur.length > 0) lanes.push(cur);
      cur = [n];
      curEnd = e;
    }
  }
  if (cur.length > 0) lanes.push(cur);
  return lanes;
}
```

- [ ] **Step 4: Запустить — зелёные**

Run: `bun --cwd apps/frontend test src/canvas/resolve-overlaps.test.ts`
Expected: PASS (новый блок `groupLanes` + все прежние).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/canvas/resolve-overlaps.ts apps/frontend/src/canvas/resolve-overlaps.test.ts
git commit -m "feat(layout): groupLanes — разбиение узлов на поперечные полосы (DRW-242)"
```

---

### Task 2: lane-aware `resolveOverlapsAlongFlow` + регресс-фикстура

**Files:**
- Modify: `apps/frontend/src/canvas/resolve-overlaps.ts` (тело `resolveOverlapsAlongFlow`)
- Test: `apps/frontend/src/canvas/resolve-overlaps.test.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Написать падающие тесты (lane-aware + регресс)**

Добавить в блок `describe("resolveOverlapsAlongFlow ...")` (используя локальный `node`):

```typescript
  test("две полосы: наезд только в одной → вторая полоса нетронута", () => {
    // Полоса A (y0): a[x0,w90] вырос, b[x70] наезжает → b.x=114.
    // Полоса B (y200, чистый зазор): c[x0], d[x70] — но в полосе B наезд c→d тоже
    //   есть, проверим что полосы независимы. Возьмём полосу B БЕЗ наезда:
    const r = resolveOverlapsAlongFlow(
      [
        node("a", 0, 0, 90, 40),
        node("b", 70, 0, 100, 40),
        node("c", 0, 200, 50, 40),
        node("d", 300, 200, 50, 40),
      ],
      "LR",
      24,
    );
    // Полоса A: b сдвинут. Полоса B: c,d не наезжают → не двигаются.
    expect(r).toEqual([{ id: "b", x: 114 }]);
  });

  test("узлы разных полос не толкают друг друга по проекции", () => {
    // a[x0,w200] в верхней полосе (y0), x[x50] в НИЖНЕЙ полосе (y300).
    // Проекции на x пересекаются, но полосы разные → НЕ толкать.
    const r = resolveOverlapsAlongFlow(
      [node("a", 0, 0, 200, 40), node("x", 50, 300, 100, 40)],
      "LR",
      24,
    );
    expect(r).toEqual([]);
  });

  test("регресс DRW-242 (live drw242-repro): рост контейнера не двигает чужую полосу", () => {
    // Геометрия из живой репродукции: фрейм LR. Контейнер G1 вырос вширь до
    // x[-390,206] в верхней полосе (y[180,320]). X-цепочка в НИЖНЕЙ полосе
    // (y[486,566]), внутренние зазоры ровные (120px > gap). До фикса 1D-каскад
    // толкал Ingest на +240; lane-aware → НЕТ движения.
    const r = resolveOverlapsAlongFlow(
      [
        node("g1", -390, 180, 596, 140),
        node("ingest", -10, 486, 220, 80),
        node("parse", 330, 486, 220, 80),
        node("store", 670, 486, 220, 80),
        node("index", 1010, 486, 220, 80),
      ],
      "LR",
      24,
    );
    expect(r).toEqual([]);
  });
```

- [ ] **Step 2: Запустить — убедиться что падает**

Run: `bun --cwd apps/frontend test src/canvas/resolve-overlaps.test.ts`
Expected: FAIL — текущий 1D-каскад двигает `ingest`/`x`/`d` (cross-lane drag).

- [ ] **Step 3: Переписать тело `resolveOverlapsAlongFlow` (lane-aware)**

Заменить тело (сигнатура и JSDoc-смысл прежние; обновить JSDoc упоминанием полос):

```typescript
export function resolveOverlapsAlongFlow(
  nodes: ReadonlyArray<FlowNode>,
  dir: string | null | undefined,
  gap: number,
): Array<{ id: string; x?: number; y?: number }> {
  if (nodes.length < 2) return [];
  const { axis, reverse } = flowAxis(dir, nodes);
  const horizontal = axis === "x";
  const cross: CrossAxis = horizontal ? "y" : "x";

  const moves: Array<{ id: string; x?: number; y?: number }> = [];
  for (const lane of groupLanes(nodes, cross)) {
    if (lane.length < 2) continue; // одиночка в полосе никогда не двигается
    const items: Overlap1DItem[] = lane.map((n) => {
      const pos = horizontal ? n.x : n.y;
      const size = horizontal ? n.w : n.h;
      // reverse: зеркалим в u = -(pos + size) так, что поток идёт в +u.
      const start = reverse ? -(pos + size) : pos;
      return { id: n.id, start, size, pinned: n.pinned };
    });
    const sizeOf = new Map(lane.map((n) => [n.id, horizontal ? n.w : n.h]));
    for (const m of resolveOverlaps1D(items, gap)) {
      const size = sizeOf.get(m.id) ?? 0;
      const pos = reverse ? -m.start - size : m.start;
      moves.push(horizontal ? { id: m.id, x: pos } : { id: m.id, y: pos });
    }
  }
  return moves;
}
```

Обновить JSDoc функции: добавить, что наезд устраняется **внутри каждой поперечной полосы независимо** (узлы из разных полос не толкают друг друга) — DRW-242.

- [ ] **Step 4: Запустить — зелёные (включая прежние тесты)**

Run: `bun --cwd apps/frontend test src/canvas/resolve-overlaps.test.ts`
Expected: PASS. Прежние `resolveOverlapsAlongFlow`-тесты (поперечно выровненные узлы → одна полоса) остаются зелёными.

- [ ] **Step 5: Прогнать весь frontend-layout — нет регрессий**

Run: `bun --cwd apps/frontend test src/canvas/elk-layout.test.ts src/canvas/resolve-overlaps.test.ts`
Expected: PASS.

- [ ] **Step 6: Обновить CHANGELOG.md**

В секции unreleased добавить под layout:

```markdown
- **Layout (DRW-242):** точечный push соседей при росте бокса обёртки теперь lane-aware — узлы из другой поперечной полосы (несвязный компонент в соседнем ряду фрейма) больше не сдвигаются по проекции оси потока. Затрагивает `resolveOverlapsAlongFlow` (контейнер-scope ⌘⇧L и ручной ⌘⇧F).
```

- [ ] **Step 7: Lint**

Run: `bun run lint`
Expected: чисто (затронутые файлы без новых ошибок).

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/canvas/resolve-overlaps.ts apps/frontend/src/canvas/resolve-overlaps.test.ts CHANGELOG.md
git commit -m "feat(layout): lane-aware resolveOverlapsAlongFlow — push только внутри поперечной полосы (DRW-242)"
```

---

### Task 3: Live-верификация (КООРДИНАТОР, не сабагент)

**Делает main agent сам** (chrome-devtools), не доверяя скриншот-отчётам сабагентов.

- [ ] Room `drw242-repro` (dev :8788 / tab :5173) — восстановить чистое before-состояние (контейнер LR узкий, X-цепочка в нижней полосе с ровными зазорами).
- [ ] Контейнер-scope ⌘⇧L на G1 → контейнер растёт вширь.
- [ ] Проверить: X-цепочка по x **не двигается**, зазоры остаются ровными (340/340/340).
- [ ] Скриншот after-фикса → `docs/references/drw-199-probes/drw242-after-fix.png`.
- [ ] (Опц.) проверить ⌘⇧F на узле внутри контейнера: push внутри полосы работает, чужая полоса не трогается.

---

### Финал (координатор)

- [ ] Завести follow-up backlog-задачу: VPSC 2D node-overlap removal (`@shemma/domain`, оба пайплайна).
- [ ] DRW-242 AC/DoD отметить; final summary с verification-командой и результатом.
- [ ] Память обновить (DRW-242 готов к приёмке, не merge).
- [ ] НЕ merge / НЕ tag — по приёмке юзера.
