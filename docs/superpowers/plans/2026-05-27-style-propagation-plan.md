# Style Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить централизованное управление стилем линии (Draw/Solid), шрифтом (Draw/Sans/Mono) и размером (S/M/L/XL) shapes — defaults в BoardPanel + sweep на children в SelectionPanel при выделении frame/container.

**Architecture:** Зеркало DRW-180 layout-params pattern. `room.meta.styleDefaults` + `meta.didrawStyleDefaults` на frame/schema-container. Atomic backend endpoint `/api/agent/style-apply` для sweep'а. Bidirectional sync c tldraw `editor.setStyleForNextShape` (echo-guard) + `editor.sideEffects.registerBeforeCreateHandler` для resolution chain.

**Tech Stack:** Bun + Hono (backend), Vite + React + tldraw 5.x (frontend), `@shemma/domain` shared package. Тесты — `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-27-style-propagation-design.md` v0.2.

**Branch:** `feature/style-propagation` (создан, spec commit `09cb1fe`).

---

## File structure

| Файл | Создать/Изменить | Назначение |
|---|---|---|
| `packages/shemma-domain/src/style-defaults.ts` | Create | Типы + валидаторы `StyleDefaults` |
| `packages/shemma-domain/src/index.ts` | Modify | Re-export |
| `packages/shemma-domain/test/style-defaults.test.ts` | Create | Validator tests |
| `apps/backend/src/routes/board-style-defaults.ts` | Create | GET/POST `/api/board/style-defaults` |
| `apps/backend/src/routes/style-apply.ts` | Create | POST `/api/agent/style-apply` |
| `apps/backend/src/index.ts` | Modify | Wire routes |
| `apps/backend/test/routes/board-style-defaults.test.ts` | Create | Endpoint tests |
| `apps/backend/test/routes/style-apply.test.ts` | Create | Sweep tests |
| `apps/frontend/src/settings/api.ts` | Modify | API client |
| `apps/frontend/src/shapes/style-apply.ts` | Create | `applyStyleToSelection` writer |
| `apps/frontend/src/shapes/derive-unified-style-state.ts` | Create | Computed UI state |
| `apps/frontend/test/derive-unified-style-state.test.ts` | Create | Derive tests |
| `apps/frontend/src/settings/sections/StylesSection.tsx` | Modify | Полная реализация (заменяет stub) |
| `apps/frontend/src/settings/panels/BoardPanel.tsx` | Modify | Wire StylesSection |
| `apps/frontend/src/settings/panels/SelectionPanel.tsx` | Modify | Conditional StylesSection |
| `apps/frontend/src/canvas/style-defaults-sync.ts` | Create | Bidirectional sync + resolution |
| `apps/frontend/src/App.tsx` | Modify | Wire sync в onMount |
| `apps/frontend/src/settings/styles.css` | Modify (опционально) | CSS для трёх рядов кнопок |

---

## Task 1: Domain types + validators

**Files:**
- Create: `packages/shemma-domain/src/style-defaults.ts`
- Modify: `packages/shemma-domain/src/index.ts`
- Test: `packages/shemma-domain/test/style-defaults.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shemma-domain/test/style-defaults.test.ts`:
```typescript
import { describe, expect, it } from "bun:test";
import {
  validateStyleDefaults,
  applyStyleDefaultsResolution,
  DEFAULT_STYLE_DEFAULTS,
  type StyleDefaults,
} from "../src/style-defaults";

describe("validateStyleDefaults", () => {
  it("accepts empty object", () => {
    expect(() => validateStyleDefaults({})).not.toThrow();
  });

  it("accepts valid full object", () => {
    expect(() =>
      validateStyleDefaults({ dash: "solid", font: "sans", size: "m" }),
    ).not.toThrow();
  });

  it("rejects invalid dash", () => {
    expect(() =>
      validateStyleDefaults({ dash: "dashed" as never }),
    ).toThrow(/dash/);
  });

  it("rejects invalid font", () => {
    expect(() =>
      validateStyleDefaults({ font: "serif" as never }),
    ).toThrow(/font/);
  });

  it("rejects invalid size", () => {
    expect(() =>
      validateStyleDefaults({ size: "xxl" as never }),
    ).toThrow(/size/);
  });
});

describe("applyStyleDefaultsResolution", () => {
  it("returns native defaults when no chain", () => {
    expect(applyStyleDefaultsResolution([])).toEqual(DEFAULT_STYLE_DEFAULTS);
  });

  it("nearest-first wins per key", () => {
    const room: StyleDefaults = { dash: "solid", font: "sans", size: "m" };
    const frame: StyleDefaults = { font: "mono" };
    // Order: nearest → farthest
    expect(applyStyleDefaultsResolution([frame, room])).toEqual({
      dash: "solid", // from room
      font: "mono",  // from frame (closer)
      size: "m",     // from room
    });
  });

  it("undefined fields fall through", () => {
    const partial: StyleDefaults = { dash: "draw" };
    expect(applyStyleDefaultsResolution([partial])).toEqual({
      dash: "draw",
      font: "draw", // native
      size: "m",    // native
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun --cwd packages/shemma-domain test test/style-defaults.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Write implementation**

Create `packages/shemma-domain/src/style-defaults.ts`:
```typescript
// packages/shemma-domain/src/style-defaults.ts
//
// Style propagation (sub-project 3 of DRW-180): тип централизованных
// дефолтов стиля. Хранится в room.meta.styleDefaults (board level) и
// в meta.didrawStyleDefaults на frame / schema-container (sticky per-container).
//
// Resolution chain (см. spec §Architecture):
//   nearest container → parent containers → room → native default.

export type StyleDash = "draw" | "solid";
export type StyleFont = "draw" | "sans" | "mono";
export type StyleSize = "s" | "m" | "l" | "xl";

export type StyleDefaults = {
  dash?: StyleDash;
  font?: StyleFont;
  size?: StyleSize;
};

export type ResolvedStyleDefaults = Required<StyleDefaults>;

export const DEFAULT_STYLE_DEFAULTS: ResolvedStyleDefaults = {
  dash: "draw",
  font: "draw",
  size: "m",
};

const VALID_DASH: ReadonlySet<StyleDash> = new Set(["draw", "solid"]);
const VALID_FONT: ReadonlySet<StyleFont> = new Set(["draw", "sans", "mono"]);
const VALID_SIZE: ReadonlySet<StyleSize> = new Set(["s", "m", "l", "xl"]);

export function validateStyleDefaults(p: StyleDefaults): void {
  if (p.dash !== undefined && !VALID_DASH.has(p.dash)) {
    throw new Error(
      `StyleDefaults.dash must be draw|solid; got ${String(p.dash)}`,
    );
  }
  if (p.font !== undefined && !VALID_FONT.has(p.font)) {
    throw new Error(
      `StyleDefaults.font must be draw|sans|mono; got ${String(p.font)}`,
    );
  }
  if (p.size !== undefined && !VALID_SIZE.has(p.size)) {
    throw new Error(
      `StyleDefaults.size must be s|m|l|xl; got ${String(p.size)}`,
    );
  }
}

/**
 * Resolves stack of partial defaults (nearest-first order) into fully-defined
 * defaults. First defined value per key wins; gaps filled from
 * DEFAULT_STYLE_DEFAULTS.
 */
export function applyStyleDefaultsResolution(
  chain: StyleDefaults[],
): ResolvedStyleDefaults {
  const out: ResolvedStyleDefaults = { ...DEFAULT_STYLE_DEFAULTS };
  let dashSet = false;
  let fontSet = false;
  let sizeSet = false;
  for (const layer of chain) {
    if (!dashSet && layer.dash !== undefined) {
      out.dash = layer.dash;
      dashSet = true;
    }
    if (!fontSet && layer.font !== undefined) {
      out.font = layer.font;
      fontSet = true;
    }
    if (!sizeSet && layer.size !== undefined) {
      out.size = layer.size;
      sizeSet = true;
    }
    if (dashSet && fontSet && sizeSet) break;
  }
  return out;
}
```

- [ ] **Step 4: Update domain index re-export**

Modify `packages/shemma-domain/src/index.ts` — append:
```typescript
export {
  type StyleDefaults,
  type ResolvedStyleDefaults,
  type StyleDash,
  type StyleFont,
  type StyleSize,
  DEFAULT_STYLE_DEFAULTS,
  validateStyleDefaults,
  applyStyleDefaultsResolution,
} from "./style-defaults";
```

- [ ] **Step 5: Run tests to verify pass**

```bash
bun --cwd packages/shemma-domain test test/style-defaults.test.ts
```
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shemma-domain/src/style-defaults.ts packages/shemma-domain/src/index.ts packages/shemma-domain/test/style-defaults.test.ts
git commit -m "feat(style-propagation): domain types and validators for StyleDefaults"
```

