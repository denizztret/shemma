# Frame & Container Direction + Layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Frame получает Direction + Layout settings ровно как schema-container (instant apply через `meta.didrawDirection` + `meta.didrawLayoutParams`); BoardPanel настройки rebrand'ятся в визуальные defaults; чинится bug "frame схлопывается при re-layout одного контейнера".

**Architecture:** Domain extension (meta keys) + per-anchor params override в `runLayoutSubgraph` + frontend writers (polymorphic) + UI rebrand (badge) + scope heuristic (single container/frame → `scope:"self"`).

**Tech Stack:** Bun + Hono backend; React + tldraw 5.x frontend; ELK layout engine; `@shemma/domain` SSOT package.

**Spec:** `docs/superpowers/specs/2026-05-27-frame-container-direction-layout-design.md` v0.1.1.

**Baseline:** main HEAD `ad5825d` (DRW-179 Settings Popover merged 2026-05-27); branch `feature/frame-container-direction-layout` from `5e60809`.

---

## Task 0: Investigate Pass C leak — repro bug в тесте

**Цель:** Понять, есть ли реальная утечка в `runLayoutSubgraph` Pass C (или это чисто frontend issue — `scope` не передаётся). От этого зависит scope task #5.

**Files:**
- Create: `apps/backend/tests/layout-selection-scope-invariant.test.ts` (skeleton; repro only)

- [ ] **Step 1: Создать test файл с repro fixture**

```ts
// apps/backend/tests/layout-selection-scope-invariant.test.ts
import { describe, expect, it } from "bun:test";
import { runLayout } from "../src/domain/layout";
import type { TLStoreSnapshot } from "../src/store-types";

describe("DRW: scope:'self' invariant — frame size preservation", () => {
  it("repro: scope:'self' + ids=[container внутри frame] → batch не должен содержать frame props.w/h update", async () => {
    // Setup: frame containing schema-container with 2 children
    const store: TLStoreSnapshot = {
      schemaVersion: 1,
      store: {
        "page:page": { id: "page:page", typeName: "page" } as any,
        "shape:frameA": {
          id: "shape:frameA",
          typeName: "shape",
          type: "frame",
          parentId: "page:page",
          x: 0, y: 0,
          props: { w: 600, h: 400, name: "frame A", color: "black" },
          meta: {},
        } as any,
        "shape:container1": {
          id: "shape:container1",
          typeName: "shape",
          type: "schema-container",
          parentId: "shape:frameA",
          x: 20, y: 60,
          props: { w: 200, h: 200, direction: "TB" },
          meta: {},
        } as any,
        "shape:leaf1": {
          id: "shape:leaf1",
          typeName: "shape",
          type: "geo",
          parentId: "shape:container1",
          x: 10, y: 10,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as any,
        "shape:leaf2": {
          id: "shape:leaf2",
          typeName: "shape",
          type: "geo",
          parentId: "shape:container1",
          x: 100, y: 10,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as any,
      },
    };
    
    const result = await runLayout(
      store,
      {
        mode: "layered-tb",
        scope: "affected",
        affectedIds: new Set(["shape:container1"]),
        containerScope: "self",
      },
      new Map(),
    );
    
    // ASSERTION: frame size MUST NOT be in batch.updated
    const frameUpdate = result.batch.updated["shape:frameA"];
    expect(frameUpdate).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test — наблюдать результат**

```bash
bun --cwd apps/backend test layout-selection-scope-invariant.test.ts
```

Expected: PASS или FAIL — оба варианта информативны.
- **PASS:** утечки в backend нет, fix self-contained в frontend (task #5 = добавить только regression test).
- **FAIL:** утечка есть, task #5 = реальный fix + этот же тест зеленеет.

- [ ] **Step 3: Зафиксировать findings**

В commit message + в task #5 description. Если FAIL — приложить debug-output `console.log(result.batch.updated)` для понимания где frame появляется.

- [ ] **Step 4: Commit (даже если test fails — это baseline для task #5)**

```bash
git add apps/backend/tests/layout-selection-scope-invariant.test.ts
git commit -m "test(frame-container): task #0 repro for scope:'self' frame leak investigation"
```

---

## Task 1: `ContainerLayoutOverride` type alias в `@shemma/domain`

**Files:**
- Modify: `packages/shemma-domain/src/layout-params.ts`
- Test: `packages/shemma-domain/test/layout-params.test.ts` (если есть, иначе создать)

- [ ] **Step 1: Найти текущий export `LayoutParams`**

```bash
grep -n "LayoutParams\|export" packages/shemma-domain/src/layout-params.ts | head
```

- [ ] **Step 2: Добавить exported type alias**

В конце файла `packages/shemma-domain/src/layout-params.ts`:

```ts
/**
 * Container-level override для layout params (frame OR schema-container).
 * `null` — сигнализирует backend удалить meta key (см. spec 4.1).
 * Stored on `shape.meta.didrawLayoutParams`.
 */
export type ContainerLayoutOverride = Partial<LayoutParams> | null;
```

- [ ] **Step 3: Re-export из package index**

Если есть `packages/shemma-domain/src/index.ts`, добавить:

```ts
export type { ContainerLayoutOverride } from "./layout-params";
```

- [ ] **Step 4: Run tests**

```bash
bun --cwd packages/shemma-domain test
```

Expected: PASS (тип alias не добавляет логики).

- [ ] **Step 5: Commit**

```bash
git add packages/shemma-domain/src/layout-params.ts packages/shemma-domain/src/index.ts
git commit -m "feat(shemma-domain): export ContainerLayoutOverride type alias"
```

---

## Task 2: `readContainerDirection` + `isCustomDirection` extension для frame; skip frame из `inferContainerDirections`

**Files:**
- Modify: `apps/backend/src/domain/layout.ts`
- Create: `apps/backend/tests/layout-direction-frame.test.ts`

- [ ] **Step 1: Написать failing tests**

```ts
// apps/backend/tests/layout-direction-frame.test.ts
import { describe, expect, it } from "bun:test";
import { runLayout } from "../src/domain/layout";
import type { TLStoreSnapshot } from "../src/store-types";

