# DRW-149 Autolayout в schema-frame — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Cmd+Shift+L` (Tidy) корректно выполняет рекурсивный bottom-up autolayout внутри schema-frame и обрабатывает frame+external как монолит; результат — атомарная undo-able операция.

**Architecture:** Gap-fill в existing `runLayoutSubgraph` (`apps/backend/src/domain/layout.ts:498-754`, DRW-099) — снимаем `< 2 noop` short-circuits в frontend и backend, через probe выясняем точные gap'ы для cases single-frame и frame+external, точечно фиксим, добавляем client-side undo wrap для атомарности (G7). Resize envelope (frame/shape-container) идёт через PatchOp в store (WS-sync минует `Editor.resizeShapes` и его cascading `onResize`).

**Tech Stack:** Bun (backend HTTP/test runner), TypeScript, Hono (routes), elkjs (layout), tldraw 5.x (frontend), Vite (frontend dev), Biome (lint).

**Spec:** [`docs/superpowers/specs/2026-05-24-drw-149-autolayout-in-frame-design.md`](../specs/2026-05-24-drw-149-autolayout-in-frame-design.md) v0.2.

**Branch:** `feature/drw-149-autolayout-in-frame` (rename'нута из `feature/drw-146-layout-overhaul`).

---

## File structure overview

**Создаём:**
- `docs/superpowers/specs/2026-05-24-drw-149-probe-findings.md` — Phase 1 probe output: точное поведение `runLayoutSubgraph` для 6 cases + список реальных gap'ов + финальный выбор undo-подхода (α или β).
- `docs/manual-tests/drw-149-autolayout-in-frame.md` — Phase 6 manual E2E test checklist.

**Модифицируем (известное):**
- `apps/frontend/src/canvas/tidy-layout.ts` (95 строк) — удалить `< 2 noop` short-circuit (lines 26-34).
- `apps/frontend/src/canvas/tidy-layout.test.ts` — обновить тесты на short-circuit removal.
- `apps/backend/src/routes/layout-selection.ts` (217 строк) — удалить `< 2 noop` branch'и (84-91, 132-140); single id → 200 ok count=0.
- `apps/backend/tests/routes-layout-selection.test.ts` — обновить existing тесты; добавить новые (frame-only, frame+external).
- `apps/backend/tests/domain/layout.test.ts` — добавить integration тесты для probe cases (Phase 1) и regression тесты (Phase 4).
- `apps/frontend/src/transport/ws.ts` (или связанный файл applying-WS-changes) — undo wrap (Phase 5, точный файл — после Phase 1 probe).
- `CHANGELOG.md` — release entry для `0.25.0`.

**Возможные точечные правки (по Phase 1 findings):**
- `apps/backend/src/domain/layout.ts` — fix'ы в `runLayoutSubgraph`, `runLayout`, `buildEdges` (только если probe покажет gap). Каждый fix — отдельный subagent task в Phase 3.

---

## Phase 1 — Probe & gap analysis

### Task 1.1: Setup probe-снятие `< 2 noop` локально (revert'аемо)

**Files:**
- Modify: `apps/frontend/src/canvas/tidy-layout.ts:26-34`
- Modify: `apps/backend/src/routes/layout-selection.ts:84-91, 132-140`

Это **временный snapshot** на отдельной probe-ветке от feature; revert по завершении Phase 1.

- [ ] **Step 1: Создать probe-ветку от feature**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
git checkout -b probe/drw-149-phase1-noop-removal feature/drw-149-autolayout-in-frame
```

- [ ] **Step 2: Снять frontend short-circuit**

Edit `apps/frontend/src/canvas/tidy-layout.ts:26-34` — удалить блок `if (ids.length < 2) { return { kind: "noop", ... }; }`.

После:
```ts
export async function tidyLayout(
  ids: string[],
  space: string,
  room: string,
): Promise<TidyLayoutResult> {
  try {
    const res = await fetch(
      `/api/agent/layout-selection?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`,
      ...
```

- [ ] **Step 3: Снять backend short-circuits**

Edit `apps/backend/src/routes/layout-selection.ts:84-91` — удалить блок rawIds.length === 0 noop (оставить как valid case → продолжить в resolution).
Edit `apps/backend/src/routes/layout-selection.ts:132-140` — удалить блок `affectedIds.size < 2`.

После — backend идёт прямо к runLayout с любым количеством affectedIds.

- [ ] **Step 4: Verify сборка не сломалась**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
bun --cwd apps/backend run --bun build src/index.ts > /dev/null 2>&1; echo "exit=$?"
bun --cwd apps/frontend run --bun build > /dev/null 2>&1; echo "exit=$?"
```

Expected: exit=0 для обоих.

- [ ] **Step 5: Pause-commit (probe state, не для merge)**

```bash
git add apps/frontend/src/canvas/tidy-layout.ts apps/backend/src/routes/layout-selection.ts
git commit -m "probe(drw-149): remove < 2 noop short-circuits — Phase 1 inspection only"
```

### Task 1.2: Probe integration тесты на `runLayoutSubgraph` через 6 cases

**Files:**
- Create: `apps/backend/tests/domain/layout-drw149-probe.test.ts`

Цель — задокументировать **точное** поведение existing `runLayoutSubgraph` для cases из spec'а, не fix'я ничего. Каждый case — отдельный test, проверяющий: какие positions/sizes выходят в batch.updated.

- [ ] **Step 1: Создать probe test file со skeleton**

Write `apps/backend/tests/domain/layout-drw149-probe.test.ts`:

```ts
// DRW-149 Phase 1 probe: точное поведение runLayoutSubgraph для new cases.
// Это inspection-тесты, не assertion-тесты. Output идёт в console.log → findings doc.

import { describe, expect, test } from "bun:test";
import { runLayout } from "../../src/domain/layout";
import type { TLRecord, TLStoreSnapshot } from "../../src/store-types";

function emptySnapshot(): TLStoreSnapshot {
  return {
    schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
    store: {
      "document:document": { id: "document:document", typeName: "document" } as TLRecord,
      "page:page": { id: "page:page", typeName: "page" } as TLRecord,
    },
  };
}

function makeFrame(id: string, opts: { x?: number; y?: number; w?: number; h?: number; parentId?: string; name?: string; meta?: Record<string, unknown> } = {}): TLRecord {
  return {
    id, typeName: "shape", type: "frame",
    x: opts.x ?? 0, y: opts.y ?? 0,
    parentId: opts.parentId ?? "page:page",
    props: { w: opts.w ?? 800, h: opts.h ?? 600, name: opts.name ?? "" },
    meta: opts.meta ?? {},
  } as TLRecord;
}

function makeContainer(id: string, opts: { x?: number; y?: number; w?: number; h?: number; parentId?: string; label?: string } = {}): TLRecord {
  return {
    id, typeName: "shape", type: "geo",
    x: opts.x ?? 0, y: opts.y ?? 0,
    parentId: opts.parentId ?? "page:page",
    props: { w: opts.w ?? 400, h: opts.h ?? 200, geo: "rectangle" },
    meta: { role: "boundary", didrawSubgraph: true, didrawLabel: opts.label ?? "Container" },
  } as TLRecord;
}

function makeService(id: string, opts: { x?: number; y?: number; w?: number; h?: number; parentId?: string; name?: string } = {}): TLRecord {
  return {
    id, typeName: "shape", type: "geo",
    x: opts.x ?? 0, y: opts.y ?? 0,
    parentId: opts.parentId ?? "page:page",
    props: { w: opts.w ?? 100, h: opts.h ?? 60, geo: "rectangle" },
    meta: { didrawName: opts.name ?? id },
  } as TLRecord;
}

describe("DRW-149 probe: runLayoutSubgraph cases", () => {
  test.todo("Case 1: filterToIds = {single frame}");
  test.todo("Case 2: filterToIds = {single shape-container}");
  test.todo("Case 3: filterToIds = {frame, external_shape}");
  test.todo("Case 4: filterToIds = {child1, child2} без parent frame");
  test.todo("Case 5: External arrow inner→outer не двигает inner shape");
  test.todo("Case 6: Pinned envelope остаётся на месте");
});
```

- [ ] **Step 2: Run skeleton — verify todo'ы видны**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
bun --cwd apps/backend test domain/layout-drw149-probe.test.ts
```

Expected: 6 tests skipped (todo), 0 fail.

- [ ] **Step 3: Реализовать Case 1 — single frame**

Заменить `test.todo("Case 1: ...")` на:

```ts
test("Case 1: single frame → children layout + frame resize", async () => {
  const store = emptySnapshot();
  const frame = makeFrame("shape:frame1", { x: 100, y: 100, w: 800, h: 600 });
  const s1 = makeService("shape:s1", { x: 150, y: 150, parentId: "shape:frame1", name: "A" });
  const s2 = makeService("shape:s2", { x: 400, y: 150, parentId: "shape:frame1", name: "B" });
  store.store["shape:frame1"] = frame;
  store.store["shape:s1"] = s1;
  store.store["shape:s2"] = s2;

  const result = await runLayout(store, {
    mode: "layered-tb",
    scope: "affected",
    spacing: "normal",
    affectedIds: new Set(["shape:frame1"]),
  }, new Map());

  console.log("[Case 1] reason:", result.reason);
  console.log("[Case 1] batch.updated keys:", Object.keys(result.batch.updated));
  for (const id of ["shape:frame1", "shape:s1", "shape:s2"]) {
    const upd = result.batch.updated[id];
    console.log(`[Case 1] ${id}:`, upd ? JSON.stringify({ x: upd.x, y: upd.y, w: (upd.props as Record<string, unknown>)?.w, h: (upd.props as Record<string, unknown>)?.h }) : "no change");
  }

  // Probe assertions (loose): frame изменён, дети изменены.
  expect(result.reason).toBeUndefined();
  // НЕ проверяем точные значения — это probe, мы документируем что выходит.
});
```

- [ ] **Step 4: Аналогично реализовать Case 2..6**

Каждый case — отдельный test с конкретным setup (см. probe-таблицу spec'а §Probe-задача) и `console.log`'ом всех значимых полей. Probe assertion'ы — только `expect(result.reason).toBeUndefined()` (то есть layout не падает).

```ts
test("Case 2: single shape-container внутри schema-frame", async () => {
  const store = emptySnapshot();
  store.store["shape:sf"] = makeFrame("shape:sf", { x: 0, y: 0, w: 1000, h: 800 });
  store.store["shape:c1"] = makeContainer("shape:c1", { x: 50, y: 50, w: 300, h: 200, parentId: "shape:sf", label: "Ingress" });
  store.store["shape:s1"] = makeService("shape:s1", { x: 70, y: 70, parentId: "shape:c1", name: "A" });
  store.store["shape:s2"] = makeService("shape:s2", { x: 200, y: 70, parentId: "shape:c1", name: "B" });

  const result = await runLayout(store, {
    mode: "layered-tb", scope: "affected", spacing: "normal",
    affectedIds: new Set(["shape:c1"]),
  }, new Map());

  console.log("[Case 2] updated:", Object.keys(result.batch.updated));
  for (const id of ["shape:sf", "shape:c1", "shape:s1", "shape:s2"]) {
    const upd = result.batch.updated[id];
    console.log(`[Case 2] ${id}:`, upd ? JSON.stringify({ x: upd.x, y: upd.y, props_w: (upd.props as Record<string, unknown>)?.w, props_h: (upd.props as Record<string, unknown>)?.h }) : "no change");
  }
  expect(result.reason).toBeUndefined();
});

test("Case 3: frame + external", async () => {
  const store = emptySnapshot();
  store.store["shape:sf"] = makeFrame("shape:sf", { x: 100, y: 100, w: 800, h: 600 });
  store.store["shape:s1"] = makeService("shape:s1", { x: 150, y: 150, parentId: "shape:sf", name: "A" });
  store.store["shape:s2"] = makeService("shape:s2", { x: 300, y: 150, parentId: "shape:sf", name: "B" });
  store.store["shape:ext"] = makeService("shape:ext", { x: 1000, y: 200, name: "External" });

  const result = await runLayout(store, {
    mode: "layered-tb", scope: "affected", spacing: "normal",
    affectedIds: new Set(["shape:sf", "shape:ext"]),
  }, new Map());

  console.log("[Case 3] updated:", Object.keys(result.batch.updated));
  for (const id of ["shape:sf", "shape:s1", "shape:s2", "shape:ext"]) {
    const upd = result.batch.updated[id];
    console.log(`[Case 3] ${id}:`, upd ? JSON.stringify({ x: upd.x, y: upd.y, props_w: (upd.props as Record<string, unknown>)?.w, props_h: (upd.props as Record<string, unknown>)?.h }) : "no change");
  }
  expect(result.reason).toBeUndefined();
});

test("Case 4: только дети frame, без frame в selection", async () => {
  const store = emptySnapshot();
  store.store["shape:sf"] = makeFrame("shape:sf", { x: 100, y: 100, w: 800, h: 600 });
  store.store["shape:s1"] = makeService("shape:s1", { x: 150, y: 150, parentId: "shape:sf", name: "A" });
  store.store["shape:s2"] = makeService("shape:s2", { x: 400, y: 150, parentId: "shape:sf", name: "B" });

  const result = await runLayout(store, {
    mode: "layered-tb", scope: "affected", spacing: "normal",
    affectedIds: new Set(["shape:s1", "shape:s2"]),
  }, new Map());

  console.log("[Case 4] updated:", Object.keys(result.batch.updated));
  for (const id of ["shape:sf", "shape:s1", "shape:s2"]) {
    const upd = result.batch.updated[id];
    console.log(`[Case 4] ${id}:`, upd ? JSON.stringify({ x: upd.x, y: upd.y, props_w: (upd.props as Record<string, unknown>)?.w, props_h: (upd.props as Record<string, unknown>)?.h }) : "no change");
  }
  expect(result.reason).toBeUndefined();
});

test("Case 5: external arrow inner→outer не двигает inner shape", async () => {
  const store = emptySnapshot();
  store.store["shape:sf"] = makeFrame("shape:sf", { x: 0, y: 0, w: 800, h: 600 });
  store.store["shape:in"] = makeService("shape:in", { x: 100, y: 100, parentId: "shape:sf", name: "Inner" });
  store.store["shape:in2"] = makeService("shape:in2", { x: 300, y: 100, parentId: "shape:sf", name: "Inner2" });
  store.store["shape:ext"] = makeService("shape:ext", { x: 1000, y: 100, name: "External" });
  // Arrow from inner to external
  store.store["shape:arr"] = {
    id: "shape:arr", typeName: "shape", type: "arrow",
    x: 0, y: 0, parentId: "page:page", props: {}, meta: { connectionKind: "sync" },
  } as TLRecord;
  store.store["binding:arr-s"] = { id: "binding:arr-s", typeName: "binding", fromId: "shape:arr", toId: "shape:in", props: { terminal: "start" } } as TLRecord;
  store.store["binding:arr-e"] = { id: "binding:arr-e", typeName: "binding", fromId: "shape:arr", toId: "shape:ext", props: { terminal: "end" } } as TLRecord;

  const result = await runLayout(store, {
    mode: "layered-tb", scope: "affected", spacing: "normal",
    affectedIds: new Set(["shape:sf"]),
  }, new Map());

  console.log("[Case 5] updated:", Object.keys(result.batch.updated));
  console.log("[Case 5] shape:in updated?", result.batch.updated["shape:in"]);
  console.log("[Case 5] shape:ext updated?", result.batch.updated["shape:ext"]);
  // Probe: external НЕ должен быть в updated (inner pass его не трогает).
  expect(result.reason).toBeUndefined();
});

test("Case 6: pinned envelope остаётся на месте", async () => {
  const store = emptySnapshot();
  store.store["shape:sf"] = makeFrame("shape:sf", { x: 100, y: 100, w: 800, h: 600, meta: { pinned: true } });
  store.store["shape:s1"] = makeService("shape:s1", { x: 150, y: 150, parentId: "shape:sf", name: "A" });
  store.store["shape:s2"] = makeService("shape:s2", { x: 400, y: 150, parentId: "shape:sf", name: "B" });

  const result = await runLayout(store, {
    mode: "layered-tb", scope: "affected", spacing: "normal",
    affectedIds: new Set(["shape:sf"]),
  }, new Map());

  console.log("[Case 6] frame updated:", result.batch.updated["shape:sf"]);
  // Probe: frame.x/y должны остаться 100, 100.
  expect(result.reason).toBeUndefined();
});
```

- [ ] **Step 5: Запустить probe тесты и снять console output**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
bun --cwd apps/backend test domain/layout-drw149-probe.test.ts 2>&1 | tee /tmp/drw-149-probe-output.txt
```

Expected: 6 tests pass (loose assertions). Console.log lines захвачены в `/tmp/drw-149-probe-output.txt`.

- [ ] **Step 6: Commit probe тесты**

```bash
git add apps/backend/tests/domain/layout-drw149-probe.test.ts
git commit -m "probe(drw-149): integration tests на runLayoutSubgraph для 6 use cases"
```

### Task 1.3: WS-sync pipeline probe для undo стратегии

**Files:**
- Read: `apps/frontend/src/transport/ws.ts`
- Read: any apply-patch handler

- [ ] **Step 1: Прочитать ws.ts и связанный apply-flow**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
wc -l apps/frontend/src/transport/ws.ts
grep -nE "applyStoreChanges|store\.put|store\.mergeRemoteChanges|markHistoryStoppingPoint|editor\.batch|echo" apps/frontend/src/transport/ws.ts
```

Expected: понимаем где и как WS patch'и попадают в tldraw store; есть ли echo-guard; есть ли history wrap.

- [ ] **Step 2: Проверить tldraw 5.x history API**

Прочитать `docs/references/tldraw-cheatsheet.md` (memory `feedback-tldraw-docs`). Если нет нужной информации — fetch https://tldraw.dev/docs/editor (особенно `Editor.markHistoryStoppingPoint`, `Editor.updateShapes`, `Editor.batch`).

- [ ] **Step 3: Записать findings в probe doc (см. Task 1.4)**

### Task 1.4: Записать probe findings + выбрать undo подход

**Files:**
- Create: `docs/superpowers/specs/2026-05-24-drw-149-probe-findings.md`

- [ ] **Step 1: Зафиксировать findings**

Write `docs/superpowers/specs/2026-05-24-drw-149-probe-findings.md`:

```markdown
# DRW-149 Phase 1 — Probe findings

**Дата:** 2026-05-24
**Probe ветка:** probe/drw-149-phase1-noop-removal
**Источник:** `apps/backend/tests/domain/layout-drw149-probe.test.ts` console output + чтение `apps/frontend/src/transport/ws.ts`.

## Case 1: single frame selection

[Заполнить console output: что попадает в batch.updated, какие x/y/w/h]

**Вывод:** [работает корректно / частично / не работает; конкретный gap если есть]

## Case 2: single shape-container

[аналогично]

## Case 3: frame + external

[аналогично]

## Case 4: child-only selection

[аналогично]

## Case 5: external arrow filtering

[аналогично — конкретно проверить что shape:in НЕ в updated если он на правильной позиции]

## Case 6: pinned envelope

[аналогично — проверить что shape:sf.x/y осталось 100, 100]

## Реальные gap'ы (что точно надо фиксить)

- Gap A: [короткое описание + конкретное место в коде]
- Gap B: ...
- (если gap'ов нет — отлично, переходим на Phase 4)

## WS-sync pipeline (для undo)

- Текущий flow: WS message → [конкретный path в ws.ts] → tldraw store
- Echo-guard: [есть/нет; где]
- markHistoryStoppingPoint API в tldraw 5.x: [да/нет; пример использования]

## Выбор undo стратегии

- α (server-hint + frontend wrap): [pros/cons в нашей кодовой базе]
- β (client-driven apply): [pros/cons в нашей кодовой базе]
- **Выбор:** [α или β + reason]

## Phase 3 tasks (на основе gap'ов)

- Task 3.1: [fix Gap A]
- Task 3.2: [fix Gap B]
- (если 0 gaps — Phase 3 пропускается)
```

- [ ] **Step 2: Commit findings doc**

```bash
git add docs/superpowers/specs/2026-05-24-drw-149-probe-findings.md
git commit -m "docs(drw-149): Phase 1 probe findings — gaps + undo strategy"
```

### Task 1.5: Cleanup probe state — revert short-circuit removal на probe-ветке

**Files:**
- Modify (revert): `apps/frontend/src/canvas/tidy-layout.ts`
- Modify (revert): `apps/backend/src/routes/layout-selection.ts`

Probe-ветка нужна только для observation. После findings — revert и delete probe branch; реальное removal — в Phase 2 на feature ветке.

- [ ] **Step 1: Cherry-pick probe-test commit в feature ветку**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
# id probe-test commit'а из git log probe/drw-149-phase1-noop-removal
PROBE_TEST_SHA=$(git log probe/drw-149-phase1-noop-removal --format=%H -- apps/backend/tests/domain/layout-drw149-probe.test.ts | head -1)
PROBE_FINDINGS_SHA=$(git log probe/drw-149-phase1-noop-removal --format=%H -- docs/superpowers/specs/2026-05-24-drw-149-probe-findings.md | head -1)
git checkout feature/drw-149-autolayout-in-frame
git cherry-pick $PROBE_TEST_SHA $PROBE_FINDINGS_SHA
```

- [ ] **Step 2: Удалить probe-ветку**

```bash
git branch -D probe/drw-149-phase1-noop-removal
git branch --show-current  # feature/drw-149-autolayout-in-frame
```

---

## Phase 2 — Short-circuit removal

### Task 2.1: Удалить `< 2 noop` в frontend `tidy-layout.ts`

**Files:**
- Modify: `apps/frontend/src/canvas/tidy-layout.ts:26-34`
- Test: `apps/frontend/src/canvas/tidy-layout.test.ts`

- [ ] **Step 1: Написать failing test — single id передаётся в fetch**

Edit `apps/frontend/src/canvas/tidy-layout.test.ts` — добавить тест:

```ts
test("DRW-149: single id passes through to backend (no noop short-circuit)", async () => {
  const fetchMock = mock<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify({ ok: true, count: 0 }))),
  );
  globalThis.fetch = fetchMock;
  const r = await tidyLayout(["shape:foo"], "default", "test-room");
  expect(r.kind).toBe("ok");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
```

(Импорты mock/expect — следовать существующему стилю в файле.)

- [ ] **Step 2: Run test → ожидаем FAIL**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
bun test --cwd apps/frontend src/canvas/tidy-layout.test.ts
```

Expected: FAIL "expected kind: ok, got noop" (или похожее) — short-circuit ещё активен.

- [ ] **Step 3: Удалить short-circuit в `tidy-layout.ts:26-34`**

Удалить:
```ts
if (ids.length < 2) {
  return {
    kind: "noop",
    reason:
      ids.length === 0
        ? "no shapes selected — select shapes first"
        : "need 2+ shapes to tidy",
  };
}
```

Также удалить jsdoc-блок про "noop if fewer than 2" (lines 11-15) — устарел.

- [ ] **Step 4: Run test → ожидаем PASS**

```bash
bun test --cwd apps/frontend src/canvas/tidy-layout.test.ts
```

Expected: PASS. Также проверить что existing тесты не сломались — пройти весь файл.

- [ ] **Step 5: Удалить устаревшие тесты на `< 2 noop`**

Найти в `tidy-layout.test.ts` тесты которые expect'ят noop для 0/1 id — обновить под новое поведение или удалить:

```bash
grep -nE "noop|need 2\+" apps/frontend/src/canvas/tidy-layout.test.ts
```

Каждый из них либо update'ить (now expect ok), либо delete если duplicate с новым.

- [ ] **Step 6: Run frontend tests целиком**

```bash
bun test --cwd apps/frontend src
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/canvas/tidy-layout.ts apps/frontend/src/canvas/tidy-layout.test.ts
git commit -m "feat(drw-149): remove < 2 noop short-circuit в frontend tidy-layout"
```

### Task 2.2: Удалить `< 2 noop` в backend `layout-selection.ts`

**Files:**
- Modify: `apps/backend/src/routes/layout-selection.ts:84-91, 132-140`
- Test: `apps/backend/tests/routes-layout-selection.test.ts`

- [ ] **Step 1: Написать failing test — single id даёт 200 ok count=0 (не error)**

Edit `apps/backend/tests/routes-layout-selection.test.ts` — добавить:

```ts
test("DRW-149: single id → 200 ok count=0 (не need-2-noop)", async () => {
  const { app } = await setupRouteTest();  // следовать существующему стилю setup
  const res = await app.request("/api/agent/layout-selection?room=test-room", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["shape:foo"] }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.count).toBe(0);
});
```

- [ ] **Step 2: Run test → ожидаем FAIL**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
bun --cwd apps/backend test routes-layout-selection.test.ts
```

Expected: FAIL — backend всё ещё возвращает hint "need 2+".

- [ ] **Step 3: Удалить два `< 2 noop` блока в `layout-selection.ts`**

Удалить lines 84-91 (rawIds.length === 1 branch):
```ts
if (rawIds.length === 1) { return c.json({ ok: true, count: 0, hint: "..." }); }
```

Также удалить lines 132-140 (affectedIds.size < 2 branch):
```ts
if (affectedIds.size < 2) { return c.json({ ok: true, count: 0, hint: "..." }); }
```

Оставить только: rawIds.length === 0 → noop ok (line 76-82); и all-unresolved → 400 (lines 121-130).

- [ ] **Step 4: Run test → ожидаем PASS**

```bash
bun --cwd apps/backend test routes-layout-selection.test.ts
```

Expected: PASS. Полный test file должен пройти.

- [ ] **Step 5: Обновить existing тесты которые ожидают `< 2 noop`**

```bash
grep -nE "need 2|< 2|tidy noop" apps/backend/tests/routes-layout-selection.test.ts
```

Каждый — update под новое поведение или удалить.

- [ ] **Step 6: Run backend tests целиком**

```bash
bun --cwd apps/backend test
```

Expected: all green. Если есть unrelated failures — изучить и адресовать.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/routes/layout-selection.ts apps/backend/tests/routes-layout-selection.test.ts
git commit -m "feat(drw-149): remove < 2 noop short-circuits в backend layout-selection"
```

---

## Phase 3 — Gap fixes (TBD по Phase 1 findings)

**Задачи добавляются после Phase 1 (Task 1.4).** Каждый gap → один subagent task. Шаблон task'а:

### Task 3.X: [Описание gap'а из probe findings]

**Files:**
- Modify: [конкретный файл и line range из probe]
- Test: [подходящий test file]

- [ ] **Step 1: Написать failing test, который воспроизводит gap**
- [ ] **Step 2: Run test → FAIL**
- [ ] **Step 3: Implement точечный fix**
- [ ] **Step 4: Run test → PASS**
- [ ] **Step 5: Run полный test suite затронутого пакета**
- [ ] **Step 6: Commit**

**Возможные ожидаемые gap'ы (для evaluation в Phase 1):**

- **Gap candidate A:** Single-node Pass B short-circuit (`layout.ts:683-700`) может не писать `props.w/h` для frame в `positions[]` (возвращает только x/y). Если probe Case 1 показывает что frame.props.w/h не появляется в batch.updated — fix добавить w/h в positions.
- **Gap candidate B:** Resize shape-container (geo, lines 718-731 Pass C для top-level positions) — может не писать `props.w/h` правильно (writes positions[id].w/h но `runLayout` после Pass C должен сконвертить в `batch.updated[id].props.w/h`). Probe Case 2.
- **Gap candidate C:** Cross-boundary edge filtering в Pass A (`buildEdges` line 155+) — если probe Case 5 показывает что `shape:in` двигается через arrow к external — fix `includedIds` filter.

---

## Phase 4 — Integration tests на route

### Task 4.1: Frame-only selection integration test

**Files:**
- Modify: `apps/backend/tests/routes-layout-selection.test.ts`

- [ ] **Step 1: Написать integration test — frame selected → layout children + resize frame**

```ts
test("DRW-149 AC-1: frame-only selection → children layout + frame resize", async () => {
  const { app, room } = await setupRouteTestWithRoom();
  // Setup: room с одним frame и 3 services внутри.
  await app.request("/api/patch?room=" + room, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      added: {
        "shape:f": { id: "shape:f", typeName: "shape", type: "frame", x: 0, y: 0, parentId: "page:page", props: { w: 800, h: 600, name: "" }, meta: {} },
        "shape:s1": { id: "shape:s1", typeName: "shape", type: "geo", x: 50, y: 50, parentId: "shape:f", props: { w: 100, h: 60, geo: "rectangle" }, meta: { didrawName: "A" } },
        "shape:s2": { id: "shape:s2", typeName: "shape", type: "geo", x: 200, y: 50, parentId: "shape:f", props: { w: 100, h: 60, geo: "rectangle" }, meta: { didrawName: "B" } },
        "shape:s3": { id: "shape:s3", typeName: "shape", type: "geo", x: 350, y: 50, parentId: "shape:f", props: { w: 100, h: 60, geo: "rectangle" }, meta: { didrawName: "C" } },
      },
    }),
  });

  const res = await app.request("/api/agent/layout-selection?room=" + room, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["shape:f"] }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.count).toBeGreaterThan(0);
  expect(body.affected).toContain("shape:f");
  expect(body.affected).toContain("shape:s1");
});
```

- [ ] **Step 2: Run test**

```bash
bun --cwd apps/backend test routes-layout-selection.test.ts -t "frame-only"
```

Expected: PASS (если Phase 3 fixes сделаны корректно).

- [ ] **Step 3: Аналогично написать tests для AC-2..AC-8**

- AC-2: children-of-frame only selection — same visual result.
- AC-3: frame + external — 2 passes verified.
- AC-4: single shape → ok count=0.
- AC-5: empty selection → ok count=0.
- AC-6: nested shape-containers (схема с 2+ уровнями).
- AC-7: external arrow filtering — inner shape stays inside frame.
- AC-8: pinned shape — не двигается.

(Каждый тест — отдельный `test(...)` в том же файле.)

- [ ] **Step 4: Run integration tests целиком**

```bash
bun --cwd apps/backend test routes-layout-selection.test.ts
```

Expected: all 8 new tests pass + existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/tests/routes-layout-selection.test.ts
git commit -m "test(drw-149): integration coverage для AC-1..AC-8"
```