---

## Task 2: Backend GET/POST /api/board/style-defaults

**Files:**
- Create: `apps/backend/src/routes/board-style-defaults.ts`
- Modify: `apps/backend/src/index.ts:298-313` (wire route after `boardLayoutParamsRoutes`)
- Test: `apps/backend/test/routes/board-style-defaults.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/test/routes/board-style-defaults.test.ts`:
```typescript
import { describe, expect, it, beforeEach } from "bun:test";
import { makeApp } from "../../src/index";

const SPACE = "default";
const ROOM = "default";

async function setup() {
  const { app } = makeApp({ inMemory: true });
  // Ensure room exists via state endpoint
  await app.fetch(
    new Request(`http://x/api/state?space=${SPACE}&room=${ROOM}`, {
      method: "GET",
    }),
  );
  return app;
}

describe("GET /api/board/style-defaults", () => {
  it("returns null raw and native effective for fresh room", async () => {
    const app = await setup();
    const res = await app.fetch(
      new Request(
        `http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`,
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.raw).toBeNull();
    expect(body.effective).toEqual({ dash: "draw", font: "draw", size: "m" });
  });

  it("400 when space or room missing", async () => {
    const app = await setup();
    const res = await app.fetch(new Request("http://x/api/board/style-defaults"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/board/style-defaults", () => {
  it("persists partial and returns effective", async () => {
    const app = await setup();
    const res = await app.fetch(
      new Request(
        `http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ defaults: { dash: "solid", font: "sans" } }),
        },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effective).toEqual({ dash: "solid", font: "sans", size: "m" });

    // Verify GET returns persisted
    const getRes = await app.fetch(
      new Request(
        `http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`,
      ),
    );
    const getBody = await getRes.json();
    expect(getBody.raw).toEqual({ dash: "solid", font: "sans" });
  });

  it("null clears persisted", async () => {
    const app = await setup();
    await app.fetch(
      new Request(
        `http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ defaults: { dash: "solid" } }),
        },
      ),
    );
    const res = await app.fetch(
      new Request(
        `http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ defaults: null }),
        },
      ),
    );
    expect(res.status).toBe(200);
    const getRes = await app.fetch(
      new Request(
        `http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`,
      ),
    );
    const getBody = await getRes.json();
    expect(getBody.raw).toBeNull();
  });

  it("400 on invalid field", async () => {
    const app = await setup();
    const res = await app.fetch(
      new Request(
        `http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ defaults: { dash: "dashed" } }),
        },
      ),
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun --cwd apps/backend test test/routes/board-style-defaults.test.ts
```
Expected: FAIL (404 for unknown route, or import error).

- [ ] **Step 3: Implement route**

Create `apps/backend/src/routes/board-style-defaults.ts`:
```typescript
import { Hono } from "hono";
import {
  applyStyleDefaultsResolution,
  validateStyleDefaults,
  type StyleDefaults,
} from "@shemma/domain";

export type BoardStyleDefaultsDeps = {
  getRoom: (
    space: string,
    room: string,
  ) => Promise<{ meta?: Record<string, unknown> } | undefined>;
  persistRoom: (space: string, room: string) => void;
  broadcastRoomMeta: (space: string, room: string) => void;
};

export function boardStyleDefaultsRoutes(deps: BoardStyleDefaultsDeps) {
  return new Hono()
    .get("/api/board/style-defaults", async (c) => {
      const space = c.req.query("space");
      const room = c.req.query("room");
      if (!space || !room) {
        return c.json({ error: "space and room required" }, 400);
      }

      const r = await deps.getRoom(space, room);
      const raw =
        (r?.meta?.styleDefaults as StyleDefaults | undefined) ?? null;
      const effective = applyStyleDefaultsResolution(raw ? [raw] : []);
      return c.json({ raw, effective });
    })
    .post("/api/board/style-defaults", async (c) => {
      const space = c.req.query("space");
      const room = c.req.query("room");
      if (!space || !room) {
        return c.json({ error: "space and room required" }, 400);
      }

      const body = await c.req
        .json<{ defaults?: StyleDefaults | null }>()
        .catch(() => ({}) as { defaults?: StyleDefaults | null });
      const defaults = body.defaults;

      if (defaults !== null && defaults !== undefined) {
        try {
          validateStyleDefaults(defaults);
        } catch (err) {
          return c.json({ error: (err as Error).message }, 400);
        }
      }

      const r = await deps.getRoom(space, room);
      if (!r) return c.json({ error: "room not found" }, 404);

      if (!r.meta) r.meta = {};
      const meta = r.meta as Record<string, unknown>;
      if (defaults === null || defaults === undefined) {
        delete meta.styleDefaults;
      } else {
        meta.styleDefaults = defaults;
      }

      deps.persistRoom(space, room);
      deps.broadcastRoomMeta(space, room);

      const effective = applyStyleDefaultsResolution(
        defaults ? [defaults] : [],
      );
      return c.json({ ok: true, effective });
    });
}
```

- [ ] **Step 4: Wire route in apps/backend/src/index.ts**

Find the existing `boardLayoutParamsRoutes` wiring at line 298 (`apps/backend/src/index.ts`):

```typescript
  app.route("/", boardLayoutParamsRoutes({
    getRoom: async (space, room) => {
      ...
    },
    persistRoom: (space, room) => {
      ...
    },
    broadcastRoomMeta: () => {},
  }));
```

Add identical block right after, importing `boardStyleDefaultsRoutes`:

```typescript
// Add to imports block at top
import { boardStyleDefaultsRoutes } from "./routes/board-style-defaults";

// Insert after boardLayoutParamsRoutes wiring
app.route("/", boardStyleDefaultsRoutes({
  getRoom: async (space, room) => {
    const bundle = bundles.get(space) ?? legacyBundle;
    try {
      return await bundle.rooms.get(room);
    } catch {
      return undefined;
    }
  },
  persistRoom: (space, room) => {
    const bundle = bundles.get(space) ?? legacyBundle;
    const state = bundle.rooms.peek(room);
    if (state) bundle.scheduleSave(room, state);
  },
  broadcastRoomMeta: () => {},
}));
```

- [ ] **Step 5: Run tests to verify pass**

```bash
bun --cwd apps/backend test test/routes/board-style-defaults.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/board-style-defaults.ts apps/backend/src/index.ts apps/backend/test/routes/board-style-defaults.test.ts
git commit -m "feat(style-propagation): backend /api/board/style-defaults GET+POST"
```

---

## Task 3: Backend POST /api/agent/style-apply (atomic sweep)

**Files:**
- Create: `apps/backend/src/routes/style-apply.ts`
- Modify: `apps/backend/src/index.ts` (wire route)
- Test: `apps/backend/test/routes/style-apply.test.ts`

**Applicability matrix** (хранить в одном месте, используется и в тестах, и в route):

| Shape type | dash | font | size | Skip |
|---|---|---|---|---|
| `geo` | ✓ | ✓ | ✓ | — |
| `note` | — | ✓ | ✓ | dash |
| `text` | — | ✓ | ✓ | dash |
| `arrow` | ✓ | ✓ | ✓ | — |
| `schema-container` | ✓ | skip | — | font + size (sticky only) |
| `frame` | — | skip | — | dash + font + size (sticky only) |

Дополнительно: shapes с `current props.dash ∈ {dashed, dotted}` — пропускают **dash** только (font/size применяются).

- [ ] **Step 1: Write the failing test**

Create `apps/backend/test/routes/style-apply.test.ts`:
```typescript
import { describe, expect, it } from "bun:test";
import { makeApp } from "../../src/index";

const SPACE = "default";
const ROOM = "style-apply-test";

async function setupRoom() {
  const { app, legacyBundle } = makeApp({ inMemory: true });
  await app.fetch(
    new Request(`http://x/api/state?space=${SPACE}&room=${ROOM}`, {
      method: "GET",
    }),
  );
  return { app, bundle: legacyBundle };
}

async function addShape(
  app: ReturnType<typeof makeApp>["app"],
  shape: Record<string, unknown>,
) {
  // Direct store mutation via /api/patch is simpler for fixture setup
  return app.fetch(
    new Request(`http://x/api/patch?space=${SPACE}&room=${ROOM}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ type: "add", record: shape }] }),
    }),
  );
}

describe("POST /api/agent/style-apply", () => {
  it("updates props.dash on geo shape", async () => {
    const { app, bundle } = await setupRoom();
    await addShape(app, {
      id: "shape:g1",
      typeName: "shape",
      type: "geo",
      x: 0,
      y: 0,
      props: { geo: "rectangle", color: "black", dash: "draw", size: "m", font: "draw" },
      parentId: "page:page",
      index: "a1",
      meta: {},
    });

    const res = await app.fetch(
      new Request(`http://x/api/agent/style-apply?space=${SPACE}&room=${ROOM}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectedIds: ["shape:g1"],
          styles: { dash: "solid" },
        }),
      }),
    );
    expect(res.status).toBe(200);

    const room = await bundle.rooms.get(ROOM);
    expect((room.store.store["shape:g1"] as any).props.dash).toBe("solid");
  });

  it("dashed shape preserves dash, applies font", async () => {
    const { app, bundle } = await setupRoom();
    await addShape(app, {
      id: "shape:g2",
      typeName: "shape",
      type: "geo",
      x: 0,
      y: 0,
      props: { geo: "rectangle", color: "black", dash: "dashed", size: "m", font: "draw" },
      parentId: "page:page",
      index: "a1",
      meta: {},
    });

    await app.fetch(
      new Request(`http://x/api/agent/style-apply?space=${SPACE}&room=${ROOM}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectedIds: ["shape:g2"],
          styles: { dash: "solid", font: "sans" },
        }),
      }),
    );

    const room = await bundle.rooms.get(ROOM);
    const shape = room.store.store["shape:g2"] as any;
    expect(shape.props.dash).toBe("dashed"); // preserved
    expect(shape.props.font).toBe("sans"); // applied
  });

  it("sweeps descendants of frame", async () => {
    const { app, bundle } = await setupRoom();
    await addShape(app, {
      id: "shape:f1",
      typeName: "shape",
      type: "frame",
      x: 0,
      y: 0,
      props: { w: 800, h: 600, name: "F1", color: "black" },
      parentId: "page:page",
      index: "a1",
      meta: {},
    });
    await addShape(app, {
      id: "shape:g3",
      typeName: "shape",
      type: "geo",
      x: 0,
      y: 0,
      props: { geo: "rectangle", color: "black", dash: "draw", size: "m", font: "draw" },
      parentId: "shape:f1",
      index: "a1",
      meta: {},
    });

    await app.fetch(
      new Request(`http://x/api/agent/style-apply?space=${SPACE}&room=${ROOM}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectedIds: ["shape:f1"],
          styles: { font: "mono" },
        }),
      }),
    );

    const room = await bundle.rooms.get(ROOM);
    const frame = room.store.store["shape:f1"] as any;
    const child = room.store.store["shape:g3"] as any;
    expect(frame.meta.didrawStyleDefaults).toEqual({ font: "mono" });
    expect(child.props.font).toBe("mono");
  });

  it("respectUserOwned skips user-owned shape", async () => {
    const { app, bundle } = await setupRoom();
    await addShape(app, {
      id: "shape:u1",
      typeName: "shape",
      type: "geo",
      x: 0,
      y: 0,
      props: { geo: "rectangle", color: "black", dash: "draw", size: "m", font: "draw" },
      parentId: "page:page",
      index: "a1",
      meta: { styleOwnedBy: "user" },
    });

    await app.fetch(
      new Request(`http://x/api/agent/style-apply?space=${SPACE}&room=${ROOM}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectedIds: ["shape:u1"],
          styles: { dash: "solid" },
          respectUserOwned: true,
        }),
      }),
    );

    const room = await bundle.rooms.get(ROOM);
    expect((room.store.store["shape:u1"] as any).props.dash).toBe("draw");
  });

  it("400 on invalid styles", async () => {
    const { app } = await setupRoom();
    const res = await app.fetch(
      new Request(`http://x/api/agent/style-apply?space=${SPACE}&room=${ROOM}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectedIds: ["shape:x"],
          styles: { dash: "dashed" }, // invalid
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun --cwd apps/backend test test/routes/style-apply.test.ts
```
Expected: FAIL (route 404).

- [ ] **Step 3: Implement route**

Create `apps/backend/src/routes/style-apply.ts`:
```typescript
// apps/backend/src/routes/style-apply.ts
//
// Style propagation: atomic sweep endpoint. Принимает selectedIds + styles
// + optional respectUserOwned. Применяет props на самих selected, на всех
// recursive descendants frame'ов / schema-container'ов в selection, и
// пишет sticky meta.didrawStyleDefaults на frame/schema-container в selection.
//
// Per-shape applicability: см. APPLY_MATRIX.
// Dashed/dotted preservation: shapes с current dash ∈ {dashed, dotted} —
// dash skipped, font/size применяются.

import { Hono } from "hono";
import { config } from "../config";
import { resolveRoomId } from "../rooms";
import { applyStoreChanges, rebuildDidrawIndex } from "../store-ops";
import { pushOpLog } from "../rooms";
import { validateStyleDefaults, type StyleDefaults } from "@shemma/domain";
import type { TLRecord } from "../store-types";
import type { StoreChangeBus } from "../types";
import { bundleForRequest } from "./_space-context";

type ShapeType = "geo" | "note" | "text" | "arrow" | "frame" | "schema-container";

type ApplyMatrix = Record<ShapeType, { dash: boolean; font: boolean; size: boolean }>;

const APPLY_MATRIX: ApplyMatrix = {
  geo: { dash: true, font: true, size: true },
  note: { dash: false, font: true, size: true },
  text: { dash: false, font: true, size: true },
  arrow: { dash: true, font: true, size: true },
  frame: { dash: false, font: false, size: false }, // sticky meta only
  "schema-container": { dash: true, font: false, size: false }, // dash on shape, font/size sticky
};

const PRESERVED_DASH = new Set(["dashed", "dotted"]);

function isStickyParent(type: string): boolean {
  return type === "frame" || type === "schema-container";
}

function applyApplicable(
  shape: TLRecord,
  styles: StyleDefaults,
  respectUserOwned: boolean,
): TLRecord | null {
  if (shape.typeName !== "shape") return null;
  const shapeType = (shape as { type?: string }).type as ShapeType | undefined;
  if (!shapeType || !(shapeType in APPLY_MATRIX)) return null;

  const meta = (shape as { meta?: Record<string, unknown> }).meta ?? {};
  if (respectUserOwned && meta.styleOwnedBy === "user") return null;

  const allowance = APPLY_MATRIX[shapeType];
  const props = ((shape as { props?: Record<string, unknown> }).props ?? {}) as Record<string, unknown>;
  const nextProps = { ...props };
  let changed = false;

  if (styles.dash !== undefined && allowance.dash) {
    if (!PRESERVED_DASH.has(props.dash as string)) {
      if (nextProps.dash !== styles.dash) {
        nextProps.dash = styles.dash;
        changed = true;
      }
    }
  }
  if (styles.font !== undefined && allowance.font) {
    if (nextProps.font !== styles.font) {
      nextProps.font = styles.font;
      changed = true;
    }
  }
  if (styles.size !== undefined && allowance.size) {
    if (nextProps.size !== styles.size) {
      nextProps.size = styles.size;
      changed = true;
    }
  }

  if (!changed) return null;
  return { ...shape, props: nextProps } as TLRecord;
}

function applyStickyMeta(
  shape: TLRecord,
  styles: StyleDefaults,
): TLRecord | null {
  if (shape.typeName !== "shape") return null;
  const shapeType = (shape as { type?: string }).type;
  if (!isStickyParent(shapeType as string)) return null;
  const meta = ((shape as { meta?: Record<string, unknown> }).meta ?? {}) as Record<string, unknown>;
  const prev = (meta.didrawStyleDefaults ?? {}) as StyleDefaults;
  const next: StyleDefaults = { ...prev };
  let changed = false;
  for (const key of ["dash", "font", "size"] as const) {
    const v = styles[key];
    if (v !== undefined && next[key] !== v) {
      next[key] = v as never;
      changed = true;
    }
  }
  if (!changed) return null;
  const newMeta = { ...meta, didrawStyleDefaults: next };
  return { ...shape, meta: newMeta } as TLRecord;
}

function collectDescendants(
  storeMap: Record<string, TLRecord>,
  rootIds: Iterable<string>,
): Set<string> {
  // Build parent → children index once for O(N + result) traversal.
  const childrenByParent: Map<string, string[]> = new Map();
  for (const rec of Object.values(storeMap)) {
    if (rec.typeName !== "shape") continue;
    const parentId = (rec as { parentId?: string }).parentId;
    if (!parentId) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId)!.push(rec.id);
  }
  const out = new Set<string>();
  const stack = Array.from(rootIds);
  while (stack.length > 0) {
    const id = stack.pop()!;
    out.add(id);
    const kids = childrenByParent.get(id);
    if (kids) {
      for (const k of kids) if (!out.has(k)) stack.push(k);
    }
  }
  return out;
}

export function styleApplyRoutes(bus: StoreChangeBus) {
  return new Hono().post("/api/agent/style-apply", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;

    const body = (await c.req.json().catch(() => ({}))) as {
      selectedIds?: unknown;
      styles?: unknown;
      respectUserOwned?: unknown;
    };

    const selectedIds: string[] = Array.isArray(body.selectedIds)
      ? (body.selectedIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const styles = (body.styles ?? {}) as StyleDefaults;
    const respectUserOwned = body.respectUserOwned !== false; // default true

    try {
      validateStyleDefaults(styles);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }

    if (selectedIds.length === 0 || Object.keys(styles).length === 0) {
      return c.json({ ok: true, count: 0 });
    }

    const { rooms, scheduleSave, space } = bundleForRequest(c);
    const r = await rooms.get(id);
    if (!r) return c.json({ ok: false, error: "room not found" }, 404);

    const targetIds = collectDescendants(r.store.store, selectedIds);

    const updated: Record<string, [TLRecord, TLRecord]> = {};

    // Pass 1: sticky meta on frame/schema-container in selection (not descendants —
    // sticky meta только на selected parents, не на их container-children).
    for (const sid of selectedIds) {
      const rec = r.store.store[sid];
      if (!rec) continue;
      const next = applyStickyMeta(rec, styles);
      if (next) updated[sid] = [rec, next];
    }

    // Pass 2: props on all target shapes (selected + descendants).
    for (const tid of targetIds) {
      const baseShape = updated[tid]?.[1] ?? r.store.store[tid];
      if (!baseShape) continue;
      const next = applyApplicable(baseShape, styles, respectUserOwned);
      if (next) {
        const preImage = updated[tid]?.[0] ?? r.store.store[tid]!;
        updated[tid] = [preImage, next];
      }
    }

    if (Object.keys(updated).length === 0) {
      return c.json({ ok: true, count: 0 });
    }

    const batch = { added: {}, updated, removed: {} };
    r.store = applyStoreChanges(r.store, batch);
    r.didrawIndex = rebuildDidrawIndex(r.store);
    r.version += 1;
    pushOpLog(r, { ops: batch, source: "user", version: r.version, at: Date.now() }, config.opLogMaxSize);
    r.dirty = true;
    scheduleSave(id, r);
    bus.publish(space.id, id, { changes: batch, source: "user", version: r.version });

    return c.json({ ok: true, count: Object.keys(updated).length, version: r.version });
  });
}
```

- [ ] **Step 4: Wire route in apps/backend/src/index.ts**

Add to imports:
```typescript
import { styleApplyRoutes } from "./routes/style-apply";
```

Add to wiring block (after `boardStyleDefaultsRoutes` from Task 2):
```typescript
app.route("/", styleApplyRoutes(bus));
```

- [ ] **Step 5: Run tests to verify pass**

```bash
bun --cwd apps/backend test test/routes/style-apply.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/style-apply.ts apps/backend/src/index.ts apps/backend/test/routes/style-apply.test.ts
git commit -m "feat(style-propagation): backend /api/agent/style-apply atomic sweep with respectUserOwned"
```

---

## Task 4: Frontend API client

**Files:**
- Modify: `apps/frontend/src/settings/api.ts`

- [ ] **Step 1: Append style-defaults API functions**

Append to `apps/frontend/src/settings/api.ts`:
```typescript
import type {
  StyleDefaults,
  ResolvedStyleDefaults,
} from "@shemma/domain";

export type StyleDefaultsResponse = {
  raw: StyleDefaults | null;
  effective: ResolvedStyleDefaults;
};

export async function getStyleDefaults(
  space: string,
  room: string,
): Promise<StyleDefaultsResponse> {
  const url = `/api/board/style-defaults?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, { method: "GET" });
  return jsonOrThrow(res);
}

export async function postStyleDefaults(
  space: string,
  room: string,
  defaults: StyleDefaults | null,
): Promise<{ ok: true; effective: ResolvedStyleDefaults }> {
  const url = `/api/board/style-defaults?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaults }),
  });
  return jsonOrThrow(res);
}