describe("DRW: frame Direction via meta.didrawDirection", () => {
  it("frame с meta.didrawDirection='LR' → ELK layouts children горизонтально", async () => {
    const store: TLStoreSnapshot = {
      schemaVersion: 1,
      store: {
        "page:page": { id: "page:page", typeName: "page" } as any,
        "shape:f": {
          id: "shape:f", typeName: "shape", type: "frame",
          parentId: "page:page", x: 0, y: 0,
          props: { w: 800, h: 400, name: "", color: "black" },
          meta: { didrawDirection: "LR" },
        } as any,
        "shape:a": {
          id: "shape:a", typeName: "shape", type: "geo",
          parentId: "shape:f", x: 0, y: 0,
          props: { w: 80, h: 40, geo: "rectangle" }, meta: {},
        } as any,
        "shape:b": {
          id: "shape:b", typeName: "shape", type: "geo",
          parentId: "shape:f", x: 0, y: 0,
          props: { w: 80, h: 40, geo: "rectangle" }, meta: {},
        } as any,
      },
    };
    const result = await runLayout(store, {
      mode: "layered-lr", scope: "affected",
      affectedIds: new Set(["shape:f"]),
      containerScope: "self",
    }, new Map());
    const aPos = result.batch.updated["shape:a"];
    const bPos = result.batch.updated["shape:b"];
    expect(aPos).toBeDefined();
    expect(bPos).toBeDefined();
    // LR layout: значимая разница по X между a и b
    expect(Math.abs((aPos!.x as number) - (bPos!.x as number))).toBeGreaterThan(40);
  });

  it("frame с meta.didrawDirection='custom' → children positions preserved (no layout)", async () => {
    // ... аналогичный setup, but didrawDirection: "custom"
    // expect children positions unchanged
  });

  it("frame НЕ участвует в DRW-178 inferContainerDirections", async () => {
    // Setup: frame без direction; параметр autoDirectionEnabled=true.
    // После runLayout: frame.meta.didrawDirection НЕ должен быть записан inference'ом.
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
bun --cwd apps/backend test layout-direction-frame.test.ts
```

Expected: FAIL — frame пока не читает `meta.didrawDirection` (returns undefined).

- [ ] **Step 3: Implement — extension `readContainerDirection`**

В `apps/backend/src/domain/layout.ts::readContainerDirection`, добавить frame branch ПЕРЕД final fallback:

```ts
// (после schema-container branch, перед legacy didrawSubgraphDirection)
if (container.type === "frame") {
  const d = container.meta?.didrawDirection;
  if (d === "custom") return undefined;
  if (typeof d === "string" && MERMAID_DIR_TO_ELK[d]) return MERMAID_DIR_TO_ELK[d];
}
```

- [ ] **Step 4: Implement — `isCustomDirection` extension**

В том же файле:

```ts
function isCustomDirection(container: ShapeRec): boolean {
  if (container.type === "schema-container") {
    return (container.props as Record<string, unknown> | undefined)?.direction === "custom";
  }
  if (container.type === "frame") {
    return container.meta?.didrawDirection === "custom";
  }
  return false;
}
```

- [ ] **Step 5: Implement — skip frame в `inferContainerDirections`**

В `inferContainerDirections` после `const containers = shapes.filter(isContainerShape);` добавить:

```ts
// Frame не участвует в auto-direction inference — meta.didrawDirection для frame
// зарезервирован под user-set value (spec 4.1).
const eligibleContainers = containers.filter((c) => c.type !== "frame");
```

И заменить `containers` на `eligibleContainers` в последующем loop.

- [ ] **Step 6: Run tests — verify they pass**

```bash
bun --cwd apps/backend test layout-direction-frame.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run full backend suite — no regression**

```bash
bun --cwd apps/backend test
```

Expected: All tests pass (1024 + new 3).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/domain/layout.ts apps/backend/tests/layout-direction-frame.test.ts
git commit -m "feat(layout): frame meta.didrawDirection support + skip from auto-inference"
```

---

## Task 3: `runLayoutSubgraph` per-anchor `meta.didrawLayoutParams` override

**Files:**
- Modify: `apps/backend/src/domain/layout.ts`
- Create: `apps/backend/tests/layout-params-override-per-frame.test.ts`

- [ ] **Step 1: Написать failing tests**

```ts
// apps/backend/tests/layout-params-override-per-frame.test.ts
import { describe, expect, it } from "bun:test";
import { runLayout } from "../src/domain/layout";

describe("DRW: per-anchor layout params override", () => {
  it("frame с meta.didrawLayoutParams={spacing:'compact'} → compact applies для subgraph", async () => {
    // Setup: 2 frames, frame1 has override compact, frame2 inherits board roomy.
    // Run layout in scope='all'. Assert children spacing differs between frames.
  });

  it("override=undefined → board defaults inherited", async () => {
    // Setup: frame без override, board params spacing='compact'.
    // Run layout. Assert subgraph uses compact.
  });

  it("schema-container с override aналогично frame", async () => {
    // Setup: schema-container внутри frame, container override spacing='roomy'.
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
bun --cwd apps/backend test layout-params-override-per-frame.test.ts
```

Expected: FAIL — нет per-anchor чтения override.

- [ ] **Step 3: Implement — helper `paramsForAnchor`**

В `runLayoutSubgraph` ДО Pass A loop добавить:

```ts
const shapeByIdLocal = new Map(shapes.map((s) => [s.id, s]));
const paramsForAnchor = (anchorId: string): LayoutParams => {
  const anchor = shapeByIdLocal.get(anchorId);
  const override = anchor?.meta?.didrawLayoutParams as Partial<LayoutParams> | undefined;
  return override ? applyLayoutParamsDefaults({ ...params, ...override }) : params;
};
```

- [ ] **Step 4: Implement — use `paramsForAnchor` в Pass A loop**

Найти строки где Pass A применяет `modeToElkOptions(hint.mode, hint.spacing)` для anchor. Заменить:

```ts
// До:
const opts = modeToElkOptions(hint.mode, hint.spacing);

// После (внутри loop по anchors):
const anchorParams = paramsForAnchor(anchor.id);
const opts = modeToElkOptions(hint.mode, anchorParams.spacing);
```

Аналогично пересчитать `labelDerivedSpacing` с anchor params если он используется в Pass A scope.

- [ ] **Step 5: Run tests — verify they pass**

```bash
bun --cwd apps/backend test layout-params-override-per-frame.test.ts
```

- [ ] **Step 6: Full backend suite — no regression**

```bash
bun --cwd apps/backend test
```

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/domain/layout.ts apps/backend/tests/layout-params-override-per-frame.test.ts
git commit -m "feat(layout): per-anchor meta.didrawLayoutParams override в runLayoutSubgraph"
```

---

## Task 4: POST `/api/agent/layout-selection` принимает `layoutParamsOverride`

**Files:**
- Modify: `apps/backend/src/routes/layout-selection.ts`
- Extend: `apps/backend/tests/routes-layout-selection-payload.test.ts` (or existing similar)

- [ ] **Step 1: Найти текущий validation pattern**

```bash
grep -n "directions\|forceUnpin\|validateLayoutParams" apps/backend/src/routes/layout-selection.ts
```

- [ ] **Step 2: Написать failing tests**

В `routes-layout-selection-payload.test.ts` (extend) добавить cases:

```ts
it("POST с layoutParamsOverride: {[id]: {spacing:'compact'}} → пишет meta + apply layout", async () => {
  // Setup room with frame, POST с override, fetch room, assert meta.didrawLayoutParams.
});

it("POST с layoutParamsOverride: {[id]: null} → удаляет meta key", async () => {
  // Pre-condition: frame.meta.didrawLayoutParams установлен.
  // POST с null. Assert key absent после.
});

it("invalid LayoutParams → 400 atomic abort (нет partial changes)", async () => {
  // POST с layoutParamsOverride: {[id]: {spacing: "INVALID"}}.
  // Assert response.status === 400, нет changes в store.
});

it("non-container id в override → skip + добавляется в unresolved", async () => {
  // POST с layoutParamsOverride: {[leafId]: {...}}.
  // Assert leafId в response.unresolved, layout всё равно run.
});
```

- [ ] **Step 3: Run tests — verify they fail**

```bash
bun --cwd apps/backend test routes-layout-selection-payload
```

- [ ] **Step 4: Implement — body parsing**

В `apps/backend/src/routes/layout-selection.ts` после parsing `directions`:

```ts
const rawOverride =
  body && typeof body === "object" && "layoutParamsOverride" in body &&
  typeof body.layoutParamsOverride === "object" &&
  !Array.isArray(body.layoutParamsOverride)
    ? (body.layoutParamsOverride as Record<string, unknown>)
    : null;

const parsedOverride: Record<string, Partial<LayoutParams> | null> = {};
if (rawOverride) {
  for (const [shapeId, val] of Object.entries(rawOverride)) {
    if (val === null) {
      parsedOverride[shapeId] = null;
      continue;
    }
    if (typeof val !== "object") continue;
    const validation = validateLayoutParams(val as Partial<LayoutParams>);
    if (!validation.ok) {
      return c.json({ ok: false, error: `invalid layoutParamsOverride for ${shapeId}: ${validation.error}` }, 400);
    }
    parsedOverride[shapeId] = val as Partial<LayoutParams>;
  }
}
```

- [ ] **Step 5: Implement — atomic apply ДО runLayout**

После existing directions patch loop, добавить аналогичный для override:

```ts
for (const [shapeId, partial] of Object.entries(parsedOverride)) {
  const shape = r.store.store[shapeId];
  if (!shape || shape.typeName !== "shape") { unresolved.push(shapeId); continue; }
  if (shape.type !== "frame" && shape.type !== "schema-container") {
    unresolved.push(shapeId); continue;
  }
  const newMeta = { ...(shape.meta as object | undefined) };
  if (partial === null) delete newMeta.didrawLayoutParams;
  else newMeta.didrawLayoutParams = partial;
  // Write back through store mutation API (mirror existing directions pattern)
  r.store.store[shapeId] = { ...shape, meta: newMeta };
  // Track для broadcast
}
```

(Точный API write следовать existing direction-patch код.)

- [ ] **Step 6: Run tests — verify they pass**

```bash
bun --cwd apps/backend test routes-layout-selection-payload
```

- [ ] **Step 7: Full backend suite**

```bash
bun --cwd apps/backend test
```

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/routes/layout-selection.ts apps/backend/tests/routes-layout-selection-payload.test.ts
git commit -m "feat(layout-selection): accept layoutParamsOverride body + validate + atomic apply"
```

---

## Task 5: Scope invariant fix — based on task #0 findings

**Files:**
- Modify: `apps/backend/src/domain/layout.ts` (if backend leak found)
- Complete: `apps/backend/tests/layout-selection-scope-invariant.test.ts`

- [ ] **Step 1: Re-run task #0 repro test**

```bash
bun --cwd apps/backend test layout-selection-scope-invariant
```

Если PASSING — frontend-only fix (task #8 closes the gap). Skip к task #5 завершению regression suite в Step 4.

Если FAILING — backend имеет утечку, продолжай Step 2-3.

- [ ] **Step 2 (conditional): Tracing — найти точку утечки**

Запустить тест с tracing:

```ts
// Временно в test:
console.log("batch.updated keys:", Object.keys(result.batch.updated));
console.log("frame update:", result.batch.updated["shape:frameA"]);
```

Найти в `runLayout` / `runLayoutSubgraph` где frame `props.w/h` оказывается в batch при `containerScope === "self"`.

- [ ] **Step 3 (conditional): Implement guard**

В точке writeback frame size в Pass A или Pass C добавить guard:

```ts
// Pseudo — точное место зависит от findings.
if (containerScope === "self" && !filterToIds.has(frameId)) continue;
```

- [ ] **Step 4: Дополнить regression test cases**

```ts
it("scope:'self' + ids=[container] inside frame → frame size preserved", async () => { ... });
it("scope:'auto' + ids=[container] inside frame → frame size может обновиться (legitimate)", async () => { ... });
it("multi-leaf inside frame, scope:'auto' → frame size update OK", async () => { ... });
```

- [ ] **Step 5: Run full test — verify**

```bash
bun --cwd apps/backend test layout-selection-scope-invariant
```

- [ ] **Step 6: Full suite no regression**

```bash
bun --cwd apps/backend test
```

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/domain/layout.ts apps/backend/tests/layout-selection-scope-invariant.test.ts
git commit -m "fix(layout): scope:'self' preserves parent frame size; full regression suite"
```

(Если только regression suite — `git commit -m "test(layout): regression suite for scope:'self' frame size invariant"`.)

---

## Task 6: `setContainerDirection(editor, ids, dir)` polymorphic writer + update all callers

**Files:**
- Modify: `apps/frontend/src/shapes/schema-container/SchemaContainerActions.ts`
- Modify: `apps/frontend/src/settings/SettingsPopover.tsx` (caller `onDirectionChange`)
- Modify: any other callers found (context menu actions, etc.)
- Create: `apps/frontend/src/shapes/schema-container/SchemaContainerActions.test.ts` (extend or create new `container-actions.test.ts`)

- [ ] **Step 1: Найти всех callers `setSchemaContainerDirection`**

```bash
grep -rn "setSchemaContainerDirection" apps/frontend/src
```

- [ ] **Step 2: Написать failing test**

```ts
// apps/frontend/src/shapes/schema-container/SchemaContainerActions.test.ts
import { describe, expect, it, mock } from "bun:test";
import { setContainerDirection } from "./SchemaContainerActions";

describe("setContainerDirection — polymorphic writer", () => {
  it("schema-container: пишет в props.direction", () => {
    // Mock editor.getShape returning schema-container; expect editor.updateShape called with props.direction.
  });

  it("frame: пишет в meta.didrawDirection", () => {
    // Mock editor.getShape returning frame; expect editor.updateShape called with meta.didrawDirection.
  });

  it("POST содержит directions map + scope:'self'", () => {
    // Mock fetch; expect POST body has directions + scope:"self".
  });

  it("ignore non-container ids", () => {
    // Mock leaf shape; expect no updateShape call для него.
  });
});
```

- [ ] **Step 3: Run tests — verify they fail (function signature change)**

```bash
bun --cwd apps/frontend test SchemaContainerActions
```

- [ ] **Step 4: Implement — new signature**

Заменить `setSchemaContainerDirection` на `setContainerDirection` в `apps/frontend/src/shapes/schema-container/SchemaContainerActions.ts`:

```ts
export function setContainerDirection(
  editor: Editor,
  ids: string[],
  dir: "TB" | "BT" | "LR" | "RL",
): void {
  const directions: Record<string, string> = {};
  editor.run(() => {
    for (const id of ids) {
      const s = editor.getShape(id as TLShapeId);
      if (s?.type === "schema-container") {
        editor.updateShape({ id, type: "schema-container", props: { direction: dir }});
      } else if (s?.type === "frame") {
        editor.updateShape({ id, type: "frame", meta: { didrawDirection: dir }});
      } else continue;
      directions[id] = dir;
    }
  });
  if (Object.keys(directions).length === 0) return;
  void fetch(`/api/agent/layout-selection?space=${...}&room=${...}`, {
    method: "POST",
    body: JSON.stringify({ ids: Object.keys(directions), directions, scope: "self" }),
  });
}
```

(Сохранить existing space/room threading из текущего helper'а.)

- [ ] **Step 5: Update caller — `SettingsPopover.tsx::onDirectionChange`**

```ts
// Было:
onDirectionChange={(d) => {
  if (d === "custom") return;
  setSchemaContainerDirection(editor, d);
}}

// Стало:
onDirectionChange={(d) => {
  if (d === "custom") return;
  setContainerDirection(editor, editor.getSelectedShapeIds() as unknown as string[], d);
}}
```

- [ ] **Step 6: Update other callers (если найдены в Step 1)**

Каждый caller switched к new signature.

- [ ] **Step 7: Run frontend tests**

```bash
bun --cwd apps/frontend test
```

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/shapes/schema-container apps/frontend/src/settings/SettingsPopover.tsx
git commit -m "refactor(container-actions): setContainerDirection polymorphic writer; explicit ids signature"
```

---

## Task 7: `setContainerLayoutParams(editor, ids, partial)` writer + API wrapper

**Files:**
- Modify: `apps/frontend/src/settings/api.ts`
- Create: `apps/frontend/src/shapes/container-layout-params.ts` (new writer)
- Create: `apps/frontend/src/shapes/container-layout-params.test.ts`

- [ ] **Step 1: Написать failing test**

```ts
// container-layout-params.test.ts
import { describe, expect, it, mock } from "bun:test";
import { setContainerLayoutParams } from "./container-layout-params";

describe("setContainerLayoutParams", () => {
  it("partial=Partial<LayoutParams> → optimistic editor.updateShape + POST body содержит override + scope:'self'", () => { ... });
  it("partial=null → editor.updateShape с meta.didrawLayoutParams=undefined (delete) + POST body содержит null", () => { ... });
  it("ignore non-container ids", () => { ... });
});
```

- [ ] **Step 2: Run tests — verify they fail**

- [ ] **Step 3: Implement — writer**

```ts
// apps/frontend/src/shapes/container-layout-params.ts
import type { Editor, TLShapeId } from "tldraw";
import type { LayoutParams } from "@shemma/domain";

export async function setContainerLayoutParams(
  editor: Editor,
  ids: string[],
  partial: Partial<LayoutParams> | null,
  ctx: { space: string; room: string },
): Promise<void> {
  const metaValue = partial === null ? undefined : partial;
  editor.run(() => {
    for (const id of ids) {
      const s = editor.getShape(id as TLShapeId);
      if (s?.type === "schema-container" || s?.type === "frame") {
        editor.updateShape({ id, type: s.type, meta: { didrawLayoutParams: metaValue }});
      }
    }
  });

  const override: Record<string, Partial<LayoutParams> | null> = {};
  for (const id of ids) {
    const s = editor.getShape(id as TLShapeId);
    if (s?.type === "schema-container" || s?.type === "frame") {
      override[id] = partial;
    }
  }
  if (Object.keys(override).length === 0) return;

  await fetch(
    `/api/agent/layout-selection?space=${encodeURIComponent(ctx.space)}&room=${encodeURIComponent(ctx.room)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: Object.keys(override),
        scope: "self",
        layoutParamsOverride: override,
      }),
    },
  );
}
```

- [ ] **Step 4: API wrapper (optional thin helper) в `api.ts`**

Если pattern в api.ts thin wrappers (per existing GET/POST helpers), добавить:

```ts
export async function postLayoutSelectionWithOverride(
  space: string, room: string,
  body: { ids: string[]; scope?: "self" | "auto"; layoutParamsOverride?: Record<string, ...> }
) { ... }
```

Иначе использовать direct fetch из writer'а.

- [ ] **Step 5: Run tests**

```bash
bun --cwd apps/frontend test container-layout-params
```

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/shapes/container-layout-params.ts apps/frontend/src/shapes/container-layout-params.test.ts apps/frontend/src/settings/api.ts
git commit -m "feat(container-actions): setContainerLayoutParams writer + reset semantics"
```

---

## Task 8: `tidyLayout` scope heuristic + all caller updates

**Files:**
- Modify: `apps/frontend/src/canvas/tidy-layout.ts`
- Modify: `apps/frontend/src/App.tsx` (hotkey handlers)
- Extend: `apps/frontend/src/canvas/tidy-layout.test.ts`

- [ ] **Step 1: Написать failing test**

```ts
// tidy-layout.test.ts (extend)
it("scopeFor: single schema-container → 'self'", () => {
  const editor = mockEditor({ "shape:1": { type: "schema-container" }});
  expect(scopeFor(["shape:1"], editor)).toBe("self");
});
it("scopeFor: single frame → 'self'", () => { ... });
it("scopeFor: single leaf → 'auto'", () => { ... });
it("scopeFor: multi-selection → 'auto'", () => { ... });

it("tidyLayout: scope='self' проходит через в POST body", async () => {
  // Mock fetch; call tidyLayout(["containerId"], "space", "room", "self");
  // Expect fetch called с body содержащим scope:"self".
});
```

- [ ] **Step 2: Run tests — verify they fail**

- [ ] **Step 3: Implement — добавить `scope` parameter в tidyLayout**

```ts
// tidy-layout.ts
export async function tidyLayout(
  ids: string[],
  space: string,
  room: string,
  scope: "self" | "auto" = "auto",
): Promise<TidyLayoutResult> {
  ...
  body: JSON.stringify({ ids, scope }),
  ...
}
```

- [ ] **Step 4: Implement — `scopeFor` helper**

```ts
export function scopeFor(ids: string[], editor: Editor): "self" | "auto" {
  if (ids.length !== 1) return "auto";
  const s = editor.getShape(ids[0] as TLShapeId);
  if (!s) return "auto";
  return (s.type === "frame" || s.type === "schema-container") ? "self" : "auto";
}
```

- [ ] **Step 5: Update callers — `makeTidyHotkeyHandler`**

```ts
// tidy-layout.ts
export function makeTidyHotkeyHandler(
  getSelectedIds: () => string[],
  editor: Editor,
  onTidy: (ids: string[], scope: "self" | "auto") => void,
): (e: KeyboardEvent) => void {
  return (e) => {
    if (!matchHotkey(e)) return;
    const ids = getSelectedIds();
    if (ids.length === 0) return;
    e.preventDefault(); e.stopPropagation();
    onTidy(ids, scopeFor(ids, editor));
  };
}
```

- [ ] **Step 6: Update `App.tsx` — pass editor через handler factory**

```ts
const tidyHandler = makeTidyHotkeyHandler(
  () => editor.getSelectedShapeIds() as unknown as string[],
  editor,
  (ids, scope) => void tidyLayout(ids, space, room, scope),
);
```

То же для `makeForceReLayoutHotkeyHandler` (передать `editor`).

- [ ] **Step 7: Update SelectionPanel Layout action button caller**

В `SettingsPopover.tsx::onLayoutAction`:

```ts
onLayoutAction={async (id) => {
  ...
  const ids = editor.getSelectedShapeIds() as unknown as string[];
  await postLayoutSelection(space, room, {
    ids,
    scope: scopeFor(ids, editor),
    forceUnpin: id === "force-unpin",
  });
  ...
}}
```

- [ ] **Step 8: Run tests + full frontend suite**

```bash
bun --cwd apps/frontend test tidy-layout
bun --cwd apps/frontend test
```

- [ ] **Step 9: Commit**

```bash
git add apps/frontend/src/canvas/tidy-layout.ts apps/frontend/src/App.tsx apps/frontend/src/settings/SettingsPopover.tsx apps/frontend/src/canvas/tidy-layout.test.ts
git commit -m "fix(tidy-layout): scope heuristic (single container/frame → 'self')"
```

---

## Task 9: SettingsPopover useValue — polymorphic counts/direction + `showContainerSections` rule

**Files:**
- Modify: `apps/frontend/src/settings/SettingsPopover.tsx`

- [ ] **Step 1: Найти текущие useValue для counts + direction**

```bash
grep -n "useValue\|counts.containers\|direction.*useValue" apps/frontend/src/settings/SettingsPopover.tsx
```

- [ ] **Step 2: Изменить counts useValue**

```ts
const isContainerShape = (s: { type: string }) =>
  s.type === "schema-container" || s.type === "frame";

const counts = useValue("selectionCounts", () => {
  const selected = editor.getSelectedShapes() as unknown as Array<{ type: string }>;
  const containers = selected.filter(isContainerShape).length;
  return { containers, nodes: selected.length - containers };
}, [editor]);
```

- [ ] **Step 3: Изменить direction useValue**

```ts
const direction = useValue("dir", () => {
  const containers = (editor.getSelectedShapes() as unknown as Array<{ type: string; props?: { direction?: string }; meta?: { didrawDirection?: string }}>)
    .filter(isContainerShape);
  if (containers.length === 0) return null;
  const readDir = (s: typeof containers[number]) =>
    s.type === "schema-container"
      ? (s.props?.direction ?? null)
      : (s.meta?.didrawDirection ?? null);
  const first = readDir(containers[0]);
  return containers.every((c) => readDir(c) === first) ? first : null;
}, [editor]) as "TB" | "LR" | "BT" | "RL" | "custom" | null;
```

- [ ] **Step 4: Добавить `showContainerSections`**

```ts
const showContainerSections = counts.containers > 0 && counts.nodes === 0;
```

Передать в SelectionPanel как prop.

- [ ] **Step 5: Run frontend tests**

```bash
bun --cwd apps/frontend test SettingsPopover
```

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/settings/SettingsPopover.tsx
git commit -m "feat(settings-popover): polymorphic counts/direction + showContainerSections rule"
```

---

## Task 10: `LayoutSettingsSection` component + rename `LayoutSection` → `LayoutActionsSection`

**Files:**
- Rename: `apps/frontend/src/settings/sections/LayoutSection.tsx` → `LayoutActionsSection.tsx`
- Create: `apps/frontend/src/settings/sections/LayoutSettingsSection.tsx`
- Extend: `apps/frontend/src/settings/sections/sections.test.ts`

- [ ] **Step 1: Найти всех importers `LayoutSection`**

```bash
grep -rn "LayoutSection\|from.*LayoutSection" apps/frontend/src
```

- [ ] **Step 2: Rename file + class в `LayoutActionsSection`**

```bash
git mv apps/frontend/src/settings/sections/LayoutSection.tsx apps/frontend/src/settings/sections/LayoutActionsSection.tsx
```

Внутри файла: переименовать exported component `LayoutSection` → `LayoutActionsSection`. Сохранить `LayoutAction` type если он экспортирован.

- [ ] **Step 3: Update all imports**

Sed / Edit все находки из Step 1 — `LayoutSection` → `LayoutActionsSection`.

- [ ] **Step 4: Написать failing test для `LayoutSettingsSection`**

```ts
// sections.test.ts (extend)
it("LayoutSettingsSection renders preset buttons + autoDirection + midpoint + Reset", () => {
  // Render с current value; expect 3 preset buttons + toggle + 2 midpoint + Advanced + Reset.
});
it("preset onClick fires onPreset callback", () => { ... });
it("Reset button visible only if showReset=true", () => { ... });
```

- [ ] **Step 5: Run tests — verify they fail**

- [ ] **Step 6: Implement `LayoutSettingsSection`**

```tsx
// apps/frontend/src/settings/sections/LayoutSettingsSection.tsx
import type { FC } from "react";

export type LayoutSettingsValue = {
  preset: "compact" | "normal" | "roomy" | null;
  autoDirection: boolean | null;
  midpoint: "even" | "fixed-0.5" | null;
};

export const LayoutSettingsSection: FC<{
  current: LayoutSettingsValue;
  onPreset: (p: "compact" | "normal" | "roomy") => void;
  onAutoDirection: (v: boolean) => void;
  onMidpoint: (m: "even" | "fixed-0.5") => void;
  onAdvanced: () => void;
  onReset: () => void;
  showReset: boolean;
  hints?: { compact: string; normal: string; roomy: string; auto: string; even: string; center: string };
}> = ({ current, onPreset, onAutoDirection, onMidpoint, onAdvanced, onReset, showReset, hints }) => (
  <section className="settings-section">
    <h3 className="settings-section__title">Компоновка</h3>
    <div className="settings-section__row">
      {(["compact", "normal", "roomy"] as const).map((p) => (
        <button key={p}
          className={`settings-btn ${current.preset === p ? "settings-btn--on" : ""}`}
          title={hints?.[p]}
          onClick={() => onPreset(p)}>
          {p === "compact" ? "Compact" : p === "normal" ? "Normal" : "Roomy"}
        </button>
      ))}
    </div>
    <button className={`settings-btn ${current.autoDirection === true ? "settings-btn--on" : ""}`}
      title={hints?.auto}
      onClick={() => onAutoDirection(!current.autoDirection)}>
      Авто-направление: {current.autoDirection === true ? "вкл" : "выкл"}
    </button>
    <div className="settings-section__row">
      <button className={`settings-btn ${current.midpoint === "even" ? "settings-btn--on" : ""}`}
        title={hints?.even}
        onClick={() => onMidpoint("even")}>равномерно</button>
      <button className={`settings-btn ${current.midpoint === "fixed-0.5" ? "settings-btn--on" : ""}`}
        title={hints?.center}
        onClick={() => onMidpoint("fixed-0.5")}>по центру</button>
    </div>
    <button className="settings-link" onClick={onAdvanced}>Advanced ›</button>
    {showReset && (
      <button className="settings-link settings-link--muted" onClick={onReset}>
        Сброс к defaults
      </button>
    )}
  </section>
);
```

- [ ] **Step 7: Run tests**

```bash
bun --cwd apps/frontend test sections
```

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/settings/sections/
git commit -m "feat(settings-sections): LayoutSettingsSection (preset+autoDir+midpoint+Reset); rename existing → LayoutActionsSection"
```

---

## Task 11: BoardPanel rebrand — header "По умолчанию" + badge + CSS

**Files:**
- Modify: `apps/frontend/src/settings/panels/BoardPanel.tsx`
- Modify: `apps/frontend/src/settings/panels/BoardPanelAdvanced.tsx`
- Modify: `apps/frontend/src/settings/styles.css`
- Extend: `apps/frontend/src/settings/panels/panels.test.ts`

- [ ] **Step 1: Написать failing test**

```ts
// panels.test.ts (extend)
it("BoardPanel renders header 'По умолчанию'", () => {
  const { getByText } = render(<BoardPanel ... />);
  expect(getByText("По умолчанию")).toBeTruthy();
});
it("BoardPanel renders badge 'Для нового содержимого'", () => {
  const { getByText } = render(<BoardPanel ... />);
  expect(getByText("Для нового содержимого")).toBeTruthy();
});
it("BoardPanelAdvanced renders badge + helper text", () => { ... });
```

- [ ] **Step 2: Run tests — verify fails**

- [ ] **Step 3: Add header + badge JSX в BoardPanel**

```tsx
<div className="settings-popover__panel">
  <h2 className="settings-popover__title">По умолчанию</h2>
  <span className="settings-popover__badge">Для нового содержимого</span>
  {/* existing sections */}
</div>
```

(Точный markup согласовать с existing structure.)

- [ ] **Step 4: Add badge в BoardPanelAdvanced + helper text**

```tsx
<span className="settings-popover__badge">Для нового содержимого</span>
<p className="settings-popover__hint">Эти значения работают как defaults для всего room</p>
```

- [ ] **Step 5: Add CSS в styles.css**

```css
.settings-popover__badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  background: #f2f3f5;
  color: #5f6368;
  font-size: 11px;
  font-weight: 500;
  margin: 4px 0 12px;
}
.settings-popover__hint {
  font-size: 11px;
  color: #8a8d91;
  margin: 6px 0 12px;
}
```

- [ ] **Step 6: Run tests**

```bash
bun --cwd apps/frontend test panels
```

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/settings/panels/BoardPanel.tsx apps/frontend/src/settings/panels/BoardPanelAdvanced.tsx apps/frontend/src/settings/styles.css apps/frontend/src/settings/panels/panels.test.ts
git commit -m "feat(board-panel): rebrand to 'По умолчанию' + 'Для нового содержимого' badge"
```

---

## Task 12: SelectionPanel wiring — Direction + LayoutSettingsSection + Reset (no badge)

**Files:**
- Modify: `apps/frontend/src/settings/panels/SelectionPanel.tsx`
- Modify: `apps/frontend/src/settings/SettingsPopover.tsx` (передать новые props + handlers)
- Extend: `apps/frontend/src/settings/panels/panels.test.ts`

- [ ] **Step 1: Написать failing tests**

```ts
// panels.test.ts (extend)
it("SelectionPanel renders Direction для frame selected", () => {
  // counts: {containers: 1, nodes: 0}, showContainerSections: true
  // expect Direction section visible
});
it("SelectionPanel renders LayoutSettings для container/frame selected", () => { ... });
it("SelectionPanel hides Direction/LayoutSettings для mixed selection (showContainerSections=false)", () => { ... });
it("SelectionPanel НЕ показывает badge 'Для нового'", () => { ... });
it("Reset visible если showReset=true", () => { ... });
```

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Update SelectionPanel signature**

```tsx
// SelectionPanel.tsx
export type SelectionPanelProps = {
  counts: SelectionCounts;
  showContainerSections: boolean;        // NEW
  direction: DirectionValue | null;
  onDirectionChange: (d: DirectionValue) => void;
  layoutSettings: LayoutSettingsValue;   // NEW
  onPreset: (p: "compact" | "normal" | "roomy") => void;  // NEW
  onAutoDirection: (v: boolean) => void; // NEW
  onMidpoint: (m: "even" | "fixed-0.5") => void;          // NEW
  onAdvanced: () => void;                // NEW (or omit if Advanced reused)
  onReset: () => void;                   // NEW
  showReset: boolean;                    // NEW
  onLayoutAction: (id: LayoutAction["id"]) => void;
  pinValues: { size: boolean; position: boolean };
  onPinToggle: (field: "size" | "position") => void;
  pending: LayoutAction["id"] | null;
};

export const SelectionPanel: FC<SelectionPanelProps> = ({
  counts, showContainerSections, direction, onDirectionChange,
  layoutSettings, onPreset, onAutoDirection, onMidpoint, onAdvanced, onReset, showReset,
  onLayoutAction, pinValues, onPinToggle, pending,
}) => {
  const total = counts.containers + counts.nodes;
  return (
    <div className="settings-popover__panel" role="dialog" aria-label="Настройки выделения">
      {showContainerSections && (
        <>
          <DirectionSection current={direction} onChange={onDirectionChange} />
          <LayoutSettingsSection
            current={layoutSettings}
            onPreset={onPreset}
            onAutoDirection={onAutoDirection}
            onMidpoint={onMidpoint}
            onAdvanced={onAdvanced}
            onReset={onReset}
            showReset={showReset}
          />
        </>
      )}
      <LayoutActionsSection onAction={onLayoutAction} pending={pending} />
      <PinSection values={pinValues} onToggle={onPinToggle} bulkLabel={total > 1} />
      <div className="settings-popover__footer">{selectionFooterCounter(counts)}</div>
    </div>
  );
};
```

- [ ] **Step 4: Update SettingsPopover wiring**

В `SettingsPopover.tsx`:
- Добавить useValue для `layoutSettings` (агрегированный из selected[i].meta.didrawLayoutParams).
- Добавить useValue для `showReset = selected.some(s => s.meta?.didrawLayoutParams)`.
- Wire handlers: `onPreset`, `onAutoDirection`, `onMidpoint`, `onReset` через `setContainerLayoutParams(editor, ids, partial)`.
- `onDirectionChange` уже обновлён в task #6.

- [ ] **Step 5: Run tests + full suite**

```bash
bun --cwd apps/frontend test
```

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/settings/panels/SelectionPanel.tsx apps/frontend/src/settings/SettingsPopover.tsx apps/frontend/src/settings/panels/panels.test.ts
git commit -m "feat(selection-panel): Direction + LayoutSettings sections для frame и container (instant apply, no badge)"
```

---

## Task 13: Live verification + changelog + Backlog DRW ticket

**Files:**
- Modify: `CHANGELOG.md`
- Backlog: создать DRW-XXX через `backlog task create` (или MCP)

- [ ] **Step 1: Запустить dev stand**

```bash
bun run dev &
```

- [ ] **Step 2: Live verify через chrome-devtools MCP (controller сам)**

Scenarios:
1. Frame select → Direction секция → клик LR → frame children re-layout horizontally; frame size + siblings unchanged.
2. Container внутри frame → preset Compact → instant re-layout subgraph; frame size unchanged.
3. ⌘⇧L (Tidy) с одним container внутри frame → **frame НЕ схлопывается**.
4. BoardPanel: header "По умолчанию" + badge "Для нового содержимого" видны.
5. Change board preset → canvas визуально не меняется (desired).
6. Multi-selection (frame + sibling container) → preset apply ко всем.
7. Reset на frame Layout → meta key deleted (verify через `editor.getShape(id).meta`).

Каждый scenario — screenshot + краткая запись результата в task notes.

- [ ] **Step 3: Update CHANGELOG.md**

Добавить entry в текущую unreleased секцию:

```md
## 0.27.2-dev (in progress)

### Frame & Container Direction + Layout (frame-container)

- **Frame** теперь имеет собственный Direction (TB/BT/LR/RL/Custom) через `meta.didrawDirection` — ровно как schema-container.
- **Frame и schema-container** получают per-container Layout settings (preset Compact/Normal/Roomy + autoDirection + midpoint) через `meta.didrawLayoutParams` — мгновенный re-layout subgraph.
- **BoardPanel** rebrand: настройки теперь — defaults для нового содержимого, импорта и AI агента. Не triggers re-layout existing schemas.
- **Bug-fix:** при `⌘⇧L`/`⌘⌥⇧L`/Layout action на single container/frame — parent frame больше не схлопывается. Введён frontend heuristic `scope:"self"` для single-container selections.
- `setSchemaContainerDirection` → `setContainerDirection(editor, ids, dir)` polymorphic writer.
- New: `setContainerLayoutParams(editor, ids, partial | null)` writer + reset semantics.
- New `LayoutSettingsSection` component; existing `LayoutSection` → `LayoutActionsSection`.
- POST `/api/agent/layout-selection` body extended: `layoutParamsOverride: Record<id, Partial<LayoutParams> | null>`.
```

- [ ] **Step 4: Create Backlog DRW ticket**

```bash
backlog task create "Frame & Container Direction + Layout (instant apply + board defaults rebrand)" \
  --priority high --labels "feature,ui,layout" \
  -d "Объединённый sub-project 1+2 из brainstorm 2026-05-27 (после DRW-179)." \
  --ac "Frame Direction секция в SelectionPanel работает и применяется мгновенно" \
  --ac "Frame Layout settings (preset/autoDir/midpoint) instant apply через meta.didrawLayoutParams" \
  --ac "Container Layout settings instant apply" \
  --ac "BoardPanel визуально rebrand'нут как defaults (badge 'Для нового содержимого')" \
  --ac "Bug-fix: parent frame не схлопывается при re-layout single container внутри frame" \
  --plain
```

Переименовать filename в `drw-NNN-frame-container-layout.md` (per backlog convention из CLAUDE.md).

Set status to In Progress:
```bash
backlog task edit DRW-NNN -s "In Progress"
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(frame-container): changelog entry + backlog DRW-NNN ticket"
```

---

## Final Review (Phase-end gate per [[feedback-batched-reviews]])

После Task 13 — единый full spec+quality review проходом перед merge в main:

1. **Spec compliance review** — пройти по spec'у v0.1.1 секция за секцией, убедиться что все требования реализованы.
2. **Code quality review** — code-simplifier agent для упрощения.
3. **Live verify** контроллер сам (повторно если первый прогон выявил баги).
4. **Tests:** `bun run test` из корня — full 1467+ regression.
5. **Backlog task edit** — статус Done, final-summary с verification record.
6. **Merge `feature/frame-container-direction-layout` → main** через `--no-ff` после явного user acceptance.

---

## Self-review (writing-plans skill)

✅ **Spec coverage** — все секции spec'а v0.1.1 покрыты задачами 0-13. Каждая user-facing требование (frame direction, frame layout, container layout, scope bug fix, BoardPanel rebrand, SelectionPanel extension) имеет конкретный task.

✅ **Placeholders** — пройдён, нет TBD/TODO. Snippets кода showed concrete signatures + file paths. Несколько `...` elisions есть в test/mock code где они обозначают "fill standard test fixture" — это интуитивный плейсхолдер которые имплементатор заполнит по аналогии с adjacent tests.

✅ **Type consistency** — `LayoutParams`, `ContainerLayoutOverride`, `LayoutSettingsValue`, `SelectionPanelProps` все имеют точку определения; refs между task'ами согласованы.

⚠️ **Минорный nit** — некоторые задачи (e.g., task #11 BoardPanel mockup) имеют test syntax `render(...)` без import утилит — frontend uses bun:test, нужно убедиться что pure-function tests (per DRW-179 approach) — не RTL. Имплементатор fix'нет на месте по аналогии с existing `panels.test.ts`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-27-frame-container-direction-layout-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review между task'ами, fast iteration.

**2. Inline Execution** — execute tasks in this session с checkpoints для review.

User: какой подход?