---

## Phase 5 — Undo support (G7)

**Подход выбран в Phase 1 (Task 1.4). Plan ниже исходит из β (client-driven apply) — если выбран α, заменить Step 1-4.**

### Task 5.1: Реализация β — client-driven apply с history wrap

**Files:**
- Modify: backend route (response с explicit positions): `apps/backend/src/routes/layout-selection.ts`
- Modify: frontend apply: `apps/frontend/src/transport/ws.ts` или специфический apply layer (определено в Phase 1)
- Test: `apps/frontend/src/canvas/tidy-layout.test.ts` — undo-wrap test

- [ ] **Step 1: Backend — добавить `positions` в response**

Edit `apps/backend/src/routes/layout-selection.ts` после `const count = ...`:

```ts
const positions: Array<{ id: string; x?: number; y?: number; w?: number; h?: number }> = [];
for (const [id, rec] of Object.entries(lr.batch.updated)) {
  const r = rec as Record<string, unknown> & { x?: number; y?: number; props?: Record<string, unknown> };
  positions.push({
    id,
    x: r.x,
    y: r.y,
    w: (r.props as Record<string, unknown> | undefined)?.w as number | undefined,
    h: (r.props as Record<string, unknown> | undefined)?.h as number | undefined,
  });
}
// в return body добавить positions:
return c.json({ ok: true, version: r.version, count, affected: lr.affected, positions, unresolved: ... });
```