export type StyleApplyInput = {
  selectedIds: string[];
  styles: StyleDefaults;
  respectUserOwned?: boolean;
};

export async function postStyleApply(
  space: string,
  room: string,
  input: StyleApplyInput,
): Promise<{ ok: true; count: number }> {
  const url = `/api/agent/style-apply?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}
```

- [ ] **Step 2: Run frontend type-check**

```bash
bun --cwd apps/frontend tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/settings/api.ts
git commit -m "feat(style-propagation): frontend api client for style defaults + apply"
```

---

## Task 5: Frontend derive-unified-style-state + applyStyleToSelection writer

**Files:**
- Create: `apps/frontend/src/shapes/derive-unified-style-state.ts`
- Create: `apps/frontend/src/shapes/style-apply.ts`
- Test: `apps/frontend/src/shapes/derive-unified-style-state.test.ts`

- [ ] **Step 1: Write the failing test for derive**

Create `apps/frontend/src/shapes/derive-unified-style-state.test.ts`:
```typescript
import { describe, expect, it } from "bun:test";
import {
  deriveUnifiedStyleState,
  type StyleStateInput,
} from "./derive-unified-style-state";

describe("deriveUnifiedStyleState", () => {
  it("returns nulls for empty selection", () => {
    expect(deriveUnifiedStyleState([])).toEqual({
      dash: null,
      font: null,
      size: null,
    });
  });

  it("unified state when all shapes match", () => {
    const input: StyleStateInput[] = [
      { type: "geo", props: { dash: "solid", font: "sans", size: "m" } },
      { type: "geo", props: { dash: "solid", font: "sans", size: "m" } },
    ];
    expect(deriveUnifiedStyleState(input)).toEqual({
      dash: "solid",
      font: "sans",
      size: "m",
    });
  });

  it("indeterminate when mixed", () => {
    const input: StyleStateInput[] = [
      { type: "geo", props: { dash: "solid", font: "sans", size: "m" } },
      { type: "geo", props: { dash: "draw", font: "sans", size: "m" } },
    ];
    const out = deriveUnifiedStyleState(input);
    expect(out.dash).toBeNull(); // mixed
    expect(out.font).toBe("sans"); // unified
    expect(out.size).toBe("m"); // unified
  });

  it("excludes dashed/dotted from dash computation but includes for font/size", () => {
    const input: StyleStateInput[] = [
      { type: "geo", props: { dash: "dashed", font: "sans", size: "m" } },
      { type: "geo", props: { dash: "solid", font: "sans", size: "m" } },
    ];
    const out = deriveUnifiedStyleState(input);
    // Only solid counts → unified
    expect(out.dash).toBe("solid");
    expect(out.font).toBe("sans");
  });

  it("skips frame/schema-container for font, size, but includes container for dash", () => {
    const input: StyleStateInput[] = [
      { type: "frame", props: { font: "sans" /* native: no font */ } },
      { type: "schema-container", props: { dash: "solid", font: "draw" } },
    ];
    const out = deriveUnifiedStyleState(input);
    expect(out.dash).toBe("solid"); // from container only
    expect(out.font).toBeNull(); // both skipped → null
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun --cwd apps/frontend test src/shapes/derive-unified-style-state.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement derive helper**

Create `apps/frontend/src/shapes/derive-unified-style-state.ts`:
```typescript
// apps/frontend/src/shapes/derive-unified-style-state.ts
//
// Computes unified style state for a selection (or selection + descendants).
// Mirrors backend applicability matrix (apps/backend/src/routes/style-apply.ts):
//   - dash applies to geo/arrow/schema-container; skip note/text/frame.
//   - font applies to geo/note/text/arrow; skip frame/schema-container.
//   - size applies to geo/note/text/arrow; skip frame/schema-container.
// Dashed/dotted shapes excluded from dash unification (preserved by sweep).

import type { StyleDash, StyleFont, StyleSize } from "@shemma/domain";

export type StyleStateInput = {
  type: string;
  props: Record<string, unknown>;
};

export type UnifiedStyleState = {
  dash: StyleDash | null;
  font: StyleFont | null;
  size: StyleSize | null;
};

const DASH_TYPES = new Set(["geo", "arrow", "schema-container"]);
const FONT_TYPES = new Set(["geo", "note", "text", "arrow"]);
const SIZE_TYPES = new Set(["geo", "note", "text", "arrow"]);

function unify<T extends string>(
  values: ReadonlyArray<T | undefined>,
): T | null {
  let result: T | null = null;
  for (const v of values) {
    if (v === undefined) continue;
    if (result === null) {
      result = v;
    } else if (result !== v) {
      return null; // mixed
    }
  }
  return result;
}

export function deriveUnifiedStyleState(
  shapes: ReadonlyArray<StyleStateInput>,
): UnifiedStyleState {
  const dashValues: Array<StyleDash | undefined> = [];
  const fontValues: Array<StyleFont | undefined> = [];
  const sizeValues: Array<StyleSize | undefined> = [];

  for (const s of shapes) {
    if (DASH_TYPES.has(s.type)) {
      const d = s.props.dash as string | undefined;
      if (d === "draw" || d === "solid") dashValues.push(d);
      // dashed/dotted ignored
    }
    if (FONT_TYPES.has(s.type)) {
      const f = s.props.font as string | undefined;
      if (f === "draw" || f === "sans" || f === "mono") fontValues.push(f);
    }
    if (SIZE_TYPES.has(s.type)) {
      const sz = s.props.size as string | undefined;
      if (sz === "s" || sz === "m" || sz === "l" || sz === "xl") sizeValues.push(sz);
    }
  }

  return {
    dash: unify(dashValues),
    font: unify(fontValues),
    size: unify(sizeValues),
  };
}
```

- [ ] **Step 4: Run derive tests pass**

```bash
bun --cwd apps/frontend test src/shapes/derive-unified-style-state.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Implement applyStyleToSelection writer**

Create `apps/frontend/src/shapes/style-apply.ts`:
```typescript
// apps/frontend/src/shapes/style-apply.ts
//
// Frontend writer mirroring backend /api/agent/style-apply. Performs optimistic
// editor.updateShape() on selected shapes + descendants (using the same
// applicability matrix as backend), затем POST'ит на endpoint. Frontend
// SelectionPanel pass'ит respectUserOwned: false (explicit user action).

import type { Editor, TLShapeId } from "tldraw";
import type { StyleDefaults } from "@shemma/domain";
import { postStyleApply } from "../settings/api";

const APPLY_DASH = new Set(["geo", "arrow", "schema-container"]);
const APPLY_FONT = new Set(["geo", "note", "text", "arrow"]);
const APPLY_SIZE = new Set(["geo", "note", "text", "arrow"]);
const STICKY_PARENT = new Set(["frame", "schema-container"]);
const PRESERVED_DASH = new Set(["dashed", "dotted"]);

function applyPropsToShape(
  editor: Editor,
  id: TLShapeId,
  styles: StyleDefaults,
): boolean {
  const shape = editor.getShape(id);
  if (!shape) return false;
  const props = (shape.props ?? {}) as Record<string, unknown>;
  const nextProps: Record<string, unknown> = { ...props };
  let changed = false;
  if (styles.dash !== undefined && APPLY_DASH.has(shape.type)) {
    if (!PRESERVED_DASH.has(props.dash as string) && nextProps.dash !== styles.dash) {
      nextProps.dash = styles.dash;
      changed = true;
    }
  }
  if (styles.font !== undefined && APPLY_FONT.has(shape.type)) {
    if (nextProps.font !== styles.font) {
      nextProps.font = styles.font;
      changed = true;
    }
  }
  if (styles.size !== undefined && APPLY_SIZE.has(shape.type)) {
    if (nextProps.size !== styles.size) {
      nextProps.size = styles.size;
      changed = true;
    }
  }
  if (!changed) return false;
  // biome-ignore lint/suspicious/noExplicitAny: tldraw props untyped per-shape
  editor.updateShape({ id, type: shape.type, props: nextProps } as any);
  return true;
}

function applyStickyMeta(
  editor: Editor,
  id: TLShapeId,
  styles: StyleDefaults,
): boolean {
  const shape = editor.getShape(id);
  if (!shape || !STICKY_PARENT.has(shape.type)) return false;
  const meta = (shape.meta ?? {}) as Record<string, unknown>;
  const prev = (meta.didrawStyleDefaults ?? {}) as StyleDefaults;
  const next: StyleDefaults = { ...prev };
  let changed = false;
  for (const key of ["dash", "font", "size"] as const) {
    const v = styles[key];
    if (v !== undefined && next[key] !== v) {
      next[key] = v as never;
      changed = true;
    }
  }
  if (!changed) return false;
  // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
  editor.updateShape({
    id,
    type: shape.type,
    meta: { ...meta, didrawStyleDefaults: next },
  } as any);
  return true;
}

function collectDescendantIds(editor: Editor, rootIds: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...rootIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const kids = editor.getSortedChildIdsForParent(id as TLShapeId);
    for (const k of kids) if (!out.has(k)) stack.push(k);
  }
  return out;
}

export async function applyStyleToSelection(
  editor: Editor,
  selectedIds: string[],
  styles: StyleDefaults,
): Promise<void> {
  if (selectedIds.length === 0 || Object.keys(styles).length === 0) return;

  const targets = collectDescendantIds(editor, selectedIds);

  editor.run(() => {
    for (const id of selectedIds) {
      applyStickyMeta(editor, id as TLShapeId, styles);
    }
    for (const id of targets) {
      applyPropsToShape(editor, id as TLShapeId, styles);
    }
  });

  // SSR-safe POST (mirror SchemaContainerActions).
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const space = url.searchParams.get("space") ?? "default";
  const room = url.searchParams.get("room") ?? "default";

  try {
    await postStyleApply(space, room, {
      selectedIds,
      styles,
      respectUserOwned: false, // explicit user UI action
    });
  } catch {
    // Optimistic update already applied; non-fatal.
  }
}
```

- [ ] **Step 6: Verify frontend type-check**

```bash
bun --cwd apps/frontend tsc --noEmit
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/shapes/derive-unified-style-state.ts apps/frontend/src/shapes/derive-unified-style-state.test.ts apps/frontend/src/shapes/style-apply.ts
git commit -m "feat(style-propagation): frontend deriveUnifiedStyleState + applyStyleToSelection writer"
```

---

## Task 6: StylesSection component (3 переключателя + indeterminate)

**Files:**
- Modify: `apps/frontend/src/settings/sections/StylesSection.tsx` (полная замена)

- [ ] **Step 1: Rewrite StylesSection.tsx**

Replace contents of `apps/frontend/src/settings/sections/StylesSection.tsx`:
```typescript
// apps/frontend/src/settings/sections/StylesSection.tsx
//
// Style propagation: переключатели Линия / Шрифт / Размер. Состояние derived
// (null = mixed/indeterminate, иначе одно из enum значений). Один клик —
// одна atomic операция: sticky на parent (frame/container) + props sweep на
// descendants (см. parent calls applyStyleToSelection / postStyleDefaults).

import type { FC } from "react";
import type { StyleDash, StyleFont, StyleSize } from "@shemma/domain";

export type StyleSectionValue = {
  dash: StyleDash | null;
  font: StyleFont | null;
  size: StyleSize | null;
};

export type StylesSectionProps = {
  current: StyleSectionValue;
  onDash: (v: StyleDash) => void;
  onFont: (v: StyleFont) => void;
  onSize: (v: StyleSize) => void;
  /** Опционально: заголовок-помощник (BoardPanel = "по умолчанию", SelectionPanel = "Для этого контейнера"). */
  subtitle?: string;
};

const DASH_LABELS: Record<StyleDash, string> = {
  draw: "Draw",
  solid: "Solid",
};

const FONT_LABELS: Record<StyleFont, string> = {
  draw: "Draw",
  sans: "Sans",
  mono: "Mono",
};

const SIZE_LABELS: Record<StyleSize, string> = {
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
};

const DASH_TOOLTIP =
  "Применяется только к непрерывным линиям (Draw / Solid). Пунктирные и точечные настраиваются через нативную панель.";

export const StylesSection: FC<StylesSectionProps> = ({
  current,
  onDash,
  onFont,
  onSize,
  subtitle,
}) => (
  <div className="settings-section settings-section--styles">
    <div className="settings-section__label">Стили</div>
    {subtitle && <div className="settings-section__sublabel">{subtitle}</div>}

    <div className="settings-section__row" title={DASH_TOOLTIP}>
      <span className="settings-section__rowlabel">Линия</span>
      {(["draw", "solid"] as const).map((v) => (
        <button
          key={v}
          type="button"
          data-style-dash={v}
          onClick={() => onDash(v)}
          className={`settings-btn${current.dash === v ? " settings-btn--on" : ""}${current.dash === null ? "" : ""}`}
        >
          {DASH_LABELS[v]}
        </button>
      ))}
    </div>

    <div className="settings-section__row">
      <span className="settings-section__rowlabel">Шрифт</span>
      {(["draw", "sans", "mono"] as const).map((v) => (
        <button
          key={v}
          type="button"
          data-style-font={v}
          onClick={() => onFont(v)}
          className={`settings-btn${current.font === v ? " settings-btn--on" : ""}`}
        >
          {FONT_LABELS[v]}
        </button>
      ))}
    </div>

    <div className="settings-section__row">
      <span className="settings-section__rowlabel">Размер</span>
      {(["s", "m", "l", "xl"] as const).map((v) => (
        <button
          key={v}
          type="button"
          data-style-size={v}
          onClick={() => onSize(v)}
          className={`settings-btn${current.size === v ? " settings-btn--on" : ""}`}
        >
          {SIZE_LABELS[v]}
        </button>
      ))}
    </div>
  </div>
);
```

- [ ] **Step 2: Verify frontend type-check**

```bash
bun --cwd apps/frontend tsc --noEmit
```
Expected: no errors (BoardPanel passes `<StylesSection />` without props — будет typecheck error до Task 7; fix в Task 7).

Note: this step intentionally может flagнуть error в BoardPanel — мы фиксим в Task 7. Если ошибка ровно в BoardPanel — продолжаем; любая другая — баг.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/settings/sections/StylesSection.tsx
git commit -m "feat(style-propagation): StylesSection 3 row toggles (replaces stub)"
```

---

## Task 7: Wire BoardPanel — StylesSection с state из getStyleDefaults

**Files:**
- Modify: `apps/frontend/src/settings/panels/BoardPanel.tsx`
- Modify: `apps/frontend/src/settings/SettingsPopover.tsx` (или wherever owns state — найти fetch для layoutParams и добавить style fetch рядом)

**State owner:** `apps/frontend/src/settings/SettingsPopover.tsx` (handles both BoardPanel и SelectionPanel state). Pattern reference: line 42 (`getLayoutParams(space, room).then(setBoardParams)`) и line 185 (`postLayoutParams` POST flow).

- [ ] **Step 1: Add style-defaults state в SettingsPopover.tsx**

Extend imports in `apps/frontend/src/settings/SettingsPopover.tsx`:

```typescript
import {
  getLayoutParams, postLayoutParams, postLayoutSelection,
  getStyleDefaults, postStyleDefaults,   // NEW
  type LayoutParamsResponse,
  type StyleDefaultsResponse,             // NEW
} from "./api";
import type { StyleDefaults, StyleDash, StyleFont, StyleSize } from "@shemma/domain";
```

Add state + fetch (mirror line 42 pattern):
```typescript
const [styleDefaults, setStyleDefaults] = useState<StyleDefaultsResponse | null>(null);

useEffect(() => {
  getStyleDefaults(space, room).then(setStyleDefaults).catch(() => setStyleDefaults(null));
}, [space, room]);
```

Add board-level handler (mirror line 185 pattern):
```typescript
async function handleBoardStyle<K extends keyof StyleDefaults>(
  key: K,
  value: NonNullable<StyleDefaults[K]>,
) {
  const next: StyleDefaults = { ...(styleDefaults?.raw ?? {}), [key]: value };
  try {
    const r = await postStyleDefaults(space, room, next);
    setStyleDefaults({ raw: next, effective: r.effective });
  } catch {
    /* non-fatal */
  }
}
```

```typescript
import {
  getStyleDefaults,
  postStyleDefaults,
  type StyleDefaultsResponse,
} from "./api";
import type { StyleDefaults } from "@shemma/domain";

// Inside the component:
const [styleDefaults, setStyleDefaults] = useState<StyleDefaultsResponse | null>(null);

useEffect(() => {
  // Same space/room source as layout params
  void getStyleDefaults(space, room).then(setStyleDefaults);
}, [space, room]);

async function handleStyleDefaultChange(key: keyof StyleDefaults, value: StyleDefaults[typeof key]) {
  const next: StyleDefaults = { ...(styleDefaults?.raw ?? {}), [key]: value };
  const res = await postStyleDefaults(space, room, next);
  setStyleDefaults({ raw: next, effective: res.effective });
}
```

- [ ] **Step 2: Modify BoardPanel.tsx — accept new props and render StylesSection**

Modify `apps/frontend/src/settings/panels/BoardPanel.tsx`:

```typescript
import { StylesSection, type StyleSectionValue } from "../sections/StylesSection";
import type { StyleDash, StyleFont, StyleSize, ResolvedStyleDefaults } from "@shemma/domain";

// Extend BoardPanelProps:
export type BoardPanelProps = {
  effective: LayoutParams;
  onDirectionChange: (d: DirectionValue) => void;
  onPresetSelect: (preset: PresetName) => void;
  onToggleAutoDirection: (enabled: boolean) => void;
  onMidpointModeChange: (mode: "even" | "fixed-0.5") => void;
  onOpenAdvanced: () => void;
  // NEW:
  styleEffective: ResolvedStyleDefaults;
  onStyleDash: (v: StyleDash) => void;
  onStyleFont: (v: StyleFont) => void;
  onStyleSize: (v: StyleSize) => void;
};

// In component body, replace <StylesSection /> with:
const styleValue: StyleSectionValue = {
  dash: styleEffective.dash,
  font: styleEffective.font,
  size: styleEffective.size,
};

// In JSX where <StylesSection /> was:
<StylesSection
  current={styleValue}
  onDash={onStyleDash}
  onFont={onStyleFont}
  onSize={onStyleSize}
/>
```

Pass new props from parent (the panel owner from Step 2): `onStyleDash={(v) => handleStyleDefaultChange("dash", v)}`, etc.

- [ ] **Step 3: Pass new props from SettingsPopover → BoardPanel**

В JSX, где `<BoardPanel ... />` рендерится, добавить:
```typescript
<BoardPanel
  effective={boardParams?.effective ?? DEFAULT_LAYOUT_PARAMS}
  // ...existing layout props...
  styleEffective={styleDefaults?.effective ?? DEFAULT_STYLE_DEFAULTS}
  onStyleDash={(v) => handleBoardStyle("dash", v)}
  onStyleFont={(v) => handleBoardStyle("font", v)}
  onStyleSize={(v) => handleBoardStyle("size", v)}
/>
```

Import `DEFAULT_STYLE_DEFAULTS` from `@shemma/domain`.

- [ ] **Step 4: Verify type-check passes**

```bash
bun --cwd apps/frontend tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/panels/BoardPanel.tsx apps/frontend/src/settings/SettingsPopover.tsx
git commit -m "feat(style-propagation): wire BoardPanel StylesSection with persistent room defaults"
```

---

## Task 8: Wire SelectionPanel — conditional на frame/container в selection

**Files:**
- Modify: `apps/frontend/src/settings/panels/SelectionPanel.tsx`
- Modify: panel owner (same file as Task 7 — extend selection state)

- [ ] **Step 1: Extend SelectionPanelProps**

Modify `apps/frontend/src/settings/panels/SelectionPanel.tsx`:
```typescript
import { StylesSection, type StyleSectionValue } from "../sections/StylesSection";
import type { StyleDash, StyleFont, StyleSize } from "@shemma/domain";

// Extend SelectionPanelProps:
export type SelectionPanelProps = {
  // ...existing props...
  /**
   * Style section visibility — true только если в selection ≥1 frame/schema-container.
   * Plain multi-select без container/frame → native справится сам.
   */
  showStyles: boolean;
  styleState: StyleSectionValue;
  onStyleDash: (v: StyleDash) => void;
  onStyleFont: (v: StyleFont) => void;
  onStyleSize: (v: StyleSize) => void;
};
```

Render `<StylesSection>` conditionally inside the component (after existing sections, before footer):
```typescript
{showStyles && (
  <StylesSection
    current={styleState}
    onDash={onStyleDash}
    onFont={onStyleFont}
    onSize={onStyleSize}
    subtitle="Для выделения"
  />
)}
```

- [ ] **Step 2: Compute selection style state in owner**

In panel owner (same file as Task 7), compute `styleState` and `showStyles` from current tldraw selection:

```typescript
import { applyStyleToSelection } from "../shapes/style-apply";
import { deriveUnifiedStyleState } from "../shapes/derive-unified-style-state";

// Inside selection-watch hook (likely useEffect on selection change):
const selectedIds = editor.getSelectedShapeIds();
const selectedShapes = selectedIds.map((id) => editor.getShape(id)).filter(Boolean);
const hasFrameOrContainer = selectedShapes.some(
  (s) => s.type === "frame" || s.type === "schema-container",
);

// For derive: include selected + descendants (recursive)
function collectIds(ids: string[]): string[] {
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const kids = editor.getSortedChildIdsForParent(id as TLShapeId);
    for (const k of kids) stack.push(k);
  }
  return Array.from(out);
}

const targetIds = collectIds(selectedIds);
const targetShapes = targetIds
  .map((id) => editor.getShape(id as TLShapeId))
  .filter((s): s is NonNullable<typeof s> => Boolean(s))
  .map((s) => ({ type: s.type, props: s.props as Record<string, unknown> }));

const styleState = deriveUnifiedStyleState(targetShapes);
const showStyles = hasFrameOrContainer;

async function handleSelectionStyle(key: keyof StyleDefaults, value: StyleDefaults[typeof key]) {
  await applyStyleToSelection(editor, selectedIds, { [key]: value });
}
```

Pass to `<SelectionPanel>`:
```typescript
<SelectionPanel
  // ...existing...
  showStyles={showStyles}
  styleState={styleState}
  onStyleDash={(v) => handleSelectionStyle("dash", v)}
  onStyleFont={(v) => handleSelectionStyle("font", v)}
  onStyleSize={(v) => handleSelectionStyle("size", v)}
/>
```

- [ ] **Step 3: Verify type-check passes**

```bash
bun --cwd apps/frontend tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Run frontend tests**

```bash
bun --cwd apps/frontend test src/shapes src/settings
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/panels/SelectionPanel.tsx apps/frontend/src/settings/SettingsPopover.tsx
git commit -m "feat(style-propagation): wire SelectionPanel StylesSection (frame/container visibility)"
```