- [ ] **Step 2: Frontend — `tidyLayout` apply через editor с history wrap**

Edit `apps/frontend/src/canvas/tidy-layout.ts`:

```ts
import type { Editor } from "tldraw";

export async function tidyLayout(
  ids: string[],
  space: string,
  room: string,
  editor: Editor,  // новый параметр
): Promise<TidyLayoutResult> {
  try {
    const res = await fetch(...);
    const json = await res.json();
    if (json.ok && Array.isArray(json.positions)) {
      editor.markHistoryStoppingPoint("Autolayout");
      editor.run(() => {
        for (const p of json.positions) {
          const upd: Record<string, unknown> = {};
          if (typeof p.x === "number") upd.x = p.x;
          if (typeof p.y === "number") upd.y = p.y;
          const propsUpd: Record<string, unknown> = {};
          if (typeof p.w === "number") propsUpd.w = p.w;
          if (typeof p.h === "number") propsUpd.h = p.h;
          if (Object.keys(propsUpd).length > 0) upd.props = propsUpd;
          editor.updateShape({ id: p.id, type: editor.getShape(p.id)?.type, ...upd });
        }
      }, { history: "record" });
    }
    return { kind: "ok", count: json.count ?? 0, affected: json.affected ?? [], version: json.version };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
```

**Note:** точный API tldraw 5.x для history wrap нужно verify в Phase 1 (Task 1.3) — `editor.run` или `editor.batch` или `editor.history.run` — после probe выбрать корректный.

- [ ] **Step 3: Echo-guard — frontend skipает WS-echo своего же autolayout**

Если frontend применил локально через `editor.updateShape`, его же WS-broadcast будет дублировать. Frontend WS-handler должен skip applying patch, если он originated от текущего клиента.

Edit `apps/frontend/src/transport/ws.ts` — добавить проверку (если ещё нет): patch.source = "ai" + version match → skip. (Точное место — в Phase 1 определено.)

- [ ] **Step 4: Update `makeTidyHotkeyHandler` чтобы передавать editor**

Edit `apps/frontend/src/canvas/tidy-layout.ts:83-95`:

```ts
export function makeTidyHotkeyHandler(
  getSelectedIds: () => string[],
  onTidy: (ids: string[]) => void,
): (e: KeyboardEvent) => void {
  // unchanged
}
```

Callsite (где вызывается tidyLayout) — добавить editor:
```bash
grep -nE "tidyLayout\(" apps/frontend/src
```

В каждом callsite — передать editor.

- [ ] **Step 5: Test — undo round-trip**

Edit `apps/frontend/src/canvas/tidy-layout.test.ts`:

```ts
test("DRW-149 AC-12: undo возвращает state в pre-layout snapshot", async () => {
  // Setup mock editor с initial shape positions.
  // tidyLayout → editor.updateShape calls.
  // editor.undo() → проверить что positions вернулись в исходные.
  // (Точная реализация зависит от того есть ли mock editor или нужен real tldraw test setup.)
});
```

(Если mock editor не доступен — отметить как `test.todo` и переложить в Phase 6 manual test.)

- [ ] **Step 6: Run tests**

```bash
bun test --cwd apps/frontend src/canvas/tidy-layout.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/routes/layout-selection.ts apps/frontend/src/canvas/tidy-layout.ts apps/frontend/src/transport/ws.ts apps/frontend/src/canvas/tidy-layout.test.ts
git commit -m "feat(drw-149): client-driven undo wrap для Cmd+Shift+L (G7, AC-12)"
```

---

## Phase 6 — Manual E2E + dogfooding

### Task 6.1: Manual test plan markdown

**Files:**
- Create: `docs/manual-tests/drw-149-autolayout-in-frame.md`

- [ ] **Step 1: Написать checklist**

Write `docs/manual-tests/drw-149-autolayout-in-frame.md`:

```markdown
# DRW-149 Manual test checklist

**Preconditions:**
- Локальный backend daemon запущен (`shemma daemon start --profile release`).
- Frontend dev запущен (`bun run dev`).
- Чистая тестовая комната (см. setup).

## Setup

1. Создать тестовую комнату через CLI:
   ```bash
   shemma open --room drw-149-test --space di-draw
   ```
2. Импортировать тестовый mermaid через MCP `shemma_import_mermaid mode=browser`:
   ```
   flowchart TB
     subgraph INPUT [Вход]
       SE[SourceEvent]
     end
     subgraph ORCH [Оркестрация]
       ER[EventRouter]
       EP[EventPolicyProtocol]
     end
     subgraph CONSUMERS [Потребители]
       IC[Internal consumer]
       PB[Public boundary]
     end
     SE --> ER
     ER --> EP
     EP --> IC
     EP --> PB
   ```

## Test 1 — AC-1: Cmd+Shift+L на schema-frame

- [ ] Выделить только schema-frame (клик на frame border).
- [ ] Нажать Cmd+Shift+L.
- [ ] Ожидается: все subgraph'ы и services внутри выровнены TB; schema-frame resize'нулся под bbox + padding; визуальный конфликтов нет.

## Test 2 — AC-2: Cmd+Shift+L на children frame'а

- [ ] Выделить рамкой все объекты внутри schema-frame (без самого frame).
- [ ] Нажать Cmd+Shift+L.
- [ ] Ожидается: результат **визуально совпадает** с Test 1.

## Test 3 — AC-3: Cmd+Shift+L на frame + external

- [ ] Создать дополнительный shape (просто rect) **вне** schema-frame.
- [ ] Выделить schema-frame + new external shape.
- [ ] Нажать Cmd+Shift+L.
- [ ] Ожидается: ни один child schema-frame не оказался вне его границ; external shape и schema-frame стоят как peers в общем layout.

## Test 4 — AC-4: Single shape

- [ ] Выделить один service (например EP).
- [ ] Нажать Cmd+Shift+L.
- [ ] Ожидается: ничего не происходит, никаких ошибок в console.

## Test 5 — AC-7: External arrow filtering

- [ ] Из service inside schema-frame нарисовать arrow к external shape.
- [ ] Выделить schema-frame, нажать Cmd+Shift+L.
- [ ] Ожидается: inner service остался внутри schema-frame.

## Test 6 — AC-8: Pinned shape

- [ ] Зафиксировать один service через context menu → Pin (или через meta.pinned=true).
- [ ] Выделить schema-frame, нажать Cmd+Shift+L.
- [ ] Ожидается: pinned service не сдвинулся.

## Test 7 — AC-12: Undo

- [ ] Сделать снимок состояния (shemma_canvas_view).
- [ ] Cmd+Shift+L (любой случай выше).
- [ ] Cmd+Z (undo).
- [ ] Проверить shemma_canvas_view → должно совпадать с pre-layout snapshot.
- [ ] Cmd+Shift+Z (redo).
- [ ] Проверить snapshot → должно совпадать с post-layout.

## Cleanup

```bash
shemma delete --room drw-149-test --space di-draw
```
```