---

## Task 9: Bidirectional sync с tldraw + resolution chain

**Files:**
- Create: `apps/frontend/src/canvas/style-defaults-sync.ts`
- Modify: `apps/frontend/src/App.tsx:699-731` (onMount block — wire sync disposer)

- [ ] **Step 1: Implement style-defaults-sync**

Create `apps/frontend/src/canvas/style-defaults-sync.ts`:
```typescript
// apps/frontend/src/canvas/style-defaults-sync.ts
//
// Bidirectional sync для board-level style defaults между:
//   - tldraw editor.setStyleForNextShape (in-memory session)
//   - room.meta.styleDefaults (persistent via POST /api/board/style-defaults)
//
// Plus container-level resolution via editor.sideEffects.registerBeforeCreateHandler:
//   при создании shape интроспектируем parent chain → applyStyleDefaultsResolution.
//
// Returns disposer.

import {
  DefaultDashStyle,
  DefaultFontStyle,
  DefaultSizeStyle,
  type Editor,
  type TLShape,
  type TLShapeId,
} from "tldraw";
import {
  applyStyleDefaultsResolution,
  type StyleDefaults,
  type StyleDash,
  type StyleFont,
  type StyleSize,
} from "@shemma/domain";
import {
  getStyleDefaults,
  postStyleDefaults,
  type StyleDefaultsResponse,
} from "../settings/api";

const ECHO_TTL_MS = 200;

type EchoMap = Map<string, { value: string; expiresAt: number }>;

/** Read sticky meta from a shape (frame or schema-container). */
function readSticky(shape: TLShape | undefined): StyleDefaults {
  if (!shape) return {};
  if (shape.type !== "frame" && shape.type !== "schema-container") return {};
  const meta = (shape.meta ?? {}) as Record<string, unknown>;
  const sticky = meta.didrawStyleDefaults as StyleDefaults | undefined;
  return sticky ?? {};
}

function buildResolutionChain(
  editor: Editor,
  parentId: string | undefined,
  roomDefaults: StyleDefaults | null,
): StyleDefaults[] {
  const chain: StyleDefaults[] = [];
  let p: string | undefined = parentId;
  while (p && p !== "page:page") {
    const shape = editor.getShape(p as TLShapeId);
    if (!shape) break;
    const sticky = readSticky(shape);
    if (Object.keys(sticky).length > 0) chain.push(sticky);
    p = (shape.parentId as string | undefined) ?? undefined;
  }
  if (roomDefaults) chain.push(roomDefaults);
  return chain;
}

function applyStylesToShape(shape: TLShape, defaults: StyleDefaults): TLShape {
  const props = (shape.props ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...props };
  const TYPE = shape.type;

  // Same applicability matrix as backend / frontend writers.
  if (defaults.dash !== undefined && (TYPE === "geo" || TYPE === "arrow" || TYPE === "schema-container")) {
    if (next.dash !== defaults.dash) next.dash = defaults.dash;
  }
  if (defaults.font !== undefined && (TYPE === "geo" || TYPE === "note" || TYPE === "text" || TYPE === "arrow")) {
    if (next.font !== defaults.font) next.font = defaults.font;
  }
  if (defaults.size !== undefined && (TYPE === "geo" || TYPE === "note" || TYPE === "text" || TYPE === "arrow")) {
    if (next.size !== defaults.size) next.size = defaults.size;
  }
  return { ...shape, props: next } as TLShape;
}

export function registerStyleDefaultsSync(
  editor: Editor,
  space: string,
  room: string,
): () => void {
  let roomDefaults: StyleDefaults | null = null;
  const echo: EchoMap = new Map();

  function setEcho(key: string, value: string): void {
    echo.set(key, { value, expiresAt: Date.now() + ECHO_TTL_MS });
  }
  function checkEcho(key: string, value: string): boolean {
    const e = echo.get(key);
    if (!e) return false;
    if (Date.now() > e.expiresAt) {
      echo.delete(key);
      return false;
    }
    return e.value === value;
  }

  function applyToEditor(defaults: StyleDefaults): void {
    if (defaults.dash) {
      editor.setStyleForNextShapes(DefaultDashStyle, defaults.dash);
      setEcho("dash", defaults.dash);
    }
    if (defaults.font) {
      editor.setStyleForNextShapes(DefaultFontStyle, defaults.font);
      setEcho("font", defaults.font);
    }
    if (defaults.size) {
      editor.setStyleForNextShapes(DefaultSizeStyle, defaults.size);
      setEcho("size", defaults.size);
    }
  }

  // Initial fetch
  void getStyleDefaults(space, room).then((res: StyleDefaultsResponse) => {
    roomDefaults = res.raw;
    if (res.raw) applyToEditor(res.raw);
  });

  // Editor → server: listen to changes in instance state (where setStyleForNextShapes lands).
  const unsubscribe = editor.store.listen(
    (entry) => {
      // Filter for instance/page state with style updates
      for (const update of Object.values(entry.changes.updated)) {
        if (Array.isArray(update) && update.length >= 2) {
          const [, next] = update;
          if ((next as { typeName?: string }).typeName === "instance_page_state") continue;
          if ((next as { typeName?: string }).typeName !== "instance") continue;
          const styles = (next as { stylesForNextShape?: Record<string, unknown> }).stylesForNextShape ?? {};
          const patch: StyleDefaults = {};
          let changed = false;

          const dash = styles[DefaultDashStyle.id] as StyleDash | undefined;
          if (dash && (dash === "draw" || dash === "solid") && !checkEcho("dash", dash)) {
            patch.dash = dash;
            changed = true;
          }
          const font = styles[DefaultFontStyle.id] as StyleFont | undefined;
          if (font && (font === "draw" || font === "sans" || font === "mono") && !checkEcho("font", font)) {
            patch.font = font;
            changed = true;
          }
          const size = styles[DefaultSizeStyle.id] as StyleSize | undefined;
          if (size && (size === "s" || size === "m" || size === "l" || size === "xl") && !checkEcho("size", size)) {
            patch.size = size;
            changed = true;
          }

          if (changed) {
            const merged: StyleDefaults = { ...(roomDefaults ?? {}), ...patch };
            roomDefaults = merged;
            void postStyleDefaults(space, room, merged);
          }
        }
      }
    },
    { source: "user", scope: "session" },
  );

  // Container-level resolution on shape creation.
  const beforeCreateDisposer = editor.sideEffects.registerBeforeCreateHandler(
    "shape",
    (shape) => {
      const parentId = (shape as { parentId?: string }).parentId;
      const chain = buildResolutionChain(editor, parentId, roomDefaults);
      if (chain.length === 0) return shape;
      const resolved = applyStyleDefaultsResolution(chain);
      // Apply only the keys that resolution produced; native defaults already
      // present in shape.props don't need overwriting.
      return applyStylesToShape(shape, {
        dash: resolved.dash,
        font: resolved.font,
        size: resolved.size,
      });
    },
  );

  return () => {
    unsubscribe();
    beforeCreateDisposer();
  };
}
```