- [ ] **Step 2: Commit**

```bash
git add docs/manual-tests/drw-149-autolayout-in-frame.md
git commit -m "test(drw-149): manual E2E checklist"
```

### Task 6.2: Dogfooding на user'овой dev default комнате

- [ ] **Step 1: Подтвердить с user'ом что dev default почищена от дубликатов**

Через диалог — user сам выполнил cleanup (см. brainstorm).

- [ ] **Step 2: Запустить manual checklist Test 1-7 на dev default**

Открыть `http://localhost:5173/?space=di-draw&room=default` в Chrome (после fix DRW-147 — иначе URL может быть другим). Пройти все тесты, отметить результаты в issue/comment.

- [ ] **Step 3: Если найдены regression'ы — open issue + fix или vынести в follow-up**

---

## Phase 7 — Release

### Task 7.1: Verify all tests pass

- [ ] **Step 1: Run полный test suite**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
bun run test
```

Expected: 0 failures across all packages (backend, frontend, domain, cli, mcp, client).

```bash
bun test --cwd apps/frontend src
```

Expected: 0 failures (frontend tests run separately per package.json convention).

### Task 7.2: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Добавить запись для 0.25.0**

Edit `CHANGELOG.md` — добавить перед `## 0.24.0`:

```markdown
## 0.25.0 — 2026-05-XX — DRW-149 Autolayout в schema-frame

### Added
- Cmd+Shift+L (Tidy) корректно работает на schema-frame: рекурсивный bottom-up layout его детей с resize envelope под bbox + padding.
- Frame + external selection — frame участвует во внешнем layout как монолит после внутреннего pass'а.
- Autolayout — атомарная undo-able операция (одно Cmd+Z откатывает всё; Cmd+Shift+Z восстанавливает).

### Changed
- Snap < 2 noop short-circuit в frontend `tidy-layout` и backend `layout-selection`. Single shape selection → 200 ok count=0 без error.
- External arrows (binding inner→outer) фильтруются на inner pass — не тянут inner shapes наружу.

### Fixed
- [перечислить gap fixes из Phase 3 если были]

### Tracked
- Closes DRW-149.

### Related (separate tickets)
- DRW-147 (storage paths), DRW-148 (legacy v1 cleanup), DRW-150 (custom schema-container shape), DRW-151 (research native mermaid), DRW-152 (per-subgraph direction), DRW-153 (mermaid style directives).
```

- [ ] **Step 2: Commit CHANGELOG**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): 0.25.0 — DRW-149 autolayout в schema-frame"
```

### Task 7.3: Release commit + tag + merge

- [ ] **Step 1: Bump version в package.json (если применимо)**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
grep version package.json
# Если 0.24.0 — bump:
# Используем bun pm version или ручное редактирование.
```

Memory `feedback-versioning-tags-only-on-release`: tag + release commit только при настоящем релизе — это он.

- [ ] **Step 2: Release commit**

```bash
git commit --allow-empty -m "release: 0.25.0 — DRW-149 autolayout в schema-frame"
```

(Или объединить с CHANGELOG/version bump в один commit.)

- [ ] **Step 3: Switch на main и merge feature --no-ff**

```bash
git checkout main
git merge --no-ff feature/drw-149-autolayout-in-frame -m "merge: feature/drw-149-autolayout-in-frame → main (0.25.0)"
```

- [ ] **Step 4: Tag на release commit**

```bash
git tag -a 0.25.0 -m "0.25.0 — DRW-149 autolayout в schema-frame с bottom-up + undo support"
git describe --tags
```

Expected: `0.25.0`.

- [ ] **Step 5: Cleanup feature branch (локально)**

```bash
git branch -d feature/drw-149-autolayout-in-frame
git branch
```