- [ ] **Step 2: Wire sync in App.tsx onMount**

Modify `apps/frontend/src/App.tsx` — add ref + onMount call. Near the `autoFlipDisposerRef`:

```typescript
import { registerStyleDefaultsSync } from "./canvas/style-defaults-sync";

// Add ref at top of component:
const styleSyncDisposerRef = useRef<(() => void) | null>(null);

// In onMount, after autoFlipDisposerRef setup:
styleSyncDisposerRef.current?.();
styleSyncDisposerRef.current = registerStyleDefaultsSync(ed, space, room);
```

Where `space` and `room` are read from URL search params (likely already done elsewhere in App.tsx — find pattern).

Add cleanup on room change or unmount (mirror autoFlipDisposerRef cleanup).

- [ ] **Step 3: Verify type-check**

```bash
bun --cwd apps/frontend tsc --noEmit
```
Expected: no errors.

Note: `DefaultDashStyle.id` / `DefaultFontStyle.id` / `DefaultSizeStyle.id` — verify these exist in tldraw 5.x by `grep -rn "DefaultDashStyle" node_modules/tldraw/dist` if uncertain. Likely property accessor is `.id` or `.name`. If unavailable, use `.toString()` or another property mentioned in docs (https://tldraw.dev/docs/editor#StyleProp).

- [ ] **Step 4: Manual visual verify**

Open http://localhost:5173. Open BoardPanel → click "Solid" → tldraw native style panel should highlight Solid for next shape. Create a rectangle → it should have `dash="solid"`. Inside an existing frame with `meta.didrawStyleDefaults.font = "mono"`, create a rectangle → it should get `font="mono"` (overrides board default).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/canvas/style-defaults-sync.ts apps/frontend/src/App.tsx
git commit -m "feat(style-propagation): bidirectional sync with tldraw + container resolution chain"
```

---

## Task 10: Live verify scenarios + screenshots

**Performed by:** Controller (main agent) using chrome-devtools MCP. NOT a subagent — per [[feedback-no-subagent-screenshot-trust]] visual quality must be verified by controller directly.

- [ ] **Step 1: Run all tests**

```bash
bun run test
```
Expected: 2033+ pass / 0 fail (existing baseline + new tests). Note new test counts.

- [ ] **Step 2: Scenario A — BoardPanel persistence**

1. Open http://localhost:5173 in chrome.
2. Open BoardPanel.
3. Click Линия=Solid, Шрифт=Sans, Размер=M.
4. Reload page. Verify BoardPanel still shows Solid/Sans/M.
5. Create a new rectangle via tldraw native toolbar.
6. Verify rectangle props: dash="solid", font="sans", size="m".
7. **Assert**: existing shapes on canvas remained with their original styles (BoardPanel doesn't sweep existing).

Take screenshot, save reference in `docs/screenshots/style-propagation-scenario-a.png`.

- [ ] **Step 3: Scenario B — SelectionPanel container sweep**

1. Create a frame with 3 child shapes (geo, note, arrow).
2. Select the frame.
3. Open SelectionPanel — verify "Стили" section visible with current state derived from children.
4. Click Шрифт=Mono.
5. Verify all 3 children now have `font="mono"`.
6. Verify frame has `meta.didrawStyleDefaults.font = "mono"`.

Save screenshot.

- [ ] **Step 4: Scenario C — Indeterminate → resolved**

1. Create 3 shapes with different fonts (draw, sans, mono) inside a frame.
2. Select frame.
3. Verify Шрифт row has no button highlighted (indeterminate).
4. Click Sans.
5. Verify all 3 → font=sans (unified).

- [ ] **Step 5: Scenario D — Nested frame > container > shape**

1. Create frame containing schema-container containing 1 note.
2. Select the outer frame.
3. Click Шрифт=Sans.
4. Verify note got font=sans.
5. Verify schema-container has `meta.didrawStyleDefaults.font="sans"`.

- [ ] **Step 6: Scenario E — Dashed shape preserved**

1. Create geo with dash="dashed" (via native panel).
2. Select frame containing it.
3. Click Линия=Solid.
4. Verify dashed geo still has dash="dashed" (preserved).
5. Other (non-dashed) children in same frame got dash="solid".

- [ ] **Step 7: Scenario F — Bidirectional sync**

1. Click Solid in BoardPanel → verify tldraw native style panel highlights Solid for next shape.
2. Open tldraw native style panel → click Draw → verify BoardPanel updates to Draw.
3. Reload — last choice persisted.

- [ ] **Step 8: Visibility rules verify**

1. Select 2 plain geo shapes (no frame/container). Verify SelectionPanel does NOT show "Стили" section.
2. Add frame to selection. Verify section appears.

- [ ] **Step 9: SelectionPanel does NOT pop up for single-select**

1. Click a single geo shape.
2. Verify native tldraw panel works.
3. Verify our SelectionPanel either hidden or doesn't show "Стили" (rule: visible only when ≥1 frame/container in selection).

- [ ] **Step 10: Final commit (only if any visual-only adjustments were needed)**

If any CSS or panel adjustments needed during live verify, commit them now:
```bash
git add -p  # selective stage
git commit -m "fix(style-propagation): post-live-verify visual adjustments"
```

If no adjustments needed, no commit.

- [ ] **Step 11: Run full test suite again**

```bash
bun run test && bun --cwd apps/frontend test
```
Expected: all green.

---

## Post-implementation: phase-end review

Per [[feedback-batched-reviews]]: single full review at end of phase, then merge.

- [ ] **Step 1: Run code-simplifier on phase diff**

```bash
git log --oneline main..HEAD
git diff main..HEAD --stat
```
Pass diff to `code-simplifier` agent.

- [ ] **Step 2: Spec + quality review pass**

Single review covering all 10 tasks. Use `dnz:reviewer` agent.

- [ ] **Step 3: Fix issues**

- [ ] **Step 4: Update CHANGELOG.md**

Add entry under unreleased section:
```markdown
- Style propagation: BoardPanel и SelectionPanel получили секцию Стили
  (Линия Draw/Solid, Шрифт Draw/Sans/Mono, Размер S/M/L/XL). Один клик
  переключает выделенные shapes + всех descendants frame/container.
  Bidirectional sync с tldraw native style panel. Persistent в
  room.meta.styleDefaults и meta.didrawStyleDefaults.
```

- [ ] **Step 5: Update backlog**

```bash
backlog task create "Style propagation (Линия/Шрифт/Размер + sweep)" --priority medium --labels "feature,style" -d "Sub-project 3 of DRW-180. См. docs/superpowers/specs/2026-05-27-style-propagation-design.md" --plain
# Rename file to drw-NNN-style-propagation.md (find NNN from create output)
backlog task edit DRW-NNN -s "Done"
backlog task archive DRW-NNN  # after user acceptance
```

- [ ] **Step 6: Merge to main**

After explicit user acceptance:
```bash
git checkout main
git merge --no-ff feature/style-propagation -m "merge: feature/style-propagation → main (DRW-NNN style propagation)"
git branch -d feature/style-propagation
```

---

## Self-Review checklist для controller (после plan written)

### Spec coverage

| Spec requirement | Plan task |
|---|---|
| Domain `StyleDefaults` type + validators | Task 1 |
| `room.meta.styleDefaults` persistence | Task 2 (backend), Task 7 (frontend wire) |
| `meta.didrawStyleDefaults` on frame/container | Task 3 (backend sticky), Task 5 (frontend writer) |
| Atomic sweep endpoint `/api/agent/style-apply` | Task 3 |
| `respectUserOwned` flag | Task 3 |
| Frontend writer `applyStyleToSelection` | Task 5 |
| `deriveUnifiedStyleState` helper | Task 5 |
| `StylesSection` 3 переключателя + indeterminate | Task 6 |
| BoardPanel wire (always visible) | Task 7 |
| SelectionPanel conditional (frame/container) | Task 8 |
| Bidirectional sync с native panel + echo-guard | Task 9 |
| `registerBeforeCreateHandler` для resolution chain | Task 9 |
| Dashed/dotted preservation | Task 3 (backend), Task 5 (frontend writer) |
| Per-shape applicability matrix | Task 3 (backend), Task 5 (writer + derive) |
| Live verify scenarios A–F | Task 10 |

Все требования покрыты.

### Type consistency

- `StyleDefaults` / `ResolvedStyleDefaults` / `StyleDash` / `StyleFont` / `StyleSize` — единые имена через Task 1 и далее.
- `applyStyleDefaultsResolution(chain: StyleDefaults[])` — same signature в Task 1, 9.
- `applyStyleToSelection(editor, ids, styles)` — Task 5, used by Task 8.
- `deriveUnifiedStyleState(shapes)` — Task 5, used by Task 8.
- Endpoint paths `/api/board/style-defaults` (GET/POST) и `/api/agent/style-apply` — consistent через Task 2, 3, 4, 9.

### No placeholders

Все steps содержат конкретный code/command/expected output. Один known gap — Task 7 step 1 требует grep-based discovery of `SettingsPopover.tsx` или эквивалентного state-owner'а; команда указана.

Plan ready for execution.