Expected: только main.

- [ ] **Step 6: НЕ push** (memory `feedback-no-remote-push` — push только по explicit user request).

### Task 7.4: Update backlog DRW-149 — Done

```bash
backlog task edit DRW-149 -s "Done" --final-summary "Shipped как 0.25.0. Все AC-1..AC-12 covered. Closes DRW-149."
```

(Не archive — archive только после приёмки user'ом, per memory feedback-backlog-status-lifecycle.)

---

## Self-review checklist (для меня, не для engineer'а)

Перед хэндом'офом в execution — пройтись по плану:

- [ ] **Spec coverage:** каждое G1-G7 и AC-1..AC-12 → есть task. Особенно G7/AC-12 → Phase 5.
- [ ] **Placeholder scan:** Phase 3 явно помечен как "TBD по Phase 1 findings" — это **acceptable placeholder**, потому что content зависит от probe. Не нарушение "no placeholders" правила skill — задача explicit conditional. Другие placeholder'ы — нет.
- [ ] **Type consistency:** `tidyLayout` signature меняется в Phase 5 (добавляется `editor` param) — callsite update упомянут в Step 4 Task 5.1.

Если что-то не покрыто — добавить task.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-24-drw-149-autolayout-in-frame-plan.md`.

**Два варианта выполнения:**

1. **Subagent-Driven (рекомендую)** — координатор (Opus) спавнит свежий Sonnet subagent на каждую задачу, между задачами phase-end review (после Phase 3 и Phase 7). Быстрая итерация, минимальный контекст-полл.

2. **Inline Execution** — выполнить tasks в текущей сессии через `executing-plans` skill, batch execution с checkpoints.

**Какой подход?** (После выбора — invoke соответствующий skill.)
