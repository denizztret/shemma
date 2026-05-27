# Settings Popover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) или superpowers:executing-plans для пошагового исполнения. Steps использует checkbox (`- [ ]`) синтаксис.

**Goal:** Реализовать opt-in floating popover, который открывается по Option+click и показывает three panel'а: SelectionPanel (shape/multi/Frame), NodePanel (single semantic node), BoardPanel (LayoutParams + presets + Advanced).

**Architecture:** Один React-компонент `<SettingsPopover />` через tldraw `components.InFrontOfTheCanvas` slot. Изолированные Panel'и + sections + thin API wrapper. Per-shape mutations через `editor.updateShape({meta}) + WS sync` (как role-picker); per-board — новый `GET+POST /api/board/layout-params`. `forceUnpin` добавляется к existing `POST /api/agent/layout-selection`.

**Tech Stack:** tldraw 5.x, React 18, bun (test runner + backend), Vite (frontend), `@shemma/domain` (LayoutParams source-of-truth).

**Spec:** `docs/superpowers/specs/2026-05-27-settings-popover-design.md`

**Branch:** `feature/settings-popover-design` (создана в brainstorm phase, commits `f58cbd0` spec v0.1 + `a9ddf15` self-review).

---

## File Map

### New files

```
apps/frontend/src/settings/
├─ SettingsPopover.tsx              ← root component, registered in components.InFrontOfTheCanvas
├─ useSettingsTrigger.ts            ← hook + pure resolveTarget()
├─ useSettingsTrigger.test.ts
├─ position.ts                       ← clampToViewport + anchor calculation
├─ position.test.ts
├─ api.ts                            ← HTTP wrappers: getLayoutParams, postLayoutParams, postLayoutSelection
├─ api.test.ts
├─ panels/
│   ├─ SelectionPanel.tsx
│   ├─ NodePanel.tsx
│   ├─ BoardPanel.tsx
│   └─ BoardPanelAdvanced.tsx
├─ sections/
│   ├─ DirectionSection.tsx
│   ├─ LayoutSection.tsx
│   ├─ PinSection.tsx
│   ├─ RoleSection.tsx
│   ├─ StylesSection.tsx             ← stub, returns "coming soon" placeholder
│   └─ sections.test.ts              ← pure-function tests for shared helpers
└─ presets.ts                        ← SPACING_PRESETS + reverseMapPreset()
└─ presets.test.ts
```

Backend:

```
apps/backend/src/routes/
└─ board-layout-params.ts            ← new: GET + POST handlers

apps/backend/tests/
├─ routes-board-layout-params.test.ts
└─ routes-layout-selection-force-unpin.test.ts
```

### Modified files

- `apps/frontend/src/App.tsx` — register `SettingsPopover` через components prop (или внутри `buildTldrawComponents` — выбор в Task 1).
- `apps/frontend/src/chrome/TldrawComponents.tsx` — добавить slot `InFrontOfTheCanvas` в build function.
- `apps/backend/src/routes/layout-selection.ts` — accept `forceUnpin: boolean` body flag.
- `apps/backend/src/domain/layout.ts` — `runLayout(...)` accepts `forceUnpin` option; backend reads `roomMeta.layoutParams`.
- `apps/backend/src/routes/schema.ts` — все вызовы `runLayout(...)` передают `applyLayoutParamsDefaults(roomMeta.layoutParams ?? {})`.

---

## Task 0: Create backlog task

- [ ] **Step 1: Create DRW task for this feature**

```bash
backlog task create "Settings popover (Option+click)" \
  --priority high \
  --labels "feature,ui" \
  -d "Floating popover via tldraw InFrontOfTheCanvas slot. SelectionPanel/NodePanel/BoardPanel + spacing presets + Advanced drill-down. Spec: docs/superpowers/specs/2026-05-27-settings-popover-design.md" \
  --plain
```

Note the assigned DRW number (e.g. DRW-183) — used in Task 21 CHANGELOG entry.

- [ ] **Step 2: Rename file to `drw-NNN-settings-popover.md`**

Per [[backlog-md-tooling]] — backlog CLI создаёт длинное имя; переименовать:

```bash
mv backlog/tasks/drw-NNN-*.md backlog/tasks/drw-NNN-settings-popover.md
```

- [ ] **Step 3: Mark task In Progress**

```bash
backlog task edit DRW-NNN -s "In Progress"
```

---

## Task 1: Foundation — `resolveTarget` pure logic + tests

**Files:**
- Create: `apps/frontend/src/settings/useSettingsTrigger.ts`
- Create: `apps/frontend/src/settings/useSettingsTrigger.test.ts`

Чистая логика разрешения target отделена от React-хука, чтобы тестировать без editor.

- [ ] **Step 1: Write failing tests**

```ts
// apps/frontend/src/settings/useSettingsTrigger.test.ts
import { describe, expect, test } from "bun:test";
import { resolveTarget, type ResolveInput, type Target } from "./useSettingsTrigger";

function shape(id: string, type: string, didrawId?: string) {
  return { id, type, meta: didrawId ? { didrawId } : {} };
}

describe("resolveTarget", () => {
  test("no hit + no selection → board target with pointer anchor", () => {
    const result = resolveTarget({
      hit: null,
      selectedIds: [],
      pointerScreen: { x: 100, y: 200 },
      bbox: () => null,
    } satisfies ResolveInput);
    expect(result).toEqual({ kind: "board", anchor: { x: 100, y: 200 } });
  });

  test("hit in multi-selection → selection target with bbox of selection", () => {
    const result = resolveTarget({
      hit: shape("s:a", "geo", "node-a"),
      selectedIds: ["s:a", "s:b"],
      pointerScreen: { x: 0, y: 0 },
      bbox: (ids) => (ids.length === 2 ? { x: 10, y: 10, w: 100, h: 50 } : null),
    });
    expect(result).toEqual({
      kind: "selection",
      anchor: { x: 10, y: 10, w: 100, h: 50 },
    });
  });

  test("hit on schema-container → selection target of size 1 (single Frame)", () => {
    const result = resolveTarget({
      hit: shape("s:c1", "schema-container"),
      selectedIds: [],
      pointerScreen: { x: 0, y: 0 },
      bbox: () => ({ x: 0, y: 0, w: 200, h: 100 }),
    });
    expect(result).toEqual({
      kind: "selection",
      anchor: { x: 0, y: 0, w: 200, h: 100 },
    });
  });

  test("hit on shape with meta.didrawId → node target", () => {
    const result = resolveTarget({
      hit: shape("s:n1", "geo", "node-1"),
      selectedIds: [],
      pointerScreen: { x: 0, y: 0 },
      bbox: () => ({ x: 5, y: 5, w: 80, h: 40 }),
    });
    expect(result).toEqual({
      kind: "node",
      subjectId: "s:n1",
      anchor: { x: 5, y: 5, w: 80, h: 40 },
    });
  });

  test("hit on default shape without meta.didrawId → null (no popover)", () => {
    const result = resolveTarget({
      hit: shape("s:x", "geo"),
      selectedIds: [],
      pointerScreen: { x: 0, y: 0 },
      bbox: () => null,
    });
    expect(result).toBeNull();
  });

  test("hit outside non-empty selection → opens by hit, not by selection (Note 3)", () => {
    const result = resolveTarget({
      hit: shape("s:other", "geo", "node-other"),
      selectedIds: ["s:a", "s:b"],
      pointerScreen: { x: 0, y: 0 },
      bbox: (ids) => (ids[0] === "s:other" ? { x: 1, y: 2, w: 3, h: 4 } : null),
    });
    expect(result).toEqual({
      kind: "node",
      subjectId: "s:other",
      anchor: { x: 1, y: 2, w: 3, h: 4 },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
bun test apps/frontend/src/settings/useSettingsTrigger.test.ts
```
Expected: FAIL — `Cannot find module './useSettingsTrigger'`.

- [ ] **Step 3: Implement `resolveTarget`**

```ts
// apps/frontend/src/settings/useSettingsTrigger.ts
export type Anchor = { x: number; y: number; w?: number; h?: number };

export type Target =
  | { kind: "board"; anchor: Anchor }
  | { kind: "selection"; anchor: Anchor }
  | { kind: "node"; subjectId: string; anchor: Anchor };

export type ResolveInput = {
  hit: { id: string; type: string; meta?: Record<string, unknown> } | null;
  selectedIds: string[];
  pointerScreen: { x: number; y: number };
  bbox: (ids: string[]) => Anchor | null;
};

export function resolveTarget(input: ResolveInput): Target | null {
  const { hit, selectedIds, pointerScreen, bbox } = input;

  if (hit && selectedIds.includes(hit.id) && selectedIds.length > 1) {
    const a = bbox(selectedIds);
    if (!a) return null;
    return { kind: "selection", anchor: a };
  }
  if (hit) {
    if (hit.type === "schema-container") {
      const a = bbox([hit.id]);
      if (!a) return null;
      return { kind: "selection", anchor: a };
    }
    if (hit.meta?.didrawId) {
      const a = bbox([hit.id]);
      if (!a) return null;
      return { kind: "node", subjectId: hit.id, anchor: a };
    }
    return null; // default tldraw shape without semantic meta
  }
  if (selectedIds.length >= 1) {
    const a = bbox(selectedIds);
    if (!a) return null;
    return { kind: "selection", anchor: a };
  }
  return { kind: "board", anchor: pointerScreen };
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
bun test apps/frontend/src/settings/useSettingsTrigger.test.ts
```
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/useSettingsTrigger.ts apps/frontend/src/settings/useSettingsTrigger.test.ts
git commit -m "feat(settings-popover): resolveTarget pure logic + tests"
```

---

## Task 2: Position calculation — pure `clampToViewport` + anchor placement

**Files:**
- Create: `apps/frontend/src/settings/position.ts`
- Create: `apps/frontend/src/settings/position.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/frontend/src/settings/position.test.ts
import { describe, expect, test } from "bun:test";
import { computePopoverPosition } from "./position";

const VIEWPORT = { width: 1000, height: 800 };
const POPOVER = { width: 240, height: 220 };

describe("computePopoverPosition", () => {
  test("places under bbox with 8px offset by default", () => {
    const pos = computePopoverPosition({
      anchor: { x: 100, y: 100, w: 200, h: 100 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    expect(pos).toEqual({ x: 100, y: 100 + 100 + 8 });
  });

  test("flips above bbox when not enough vertical space below", () => {
    const pos = computePopoverPosition({
      anchor: { x: 100, y: 600, w: 200, h: 100 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    // below = 600+100+8 + 220 = 928 > 800-16=784, so flip
    expect(pos.y).toBe(600 - 220 - 8);
  });

  test("clamps to right edge with margin", () => {
    const pos = computePopoverPosition({
      anchor: { x: 900, y: 100 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    expect(pos.x).toBeLessThanOrEqual(VIEWPORT.width - POPOVER.width - 16);
  });

  test("clamps to left edge with margin", () => {
    const pos = computePopoverPosition({
      anchor: { x: -50, y: 100 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    expect(pos.x).toBe(16);
  });

  test("board target — anchor at pointer with +12/+12 offset", () => {
    const pos = computePopoverPosition({
      anchor: { x: 200, y: 300 },        // point (no w/h) = board target
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    expect(pos).toEqual({ x: 200 + 12, y: 300 + 12 });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
bun test apps/frontend/src/settings/position.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `computePopoverPosition`**

```ts
// apps/frontend/src/settings/position.ts
import type { Anchor } from "./useSettingsTrigger";
type Size = { width: number; height: number };

export function computePopoverPosition(input: {
  anchor: Anchor;
  popoverSize: Size;
  viewport: Size;
  margin: number;
}): { x: number; y: number } {
  const { anchor, popoverSize, viewport, margin } = input;
  const isPoint = anchor.w === undefined || anchor.h === undefined;

  let x: number;
  let y: number;

  if (isPoint) {
    // Board target — pointer with +12 offset
    x = anchor.x + 12;
    y = anchor.y + 12;
  } else {
    // Shape/selection bbox — under bbox with +8 offset, flip if no space
    x = anchor.x;
    const below = anchor.y + (anchor.h ?? 0) + 8;
    if (below + popoverSize.height <= viewport.height - margin) {
      y = below;
    } else {
      y = anchor.y - popoverSize.height - 8;
    }
  }

  // Clamp to viewport with margin
  const maxX = viewport.width - popoverSize.width - margin;
  const maxY = viewport.height - popoverSize.height - margin;
  x = Math.max(margin, Math.min(x, maxX));
  y = Math.max(margin, Math.min(y, maxY));

  return { x, y };
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
bun test apps/frontend/src/settings/position.test.ts
```
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/position.ts apps/frontend/src/settings/position.test.ts
git commit -m "feat(settings-popover): position + clamp pure logic"
```

---

## Task 3: Spacing presets — pure mapping + reverse-mapping

**Files:**
- Create: `apps/frontend/src/settings/presets.ts`
- Create: `apps/frontend/src/settings/presets.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/frontend/src/settings/presets.test.ts
import { describe, expect, test } from "bun:test";
import { SPACING_PRESETS, applyPreset, reverseMapPreset } from "./presets";

describe("SPACING_PRESETS", () => {
  test("has Compact, Normal, Roomy", () => {
    expect(Object.keys(SPACING_PRESETS)).toEqual(["Compact", "Normal", "Roomy"]);
  });

  test("Normal matches DEFAULT_LAYOUT_PARAMS spacing fields", () => {
    expect(SPACING_PRESETS.Normal).toEqual({
      nodePadding: 16,
      containerPadding: 24,
      edgeSpacing: 16,
      edgeNodeSpacing: 20,
    });
  });
});

describe("applyPreset", () => {
  test("applies all 4 fields from preset, preserves other LayoutParams", () => {
    const base = {
      nodePadding: 999,
      defaultDirection: "LR" as const,
      autoDirectionEnabled: false,
    };
    const result = applyPreset(base, "Compact");
    expect(result).toMatchObject({
      nodePadding: 8,
      containerPadding: 16,
      edgeSpacing: 12,
      edgeNodeSpacing: 12,
      defaultDirection: "LR",
      autoDirectionEnabled: false,
    });
  });
});

describe("reverseMapPreset", () => {
  test("returns Normal when all 4 fields match", () => {
    expect(reverseMapPreset({
      nodePadding: 16,
      containerPadding: 24,
      edgeSpacing: 16,
      edgeNodeSpacing: 20,
    })).toBe("Normal");
  });

  test("returns Compact when all 4 fields match Compact", () => {
    expect(reverseMapPreset({
      nodePadding: 8,
      containerPadding: 16,
      edgeSpacing: 12,
      edgeNodeSpacing: 12,
    })).toBe("Compact");
  });

  test("returns null when any field deviates (custom)", () => {
    expect(reverseMapPreset({
      nodePadding: 16,
      containerPadding: 24,
      edgeSpacing: 16,
      edgeNodeSpacing: 21,        // +1 from Normal
    })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
bun test apps/frontend/src/settings/presets.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement presets module**

```ts
// apps/frontend/src/settings/presets.ts
import type { LayoutParams } from "@shemma/domain";

export type PresetName = "Compact" | "Normal" | "Roomy";

type PresetFields = Pick<
  LayoutParams,
  "nodePadding" | "containerPadding" | "edgeSpacing" | "edgeNodeSpacing"
>;

export const SPACING_PRESETS: Record<PresetName, PresetFields> = {
  Compact: { nodePadding: 8, containerPadding: 16, edgeSpacing: 12, edgeNodeSpacing: 12 },
  Normal:  { nodePadding: 16, containerPadding: 24, edgeSpacing: 16, edgeNodeSpacing: 20 },
  Roomy:   { nodePadding: 24, containerPadding: 32, edgeSpacing: 24, edgeNodeSpacing: 32 },
};

export function applyPreset(
  current: Partial<LayoutParams>,
  preset: PresetName,
): Partial<LayoutParams> {
  return { ...current, ...SPACING_PRESETS[preset] };
}

export function reverseMapPreset(params: PresetFields): PresetName | null {
  for (const [name, fields] of Object.entries(SPACING_PRESETS) as Array<[PresetName, PresetFields]>) {
    if (
      params.nodePadding === fields.nodePadding &&
      params.containerPadding === fields.containerPadding &&
      params.edgeSpacing === fields.edgeSpacing &&
      params.edgeNodeSpacing === fields.edgeNodeSpacing
    ) {
      return name;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
bun test apps/frontend/src/settings/presets.test.ts
```
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/presets.ts apps/frontend/src/settings/presets.test.ts
git commit -m "feat(settings-popover): spacing presets + reverse-mapping"
```

---

## Task 4: API client — `getLayoutParams` + `postLayoutParams` + `postLayoutSelection`

**Files:**
- Create: `apps/frontend/src/settings/api.ts`
- Create: `apps/frontend/src/settings/api.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/frontend/src/settings/api.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getLayoutParams, postLayoutParams, postLayoutSelection } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getLayoutParams", () => {
  test("calls GET /api/board/layout-params with space + room query", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ raw: null, effective: { nodePadding: 16 } }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getLayoutParams("default", "drw-test");
    expect(fetchMock).toHaveBeenCalled();
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/board/layout-params");
    expect(url).toContain("space=default");
    expect(url).toContain("room=drw-test");
    expect(result.raw).toBeNull();
    expect(result.effective.nodePadding).toBe(16);
  });

  test("throws on non-2xx response", async () => {
    globalThis.fetch = mock(async () => new Response("server down", { status: 500 })) as unknown as typeof fetch;
    await expect(getLayoutParams("s", "r")).rejects.toThrow();
  });
});

describe("postLayoutParams", () => {
  test("posts JSON body with params + space + room", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ ok: true, effective: { nodePadding: 8 } }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await postLayoutParams("default", "drw-test", { nodePadding: 8 });
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("/api/board/layout-params");
    expect(call?.[1]?.method).toBe("POST");
    expect(JSON.parse((call?.[1]?.body as string) ?? "{}")).toEqual({
      space: "default", room: "drw-test", params: { nodePadding: 8 },
    });
    expect(result.effective.nodePadding).toBe(8);
  });
});

describe("postLayoutSelection", () => {
  test("forwards forceUnpin flag in body", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await postLayoutSelection("default", "drw-test", { ids: ["s:a"], forceUnpin: true });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1]?.body as string) ?? "{}");
    expect(body.forceUnpin).toBe(true);
    expect(body.ids).toEqual(["s:a"]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
bun test apps/frontend/src/settings/api.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement api.ts**

```ts
// apps/frontend/src/settings/api.ts
import type { LayoutParams } from "@shemma/domain";

export type LayoutParamsResponse = {
  raw: Partial<LayoutParams> | null;
  effective: LayoutParams;
};

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function getLayoutParams(space: string, room: string): Promise<LayoutParamsResponse> {
  const url = `/api/board/layout-params?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, { method: "GET" });
  return jsonOrThrow(res);
}

export async function postLayoutParams(
  space: string,
  room: string,
  params: Partial<LayoutParams> | null,
): Promise<{ ok: true; effective: LayoutParams }> {
  const res = await fetch("/api/board/layout-params", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ space, room, params }),
  });
  return jsonOrThrow(res);
}

export type LayoutSelectionInput = {
  ids: string[];
  direction?: "TB" | "BT" | "LR" | "RL" | "custom";
  forceUnpin?: boolean;
};

export async function postLayoutSelection(
  space: string,
  room: string,
  input: LayoutSelectionInput,
): Promise<{ ok: true }> {
  const url = `/api/agent/layout-selection?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
bun test apps/frontend/src/settings/api.test.ts
```
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/api.ts apps/frontend/src/settings/api.test.ts
git commit -m "feat(settings-popover): api wrappers + tests"
```

---

## Task 5: Backend — `GET /api/board/layout-params`

**Files:**
- Create: `apps/backend/src/routes/board-layout-params.ts`
- Create: `apps/backend/tests/routes-board-layout-params.test.ts`
- Modify: backend route registration (locate central index where routes are mounted)

- [ ] **Step 1: Find route registration entry point**

```bash
grep -rn "routes/schema\|routes/layout-selection" apps/backend/src/index.ts apps/backend/src/server.ts 2>/dev/null | head -5
```

Expected: один-два места, где `app.route(...)` или подобный mount происходит. Зафиксировать путь — он понадобится в Step 4.

- [ ] **Step 2: Write failing test for GET**

```ts
// apps/backend/tests/routes-board-layout-params.test.ts
import { describe, expect, test } from "bun:test";
import { boardLayoutParamsRoutes } from "../src/routes/board-layout-params";
import { Hono } from "hono";

function buildApp() {
  const app = new Hono();
  // In-memory room mock — to be wired in implementation step
  const rooms = new Map<string, { meta?: Record<string, unknown> }>();
  rooms.set("default::r1", { meta: { layoutParams: { nodePadding: 8 } } });
  rooms.set("default::r2", { meta: {} });

  app.route("/api/board/layout-params", boardLayoutParamsRoutes({
    getRoom: (space, room) => rooms.get(`${space}::${room}`),
    persistRoom: () => {},
    broadcastRoomMeta: () => {},
  }));
  return app;
}

describe("GET /api/board/layout-params", () => {
  test("returns raw + effective when params present", async () => {
    const app = buildApp();
    const res = await app.request("/api/board/layout-params?space=default&room=r1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.raw).toEqual({ nodePadding: 8 });
    expect(json.effective.nodePadding).toBe(8);
    expect(json.effective.containerPadding).toBe(24); // from DEFAULT_LAYOUT_PARAMS
  });

  test("returns raw=null + full defaults when no params set", async () => {
    const app = buildApp();
    const res = await app.request("/api/board/layout-params?space=default&room=r2");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.raw).toBeNull();
    expect(json.effective.nodePadding).toBe(16); // DEFAULT
  });

  test("400 if space or room missing", async () => {
    const app = buildApp();
    const res = await app.request("/api/board/layout-params?space=default");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run test to verify failure**

```bash
bun test apps/backend/tests/routes-board-layout-params.test.ts
```
Expected: FAIL — `boardLayoutParamsRoutes` is not defined.

- [ ] **Step 4: Implement GET endpoint**

```ts
// apps/backend/src/routes/board-layout-params.ts
import { Hono } from "hono";
import { applyLayoutParamsDefaults, type LayoutParams } from "@shemma/domain";

export type BoardLayoutParamsDeps = {
  getRoom: (space: string, room: string) => { meta?: Record<string, unknown> } | undefined;
  persistRoom: (space: string, room: string) => void;
  broadcastRoomMeta: (space: string, room: string) => void;
};

export function boardLayoutParamsRoutes(deps: BoardLayoutParamsDeps) {
  const app = new Hono();

  app.get("/", (c) => {
    const space = c.req.query("space");
    const room = c.req.query("room");
    if (!space || !room) return c.json({ error: "space and room required" }, 400);

    const r = deps.getRoom(space, room);
    const raw = (r?.meta?.layoutParams as Partial<LayoutParams> | undefined) ?? null;
    const effective = applyLayoutParamsDefaults(raw ?? {});
    return c.json({ raw, effective });
  });

  return app;
}
```

- [ ] **Step 5: Run test to verify pass**

```bash
bun test apps/backend/tests/routes-board-layout-params.test.ts
```
Expected: 3 tests PASS.

- [ ] **Step 6: Mount route in app**

Edit the route registration entry point (located in Step 1) — add line:

```ts
import { boardLayoutParamsRoutes } from "./routes/board-layout-params";
// ...
app.route("/api/board/layout-params", boardLayoutParamsRoutes({
  getRoom: /* same getRoom helper as other routes */,
  persistRoom: /* same persistRoom */,
  broadcastRoomMeta: /* room-meta broadcast helper */,
}));
```

If `broadcastRoomMeta` helper doesn't exist yet — Task 6 creates it; for now stub: `() => {}`.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/routes/board-layout-params.ts apps/backend/tests/routes-board-layout-params.test.ts apps/backend/src/<route-entry>
git commit -m "feat(settings-popover): GET /api/board/layout-params"
```

---

## Task 6: Backend — `POST /api/board/layout-params` + validation + broadcast

**Files:**
- Modify: `apps/backend/src/routes/board-layout-params.ts`
- Modify: `apps/backend/tests/routes-board-layout-params.test.ts` (add POST tests)

- [ ] **Step 1: Add POST tests**

Append to `routes-board-layout-params.test.ts`:

```ts
describe("POST /api/board/layout-params", () => {
  test("persists params, returns effective merged with defaults", async () => {
    const app = buildApp();
    const res = await app.request("/api/board/layout-params", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space: "default", room: "r2", params: { edgeSpacing: 24 } }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.effective.edgeSpacing).toBe(24);
    expect(json.effective.nodePadding).toBe(16);
  });

  test("params=null clears overrides", async () => {
    const app = buildApp();
    const res = await app.request("/api/board/layout-params", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space: "default", room: "r1", params: null }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.effective.nodePadding).toBe(16); // back to default
  });

  test("400 on invalid LayoutParams (negative number)", async () => {
    const app = buildApp();
    const res = await app.request("/api/board/layout-params", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space: "default", room: "r1", params: { nodePadding: -5 } }),
    });
    expect(res.status).toBe(400);
  });

  test("invokes persistRoom + broadcastRoomMeta on success", async () => {
    let persisted = "";
    let broadcasted = "";
    const rooms = new Map<string, { meta?: Record<string, unknown> }>();
    rooms.set("default::r1", { meta: {} });
    const app = new Hono();
    app.route("/api/board/layout-params", boardLayoutParamsRoutes({
      getRoom: (s, r) => rooms.get(`${s}::${r}`),
      persistRoom: (s, r) => { persisted = `${s}::${r}`; },
      broadcastRoomMeta: (s, r) => { broadcasted = `${s}::${r}`; },
    }));
    await app.request("/api/board/layout-params", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space: "default", room: "r1", params: { edgeSpacing: 12 } }),
    });
    expect(persisted).toBe("default::r1");
    expect(broadcasted).toBe("default::r1");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
bun test apps/backend/tests/routes-board-layout-params.test.ts
```
Expected: 4 new tests FAIL — POST handler not implemented.

- [ ] **Step 3: Implement POST handler**

Append to `apps/backend/src/routes/board-layout-params.ts` inside `boardLayoutParamsRoutes`:

```ts
import { validateLayoutParams, applyLayoutParamsDefaults, type LayoutParams } from "@shemma/domain";

// ... within boardLayoutParamsRoutes after app.get(...):

app.post("/", async (c) => {
  const body = await c.req.json<{
    space?: string; room?: string; params?: Partial<LayoutParams> | null;
  }>().catch(() => ({}));
  const { space, room, params } = body;
  if (!space || !room) return c.json({ error: "space and room required" }, 400);

  if (params !== null && params !== undefined) {
    try {
      validateLayoutParams(params);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  const r = deps.getRoom(space, room);
  if (!r) return c.json({ error: "room not found" }, 404);

  if (!r.meta) r.meta = {};
  if (params === null) {
    delete (r.meta as Record<string, unknown>).layoutParams;
  } else {
    (r.meta as Record<string, unknown>).layoutParams = params;
  }

  deps.persistRoom(space, room);
  deps.broadcastRoomMeta(space, room);

  const effective = applyLayoutParamsDefaults(params ?? {});
  return c.json({ ok: true, effective });
});
```

- [ ] **Step 4: Run tests to verify pass**

```bash
bun test apps/backend/tests/routes-board-layout-params.test.ts
```
Expected: all 7 tests PASS.

- [ ] **Step 5: Wire actual `persistRoom` + `broadcastRoomMeta` helpers**

В месте mount route (Task 5 Step 6) заменить stub'ы на реальные helper'ы. Если `broadcastRoomMeta` ещё не существует — добавить минимальную реализацию рядом с другими WS-broadcast helper'ами (искать в `apps/backend/src/transport/ws.ts` функции типа `broadcastStoreChange`, `broadcastRoomState`; копировать аналогичный pattern). Реализация: отправить WS message типа `room-meta-updated` всем подписчикам room.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/board-layout-params.ts apps/backend/tests/routes-board-layout-params.test.ts apps/backend/src/<route-entry> apps/backend/src/transport/ws.ts
git commit -m "feat(settings-popover): POST /api/board/layout-params + broadcast"
```

---

## Task 7: Backend — `forceUnpin` on `POST /api/agent/layout-selection`

**Files:**
- Modify: `apps/backend/src/routes/layout-selection.ts`
- Modify: `apps/backend/src/domain/layout.ts` (`runLayout(...)` accepts `forceUnpin`)
- Create: `apps/backend/tests/routes-layout-selection-force-unpin.test.ts`

- [ ] **Step 1: Inspect existing layout-selection route**

```bash
grep -n "forceUnpin\|meta\.pinned\|didrawSizePinned" apps/backend/src/routes/layout-selection.ts apps/backend/src/domain/layout.ts | head -20
```

Expected: `meta.pinned` references exist; `forceUnpin` does not. Note line numbers — they'll guide Step 3.

- [ ] **Step 2: Write failing test**

```ts
// apps/backend/tests/routes-layout-selection-force-unpin.test.ts
import { describe, expect, test } from "bun:test";
import { runLayout } from "../src/domain/layout";

// Build minimal fixture: 2 shapes, one with meta.pinned, one with meta.didrawSizePinned
function fixture() {
  return {
    shapes: [
      { id: "s:a", type: "geo", x: 0, y: 0, props: { w: 100, h: 50 }, meta: { didrawId: "a", pinned: true } },
      { id: "s:b", type: "geo", x: 200, y: 0, props: { w: 100, h: 50 }, meta: { didrawId: "b", didrawSizePinned: true } },
    ],
    bindings: [],
  };
}

describe("runLayout forceUnpin", () => {
  test("default — pinned shapes keep position/size", () => {
    const result = runLayout(fixture() as any, { ids: ["s:a", "s:b"] });
    const a = result.shapes.find((s: any) => s.id === "s:a");
    const b = result.shapes.find((s: any) => s.id === "s:b");
    expect(a.x).toBe(0); expect(a.y).toBe(0);                  // pinned position
    expect(b.props.w).toBe(100); expect(b.props.h).toBe(50);   // pinned size
  });

  test("forceUnpin=true — pinned position/size overridden once", () => {
    const result = runLayout(fixture() as any, { ids: ["s:a", "s:b"], forceUnpin: true });
    const a = result.shapes.find((s: any) => s.id === "s:a");
    // pinned position не сохранён — layout пишет новые координаты
    expect(a.x === 0 && a.y === 0).toBe(false);
    // meta.pinned flag сохранён
    expect(a.meta.pinned).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify failure**

```bash
bun test apps/backend/tests/routes-layout-selection-force-unpin.test.ts
```
Expected: FAIL — `forceUnpin` option ignored OR test misalignment with actual `runLayout` signature; if signature mismatch, adapt fixture to match what runLayout exports.

- [ ] **Step 4: Implement `forceUnpin` option in `runLayout`**

Find the place in `apps/backend/src/domain/layout.ts` where pinned shapes are filtered/preserved (typical pattern: `if (shape.meta?.pinned) skip layout for this shape`). Wrap the pin-respect logic:

```ts
// apps/backend/src/domain/layout.ts (sketch — adapt to actual function signature)
export type RunLayoutOptions = {
  ids?: string[];
  // ... existing options
  forceUnpin?: boolean;
};

export function runLayout(input: LayoutInput, opts: RunLayoutOptions = {}) {
  const { forceUnpin = false } = opts;

  function isPositionPinned(shape: ShapeLike): boolean {
    if (forceUnpin) return false;
    return shape.meta?.pinned === true;
  }
  function isSizePinned(shape: ShapeLike): boolean {
    if (forceUnpin) return false;
    return shape.meta?.didrawSizePinned === true;
  }

  // ... existing code now uses isPositionPinned() / isSizePinned() instead of direct meta.* checks
}
```

Note: реальный shape signature и parsing existing logic — adapter step. Implementer субагент уточняет конкретные имена/функции при чтении layout.ts.

- [ ] **Step 5: Forward `forceUnpin` in route handler**

In `apps/backend/src/routes/layout-selection.ts`, find where request body is parsed and `runLayout` is called. Add `forceUnpin` pass-through:

```ts
// e.g.:
const body = await c.req.json<{ ids?: string[]; direction?: Direction; forceUnpin?: boolean; }>();
// ...
const result = runLayout(canvasState, { ids: body.ids, direction: body.direction, forceUnpin: body.forceUnpin });
```

- [ ] **Step 6: Run tests to verify pass**

```bash
bun test apps/backend/tests/routes-layout-selection-force-unpin.test.ts
bun test apps/backend/tests/routes-layout-selection.test.ts   # regression
```
Expected: new tests PASS, existing pass.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/routes/layout-selection.ts apps/backend/src/domain/layout.ts apps/backend/tests/routes-layout-selection-force-unpin.test.ts
git commit -m "feat(settings-popover): forceUnpin on layout-selection"
```

---

## Task 8: Backend — `runLayout` reads `roomMeta.layoutParams`

**Files:**
- Modify: `apps/backend/src/routes/schema.ts` (все call-sites runLayout)
- Modify: `apps/backend/src/domain/layout.ts` (extend signature если нужно)
- Modify: `apps/backend/tests/routes-board-layout-params.test.ts` (add integration test)

- [ ] **Step 1: Locate all runLayout call-sites**

```bash
grep -n "runLayout(" apps/backend/src/routes/schema.ts apps/backend/src/routes/layout-selection.ts
```
Expected: ~3-5 call-sites. Записать line numbers.

- [ ] **Step 2: Write failing test**

Append to `apps/backend/tests/routes-board-layout-params.test.ts`:

```ts
import { runLayout } from "../src/domain/layout";

describe("runLayout reads roomMeta.layoutParams", () => {
  test("applies roomMeta override to nodePadding", () => {
    const input = {
      shapes: [/* 2 nodes + 1 edge */],
      bindings: [],
      roomMeta: { layoutParams: { nodePadding: 999 } },
    };
    const result = runLayout(input as any, {});
    // нагенерён layout с inflated padding → проверим что какие-то coords > naive default
    expect(result.appliedParams.nodePadding).toBe(999);
  });
});
```

(Если у `runLayout` ещё нет `appliedParams` в return — добавить как side-data в результат для observability в тестах.)

- [ ] **Step 3: Run test to verify failure**

```bash
bun test apps/backend/tests/routes-board-layout-params.test.ts
```
Expected: FAIL — `roomMeta.layoutParams` not yet read.

- [ ] **Step 4: Modify `runLayout` to accept and apply `roomMeta.layoutParams`**

Add to `apps/backend/src/domain/layout.ts`:

```ts
import { applyLayoutParamsDefaults, type LayoutParams } from "@shemma/domain";

export type LayoutInput = {
  shapes: ShapeLike[];
  bindings: BindingLike[];
  roomMeta?: { layoutParams?: Partial<LayoutParams> };
};

export function runLayout(input: LayoutInput, opts: RunLayoutOptions = {}) {
  const params = applyLayoutParamsDefaults(input.roomMeta?.layoutParams ?? {});
  // существующая логика далее использует params.* вместо хардкодных чисел
  // (большинство мест уже DRW-178 Phase 3 это сделало — теперь params приходят от пользователя)

  // ... existing code

  return {
    shapes: /* ... */,
    bindings: /* ... */,
    appliedParams: params,   // for observability + tests
  };
}
```

- [ ] **Step 5: Update all call-sites in `apps/backend/src/routes/schema.ts`**

Каждый `runLayout(state, opts)` call → `runLayout({ ...state, roomMeta: room.meta }, opts)`. Если `state` уже содержит roomMeta — просто проверить что прокидывается. Если нет — добавить параметр.

- [ ] **Step 6: Run all backend tests**

```bash
bun test apps/backend
```
Expected: All ~1012 tests PASS (новый PASS + no regressions).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/domain/layout.ts apps/backend/src/routes/schema.ts apps/backend/tests/routes-board-layout-params.test.ts
git commit -m "feat(settings-popover): runLayout reads roomMeta.layoutParams"
```

---

## Task 9: DirectionSection component

**Files:**
- Create: `apps/frontend/src/settings/sections/DirectionSection.tsx`
- Create: `apps/frontend/src/settings/sections/sections.test.ts` (shared pure-logic tests)

- [ ] **Step 1: Write failing test (pure helper)**

```ts
// apps/frontend/src/settings/sections/sections.test.ts
import { describe, expect, test } from "bun:test";
import { DIRECTION_OPTIONS, type DirectionValue } from "./DirectionSection";

describe("DIRECTION_OPTIONS", () => {
  test("contains TB / LR / BT / RL / custom in that order", () => {
    expect(DIRECTION_OPTIONS.map((o) => o.value)).toEqual(["TB", "LR", "BT", "RL", "custom"]);
  });

  test("each option has a label", () => {
    expect(DIRECTION_OPTIONS.every((o) => typeof o.label === "string" && o.label.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
bun test apps/frontend/src/settings/sections/sections.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DirectionSection**

```tsx
// apps/frontend/src/settings/sections/DirectionSection.tsx
import type { FC } from "react";

export type DirectionValue = "TB" | "LR" | "BT" | "RL" | "custom";

export const DIRECTION_OPTIONS: ReadonlyArray<{ value: DirectionValue; label: string }> = [
  { value: "TB", label: "TB" },
  { value: "LR", label: "LR" },
  { value: "BT", label: "BT" },
  { value: "RL", label: "RL" },
  { value: "custom", label: "Custom" },
];

export type DirectionSectionProps = {
  current: DirectionValue | null;
  onChange: (next: DirectionValue) => void;
  disabled?: boolean;
};

export const DirectionSection: FC<DirectionSectionProps> = ({ current, onChange, disabled }) => {
  return (
    <div className="settings-section settings-section--direction" role="radiogroup" aria-label="Direction">
      <div className="settings-section__label">Direction</div>
      <div className="settings-section__row">
        {DIRECTION_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={current === o.value}
            disabled={disabled}
            data-direction={o.value}
            onClick={() => onChange(o.value)}
            className={`settings-btn${current === o.value ? " settings-btn--on" : ""}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
};
```

- [ ] **Step 4: Run test to verify pass**

```bash
bun test apps/frontend/src/settings/sections/sections.test.ts
```
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/sections/DirectionSection.tsx apps/frontend/src/settings/sections/sections.test.ts
git commit -m "feat(settings-popover): DirectionSection component"
```

---

## Task 10: LayoutSection component

**Files:**
- Create: `apps/frontend/src/settings/sections/LayoutSection.tsx`
- Modify: `apps/frontend/src/settings/sections/sections.test.ts`

- [ ] **Step 1: Add failing test**

Append to `sections.test.ts`:

```ts
import { LAYOUT_ACTIONS } from "./LayoutSection";

describe("LAYOUT_ACTIONS", () => {
  test("exposes tidy + force-unpin with shortcuts", () => {
    expect(LAYOUT_ACTIONS.map((a) => a.id)).toEqual(["tidy", "force-unpin"]);
    expect(LAYOUT_ACTIONS.find((a) => a.id === "tidy")?.shortcut).toBe("⌘⇧L");
    expect(LAYOUT_ACTIONS.find((a) => a.id === "force-unpin")?.shortcut).toBe("⌘⇧⌥L");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
bun test apps/frontend/src/settings/sections/sections.test.ts
```
Expected: new test FAIL — module not found.

- [ ] **Step 3: Implement LayoutSection**

```tsx
// apps/frontend/src/settings/sections/LayoutSection.tsx
import type { FC } from "react";

export type LayoutAction = { id: "tidy" | "force-unpin"; label: string; shortcut: string };

export const LAYOUT_ACTIONS: ReadonlyArray<LayoutAction> = [
  { id: "tidy", label: "Tidy", shortcut: "⌘⇧L" },
  { id: "force-unpin", label: "Force re-layout", shortcut: "⌘⇧⌥L" },
];

export type LayoutSectionProps = {
  onAction: (id: LayoutAction["id"]) => void;
  disabled?: boolean;
  pending?: LayoutAction["id"] | null;
};

export const LayoutSection: FC<LayoutSectionProps> = ({ onAction, disabled, pending }) => (
  <div className="settings-section settings-section--layout">
    <div className="settings-section__label">Layout</div>
    <div className="settings-section__row settings-section__row--stacked">
      {LAYOUT_ACTIONS.map((a) => (
        <button
          key={a.id}
          type="button"
          disabled={disabled || pending !== null}
          onClick={() => onAction(a.id)}
          className="settings-btn"
        >
          <span className="settings-btn__label">{a.label}</span>
          <kbd className="settings-btn__kbd">{a.shortcut}</kbd>
          {pending === a.id && <span className="settings-btn__spinner" aria-label="Saving">…</span>}
        </button>
      ))}
    </div>
  </div>
);
```

- [ ] **Step 4: Run test to verify pass**

```bash
bun test apps/frontend/src/settings/sections/sections.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/sections/LayoutSection.tsx apps/frontend/src/settings/sections/sections.test.ts
git commit -m "feat(settings-popover): LayoutSection component"
```

---

## Task 11: PinSection component

**Files:**
- Create: `apps/frontend/src/settings/sections/PinSection.tsx`
- Modify: `apps/frontend/src/settings/sections/sections.test.ts`

- [ ] **Step 1: Add failing test**

Append to `sections.test.ts`:

```ts
import { PIN_FIELDS } from "./PinSection";

describe("PIN_FIELDS", () => {
  test("has size + position", () => {
    expect(PIN_FIELDS.map((f) => f.field)).toEqual(["size", "position"]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
bun test apps/frontend/src/settings/sections/sections.test.ts
```
Expected: new test FAIL.

- [ ] **Step 3: Implement PinSection**

```tsx
// apps/frontend/src/settings/sections/PinSection.tsx
import type { FC } from "react";

export type PinField = { field: "size" | "position"; label: string };

export const PIN_FIELDS: ReadonlyArray<PinField> = [
  { field: "size", label: "size" },
  { field: "position", label: "position" },
];

export type PinSectionProps = {
  values: { size: boolean; position: boolean };
  onToggle: (field: PinField["field"]) => void;
  bulkLabel?: boolean;        // true → prefix "all "
};

export const PinSection: FC<PinSectionProps> = ({ values, onToggle, bulkLabel }) => (
  <div className="settings-section settings-section--pin">
    <div className="settings-section__label">Size &amp; Position</div>
    <div className="settings-section__row">
      {PIN_FIELDS.map((f) => (
        <button
          key={f.field}
          type="button"
          role="switch"
          aria-checked={values[f.field]}
          onClick={() => onToggle(f.field)}
          className={`settings-btn${values[f.field] ? " settings-btn--on" : ""}`}
        >
          📌 {bulkLabel ? "all " : ""}{f.label}
        </button>
      ))}
    </div>
  </div>
);
```

- [ ] **Step 4: Run test to verify pass**

```bash
bun test apps/frontend/src/settings/sections/sections.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/sections/PinSection.tsx apps/frontend/src/settings/sections/sections.test.ts
git commit -m "feat(settings-popover): PinSection component"
```

---

## Task 12: RoleSection component (thin reuse of existing role-picker)

**Files:**
- Create: `apps/frontend/src/settings/sections/RoleSection.tsx`

This section just exposes the existing role-picker as an inline drawer. No new logic; one trivial test.

- [ ] **Step 1: Inspect existing role-picker exports**

```bash
grep -n "export " apps/frontend/src/canvas/role-picker.ts apps/frontend/src/canvas/role-picker.tsx | head -20
```

Identify the helper for applying role (likely `applyRoleToShape` or similar). Note its signature.

- [ ] **Step 2: Add failing test**

Append to `sections.test.ts`:

```ts
import { RoleSection } from "./RoleSection";

describe("RoleSection", () => {
  test("exports a component", () => {
    expect(typeof RoleSection).toBe("function");
  });
});
```

- [ ] **Step 3: Run test to verify failure**

```bash
bun test apps/frontend/src/settings/sections/sections.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement RoleSection**

```tsx
// apps/frontend/src/settings/sections/RoleSection.tsx
import type { FC } from "react";
import { ALL_ROLES, type Role } from "@shemma/domain";

export type RoleSectionProps = {
  current: Role | null;
  onSelect: (role: Role) => void;
};

export const RoleSection: FC<RoleSectionProps> = ({ current, onSelect }) => (
  <div className="settings-section settings-section--role">
    <div className="settings-section__label">Role</div>
    <div className="settings-section__row settings-section__row--wrap">
      {ALL_ROLES.map((role) => (
        <button
          key={role}
          type="button"
          aria-pressed={current === role}
          onClick={() => onSelect(role)}
          className={`settings-btn${current === role ? " settings-btn--on" : ""}`}
        >
          {role}
        </button>
      ))}
    </div>
  </div>
);
```

(If `ALL_ROLES` не экспортируется из `@shemma/domain` — find it via grep, использовать тот же source как `role-picker.tsx`.)

- [ ] **Step 5: Run test to verify pass**

```bash
bun test apps/frontend/src/settings/sections/sections.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/settings/sections/RoleSection.tsx apps/frontend/src/settings/sections/sections.test.ts
git commit -m "feat(settings-popover): RoleSection component"
```

---

## Task 13: StylesSection (stub)

**Files:**
- Create: `apps/frontend/src/settings/sections/StylesSection.tsx`

- [ ] **Step 1: Add failing test**

Append to `sections.test.ts`:

```ts
import { StylesSection } from "./StylesSection";

describe("StylesSection", () => {
  test("exports a component", () => {
    expect(typeof StylesSection).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
bun test apps/frontend/src/settings/sections/sections.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement stub**

```tsx
// apps/frontend/src/settings/sections/StylesSection.tsx
import type { FC } from "react";

export const StylesSection: FC = () => (
  <div className="settings-section settings-section--styles">
    <div className="settings-section__label">Styles</div>
    <div className="settings-section__hint">Style defaults — coming soon</div>
  </div>
);
```

- [ ] **Step 4: Run test to verify pass**

```bash
bun test apps/frontend/src/settings/sections/sections.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/sections/StylesSection.tsx apps/frontend/src/settings/sections/sections.test.ts
git commit -m "feat(settings-popover): StylesSection stub"
```

---

## Task 14: SelectionPanel composition

**Files:**
- Create: `apps/frontend/src/settings/panels/SelectionPanel.tsx`
- Create: `apps/frontend/src/settings/panels/panels.test.ts`

- [ ] **Step 1: Write failing test for pure helper**

```ts
// apps/frontend/src/settings/panels/panels.test.ts
import { describe, expect, test } from "bun:test";
import { selectionFooterCounter, selectionHasContainer } from "./SelectionPanel";

describe("selectionFooterCounter", () => {
  test("1 container only", () => {
    expect(selectionFooterCounter({ containers: 1, nodes: 0 })).toBe("1 container");
  });
  test("2 containers + 5 nodes", () => {
    expect(selectionFooterCounter({ containers: 2, nodes: 5 })).toBe("2 containers, 5 nodes");
  });
  test("7 nodes only", () => {
    expect(selectionFooterCounter({ containers: 0, nodes: 7 })).toBe("7 shapes");
  });
});

describe("selectionHasContainer", () => {
  test("true when containers > 0", () => {
    expect(selectionHasContainer({ containers: 1, nodes: 0 })).toBe(true);
  });
  test("false when containers == 0", () => {
    expect(selectionHasContainer({ containers: 0, nodes: 5 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
bun test apps/frontend/src/settings/panels/panels.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement SelectionPanel**

```tsx
// apps/frontend/src/settings/panels/SelectionPanel.tsx
import type { FC } from "react";
import { DirectionSection, type DirectionValue } from "../sections/DirectionSection";
import { LayoutSection, type LayoutAction } from "../sections/LayoutSection";
import { PinSection } from "../sections/PinSection";

export type SelectionCounts = { containers: number; nodes: number };

export function selectionFooterCounter(c: SelectionCounts): string {
  const total = c.containers + c.nodes;
  if (c.containers > 0 && c.nodes > 0) {
    return `${c.containers} container${c.containers > 1 ? "s" : ""}, ${c.nodes} node${c.nodes > 1 ? "s" : ""}`;
  }
  if (c.containers > 0) {
    return `${c.containers} container${c.containers > 1 ? "s" : ""}`;
  }
  return `${total} shape${total > 1 ? "s" : ""}`;
}

export function selectionHasContainer(c: SelectionCounts): boolean {
  return c.containers > 0;
}

export type SelectionPanelProps = {
  counts: SelectionCounts;
  direction: DirectionValue | null;
  onDirectionChange: (d: DirectionValue) => void;
  onLayoutAction: (id: LayoutAction["id"]) => void;
  pinValues: { size: boolean; position: boolean };
  onPinToggle: (field: "size" | "position") => void;
  pending: LayoutAction["id"] | null;
};

export const SelectionPanel: FC<SelectionPanelProps> = ({
  counts, direction, onDirectionChange, onLayoutAction, pinValues, onPinToggle, pending,
}) => {
  const total = counts.containers + counts.nodes;
  return (
    <div className="settings-popover__panel" role="dialog" aria-label="Selection settings">
      {selectionHasContainer(counts) && (
        <DirectionSection current={direction} onChange={onDirectionChange} />
      )}
      <LayoutSection onAction={onLayoutAction} pending={pending} />
      <PinSection values={pinValues} onToggle={onPinToggle} bulkLabel={total > 1} />
      <div className="settings-popover__footer">{selectionFooterCounter(counts)}</div>
    </div>
  );
};
```

- [ ] **Step 4: Run test to verify pass**

```bash
bun test apps/frontend/src/settings/panels/panels.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/panels/SelectionPanel.tsx apps/frontend/src/settings/panels/panels.test.ts
git commit -m "feat(settings-popover): SelectionPanel composition"
```

---

## Task 15: NodePanel composition

**Files:**
- Create: `apps/frontend/src/settings/panels/NodePanel.tsx`

- [ ] **Step 1: Add failing test**

Append to `panels.test.ts`:

```ts
import { NodePanel } from "./NodePanel";

describe("NodePanel", () => {
  test("exports a component", () => {
    expect(typeof NodePanel).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
bun test apps/frontend/src/settings/panels/panels.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement NodePanel**

```tsx
// apps/frontend/src/settings/panels/NodePanel.tsx
import type { FC } from "react";
import { PinSection } from "../sections/PinSection";
import { RoleSection } from "../sections/RoleSection";
import type { Role } from "@shemma/domain";

export type NodePanelProps = {
  pinValues: { size: boolean; position: boolean };
  onPinToggle: (field: "size" | "position") => void;
  role: Role | null;
  onRoleSelect: (role: Role) => void;
};

export const NodePanel: FC<NodePanelProps> = ({ pinValues, onPinToggle, role, onRoleSelect }) => (
  <div className="settings-popover__panel" role="dialog" aria-label="Node settings">
    <PinSection values={pinValues} onToggle={onPinToggle} />
    <RoleSection current={role} onSelect={onRoleSelect} />
  </div>
);
```

- [ ] **Step 4: Run test to verify pass**

```bash
bun test apps/frontend/src/settings/panels/panels.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/panels/NodePanel.tsx apps/frontend/src/settings/panels/panels.test.ts
git commit -m "feat(settings-popover): NodePanel composition"
```

---

## Task 16: BoardPanel main view (presets + direction + advanced link)

**Files:**
- Create: `apps/frontend/src/settings/panels/BoardPanel.tsx`

- [ ] **Step 1: Add failing test**

Append to `panels.test.ts`:

```ts
import { BoardPanel } from "./BoardPanel";

describe("BoardPanel", () => {
  test("exports a component", () => {
    expect(typeof BoardPanel).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
bun test apps/frontend/src/settings/panels/panels.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement BoardPanel**

```tsx
// apps/frontend/src/settings/panels/BoardPanel.tsx
import type { FC } from "react";
import { DirectionSection, type DirectionValue } from "../sections/DirectionSection";
import { StylesSection } from "../sections/StylesSection";
import { SPACING_PRESETS, reverseMapPreset, type PresetName } from "../presets";
import type { LayoutParams } from "@shemma/domain";

export type BoardPanelProps = {
  effective: LayoutParams;
  onDirectionChange: (d: DirectionValue) => void;
  onPresetSelect: (preset: PresetName) => void;
  onToggleAutoDirection: (enabled: boolean) => void;
  onMidpointModeChange: (mode: "even" | "fixed-0.5") => void;
  onOpenAdvanced: () => void;
};

export const BoardPanel: FC<BoardPanelProps> = ({
  effective, onDirectionChange, onPresetSelect, onToggleAutoDirection, onMidpointModeChange, onOpenAdvanced,
}) => {
  const currentPreset = reverseMapPreset({
    nodePadding: effective.nodePadding,
    containerPadding: effective.containerPadding,
    edgeSpacing: effective.edgeSpacing,
    edgeNodeSpacing: effective.edgeNodeSpacing,
  });

  return (
    <div className="settings-popover__panel" role="dialog" aria-label="Board layout">
      <DirectionSection current={effective.defaultDirection} onChange={onDirectionChange} />
      <div className="settings-section settings-section--layout">
        <div className="settings-section__label">Layout</div>
        <div className="settings-section__row" role="radiogroup" aria-label="Spacing preset">
          {(Object.keys(SPACING_PRESETS) as PresetName[]).map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={currentPreset === name}
              onClick={() => onPresetSelect(name)}
              className={`settings-btn${currentPreset === name ? " settings-btn--on" : ""}`}
            >
              {name}
            </button>
          ))}
          {currentPreset === null && <span className="settings-section__hint">Custom</span>}
        </div>
        <div className="settings-section__row">
          <button
            type="button"
            role="switch"
            aria-checked={effective.autoDirectionEnabled}
            onClick={() => onToggleAutoDirection(!effective.autoDirectionEnabled)}
            className={`settings-btn${effective.autoDirectionEnabled ? " settings-btn--on" : ""}`}
          >
            Auto-direction: {effective.autoDirectionEnabled ? "on" : "off"}
          </button>
        </div>
        <div className="settings-section__row" role="radiogroup" aria-label="Midpoint mode">
          {(["even", "fixed-0.5"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={effective.midpointDistribution === mode}
              onClick={() => onMidpointModeChange(mode)}
              className={`settings-btn${effective.midpointDistribution === mode ? " settings-btn--on" : ""}`}
            >
              {mode === "fixed-0.5" ? "center" : "even"}
            </button>
          ))}
        </div>
      </div>
      <StylesSection />
      <div className="settings-section">
        <button type="button" className="settings-link" onClick={onOpenAdvanced}>
          All 16 params →
        </button>
      </div>
    </div>
  );
};
```

- [ ] **Step 4: Run test to verify pass**

```bash
bun test apps/frontend/src/settings/panels/panels.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/panels/BoardPanel.tsx apps/frontend/src/settings/panels/panels.test.ts
git commit -m "feat(settings-popover): BoardPanel main view"
```

---

## Task 17: BoardPanelAdvanced drill-down

**Files:**
- Create: `apps/frontend/src/settings/panels/BoardPanelAdvanced.tsx`

- [ ] **Step 1: Add failing test**

Append to `panels.test.ts`:

```ts
import { BoardPanelAdvanced } from "./BoardPanelAdvanced";

describe("BoardPanelAdvanced", () => {
  test("exports a component", () => {
    expect(typeof BoardPanelAdvanced).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
bun test apps/frontend/src/settings/panels/panels.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement BoardPanelAdvanced**

```tsx
// apps/frontend/src/settings/panels/BoardPanelAdvanced.tsx
import type { FC } from "react";
import type { LayoutParams } from "@shemma/domain";

const NUMERIC_FIELDS: ReadonlyArray<keyof LayoutParams> = [
  "nodeMinWidth", "nodeMinHeight", "nodePadding",
  "containerPadding", "containerLabelHeight",
  "edgeSpacing", "edgeNodeSpacing",
  "edgeLabelMaxWidth", "edgeLabelMaxLines", "edgeLabelMargin", "edgeLabelFontSize",
];

export type BoardPanelAdvancedProps = {
  effective: LayoutParams;
  onFieldChange: (field: keyof LayoutParams, value: number) => void;
  onReset: () => void;
  onBack: () => void;
};

export const BoardPanelAdvanced: FC<BoardPanelAdvancedProps> = ({ effective, onFieldChange, onReset, onBack }) => (
  <div className="settings-popover__panel settings-popover__panel--advanced" role="dialog" aria-label="Advanced layout params">
    <div className="settings-popover__header">
      <button type="button" onClick={onBack} className="settings-link">← Back</button>
      <button type="button" onClick={onReset} className="settings-link">Reset to defaults</button>
    </div>
    <div className="settings-popover__form">
      {NUMERIC_FIELDS.map((field) => (
        <label key={field} className="settings-field">
          <span className="settings-field__label">{field}</span>
          <input
            type="number"
            min={0}
            step={1}
            value={effective[field] as number}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) onFieldChange(field, v);
            }}
            className="settings-field__input"
          />
        </label>
      ))}
    </div>
  </div>
);
```

- [ ] **Step 4: Run test to verify pass**

```bash
bun test apps/frontend/src/settings/panels/panels.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/settings/panels/BoardPanelAdvanced.tsx apps/frontend/src/settings/panels/panels.test.ts
git commit -m "feat(settings-popover): BoardPanelAdvanced drill-down"
```

---

## Task 18: `SettingsPopover` root + `useSettingsTrigger` React-hook + InFrontOfTheCanvas slot

**Files:**
- Create: `apps/frontend/src/settings/SettingsPopover.tsx`
- Modify: `apps/frontend/src/settings/useSettingsTrigger.ts` (add React-hook around the pure resolveTarget)
- Modify: `apps/frontend/src/chrome/TldrawComponents.tsx` (add `InFrontOfTheCanvas` slot)
- Modify: `apps/frontend/src/App.tsx` (pass space/room to settings popover via context or props)

- [ ] **Step 1: Extend `useSettingsTrigger.ts` with React hook**

Append to `apps/frontend/src/settings/useSettingsTrigger.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import type { Editor } from "tldraw";

export type TriggerState = {
  target: Target | null;
};

export function useSettingsTrigger(editor: Editor | null): TriggerState & { close: () => void } {
  const [target, setTarget] = useState<Target | null>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    if (!editor) return;
    const container = editor.getContainer();

    function onPointerDown(e: PointerEvent) {
      if (!e.altKey) return;
      e.preventDefault();
      e.stopPropagation();

      const ed = editorRef.current;
      if (!ed) return;

      const screen = { x: e.clientX, y: e.clientY };
      const page = ed.screenToPage(screen);
      const hit = ed.getShapeAtPoint(page);
      const selected = ed.getSelectedShapeIds() as unknown as string[];

      const result = resolveTarget({
        hit: hit ?? null,
        selectedIds: selected,
        pointerScreen: screen,
        bbox: (ids) => {
          if (ids.length === 0) return null;
          const bounds = ed.getSelectionPageBounds() ?? ed.getShapePageBounds(ids[0] as any);
          if (!bounds) return null;
          // Convert page bounds to screen for anchor
          const tl = ed.pageToScreen({ x: bounds.x, y: bounds.y });
          const br = ed.pageToScreen({ x: bounds.x + bounds.w, y: bounds.y + bounds.h });
          return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
        },
      });
      setTarget(result);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setTarget(null);
    }

    container.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("keydown", onKey);

    // Close on camera move
    const dispose = editor.store.listen(
      () => setTarget(null),
      { scope: "session" },
    );

    return () => {
      container.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("keydown", onKey);
      dispose();
    };
  }, [editor]);

  return { target, close: () => setTarget(null) };
}
```

- [ ] **Step 2: Implement `SettingsPopover.tsx`**

```tsx
// apps/frontend/src/settings/SettingsPopover.tsx
import { useEffect, useRef, useState, type FC } from "react";
import { useEditor, useValue } from "tldraw";
import { useSettingsTrigger } from "./useSettingsTrigger";
import { computePopoverPosition } from "./position";
import { SelectionPanel } from "./panels/SelectionPanel";
import { NodePanel } from "./panels/NodePanel";
import { BoardPanel } from "./panels/BoardPanel";
import { BoardPanelAdvanced } from "./panels/BoardPanelAdvanced";
import {
  getLayoutParams, postLayoutParams, postLayoutSelection, type LayoutParamsResponse,
} from "./api";
import { applyPreset, type PresetName } from "./presets";
import type { LayoutParams } from "@shemma/domain";

export type SettingsPopoverProps = { space: string; room: string };

const POPOVER_SIZE = { width: 240, height: 280 };
const ADVANCED_SIZE = { width: 320, height: 480 };

export const SettingsPopover: FC<SettingsPopoverProps> = ({ space, room }) => {
  const editor = useEditor();
  const { target, close } = useSettingsTrigger(editor);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [boardParams, setBoardParams] = useState<LayoutParamsResponse | null>(null);
  const [pending, setPending] = useState<"tidy" | "force-unpin" | null>(null);

  // Reset advanced when popover closes
  useEffect(() => {
    if (!target) { setAdvanced(false); setBoardParams(null); }
  }, [target]);

  // Load board params when target is "board"
  useEffect(() => {
    if (target?.kind === "board") {
      getLayoutParams(space, room).then(setBoardParams).catch(() => setBoardParams(null));
    }
  }, [target, space, room]);

  // Click-outside dismiss
  useEffect(() => {
    if (!target) return;
    function onDown(e: PointerEvent) {
      const el = popoverRef.current;
      if (el && !el.contains(e.target as Node)) close();
    }
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [target, close]);

  if (!target) return null;

  const size = target.kind === "board" && advanced ? ADVANCED_SIZE : POPOVER_SIZE;
  const pos = computePopoverPosition({
    anchor: target.anchor,
    popoverSize: size,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    margin: 16,
  });

  return (
    <div
      ref={popoverRef}
      className="settings-popover"
      style={{
        position: "absolute",
        left: pos.x, top: pos.y,
        width: size.width,
        pointerEvents: "auto",
        zIndex: 1,
      }}
    >
      {target.kind === "selection" && (
        <SelectionPanelContainer
          editor={editor}
          space={space}
          room={room}
          pending={pending}
          setPending={setPending}
        />
      )}
      {target.kind === "node" && (
        <NodePanelContainer
          editor={editor}
          subjectId={target.subjectId}
        />
      )}
      {target.kind === "board" && !advanced && boardParams && (
        <BoardPanel
          effective={boardParams.effective}
          onDirectionChange={async (d) => {
            const next = { ...boardParams.raw ?? {}, defaultDirection: d } as Partial<LayoutParams>;
            setBoardParams({ raw: next, effective: { ...boardParams.effective, defaultDirection: d } as LayoutParams });
            try { const r = await postLayoutParams(space, room, next); setBoardParams({ raw: next, effective: r.effective }); }
            catch { setBoardParams(boardParams); }
          }}
          onPresetSelect={async (p: PresetName) => {
            const next = applyPreset(boardParams.raw ?? {}, p);
            setBoardParams({ raw: next, effective: { ...boardParams.effective, ...next } as LayoutParams });
            try { const r = await postLayoutParams(space, room, next); setBoardParams({ raw: next, effective: r.effective }); }
            catch { setBoardParams(boardParams); }
          }}
          onToggleAutoDirection={async (enabled) => {
            const next = { ...boardParams.raw ?? {}, autoDirectionEnabled: enabled };
            setBoardParams({ raw: next, effective: { ...boardParams.effective, autoDirectionEnabled: enabled } });
            try { const r = await postLayoutParams(space, room, next); setBoardParams({ raw: next, effective: r.effective }); }
            catch { setBoardParams(boardParams); }
          }}
          onMidpointModeChange={async (mode) => {
            const next = { ...boardParams.raw ?? {}, midpointDistribution: mode };
            setBoardParams({ raw: next, effective: { ...boardParams.effective, midpointDistribution: mode } });
            try { const r = await postLayoutParams(space, room, next); setBoardParams({ raw: next, effective: r.effective }); }
            catch { setBoardParams(boardParams); }
          }}
          onOpenAdvanced={() => setAdvanced(true)}
        />
      )}
      {target.kind === "board" && advanced && boardParams && (
        <BoardPanelAdvanced
          effective={boardParams.effective}
          onFieldChange={async (field, value) => {
            const next = { ...boardParams.raw ?? {}, [field]: value };
            setBoardParams({ raw: next, effective: { ...boardParams.effective, [field]: value } });
            try { const r = await postLayoutParams(space, room, next); setBoardParams({ raw: next, effective: r.effective }); }
            catch { setBoardParams(boardParams); }
          }}
          onReset={async () => {
            try { const r = await postLayoutParams(space, room, null); setBoardParams({ raw: null, effective: r.effective }); }
            catch { /* keep */ }
          }}
          onBack={() => setAdvanced(false)}
        />
      )}
    </div>
  );
};

// Inline container components to keep wiring colocated (extract if grows >100 lines)
const SelectionPanelContainer: FC<{
  editor: ReturnType<typeof useEditor>;
  space: string;
  room: string;
  pending: "tidy" | "force-unpin" | null;
  setPending: (p: "tidy" | "force-unpin" | null) => void;
}> = ({ editor, space, room, pending, setPending }) => {
  const counts = useValue("selectionCounts", () => {
    const selected = editor.getSelectedShapes() as unknown as Array<{ type: string }>;
    const containers = selected.filter((s) => s.type === "schema-container").length;
    return { containers, nodes: selected.length - containers };
  }, [editor]);

  const direction = useValue("dir", () => {
    const containers = (editor.getSelectedShapes() as unknown as Array<{ type: string; props?: { direction?: string } }>)
      .filter((s) => s.type === "schema-container");
    if (containers.length === 0) return null;
    const first = containers[0]?.props?.direction;
    return containers.every((c) => c.props?.direction === first) ? (first ?? null) : null;
  }, [editor]) as any;

  const pinValues = useValue("pinValues", () => {
    const selected = editor.getSelectedShapes() as unknown as Array<{ meta?: { pinned?: boolean; didrawSizePinned?: boolean } }>;
    return {
      size: selected.length > 0 && selected.every((s) => s.meta?.didrawSizePinned === true),
      position: selected.length > 0 && selected.every((s) => s.meta?.pinned === true),
    };
  }, [editor]);

  return (
    <SelectionPanel
      counts={counts}
      direction={direction}
      onDirectionChange={async (d) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        try { await postLayoutSelection(space, room, { ids, direction: d }); }
        catch (e) { console.warn("[settings] direction change failed", e); }
      }}
      onLayoutAction={async (id) => {
        setPending(id);
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        try {
          await postLayoutSelection(space, room, { ids, forceUnpin: id === "force-unpin" });
        } catch (e) { console.warn("[settings] layout action failed", e); }
        finally { setPending(null); }
      }}
      pinValues={pinValues}
      onPinToggle={(field) => {
        const ids = editor.getSelectedShapeIds();
        editor.run(() => {
          for (const id of ids) {
            const s = editor.getShape(id) as any;
            if (!s) continue;
            const nextVal = !((field === "size" ? s.meta?.didrawSizePinned : s.meta?.pinned) === true);
            editor.updateShape({
              id, type: s.type,
              meta: { ...s.meta, [field === "size" ? "didrawSizePinned" : "pinned"]: nextVal },
            });
          }
        });
      }}
      pending={pending}
    />
  );
};

const NodePanelContainer: FC<{
  editor: ReturnType<typeof useEditor>;
  subjectId: string;
}> = ({ editor, subjectId }) => {
  const pinValues = useValue("nodePinValues", () => {
    const s = editor.getShape(subjectId as any) as any;
    return {
      size: s?.meta?.didrawSizePinned === true,
      position: s?.meta?.pinned === true,
    };
  }, [editor, subjectId]);

  const role = useValue("nodeRole", () => {
    const s = editor.getShape(subjectId as any) as any;
    return s?.meta?.didrawRole ?? null;
  }, [editor, subjectId]) as any;

  return (
    <NodePanel
      pinValues={pinValues}
      onPinToggle={(field) => {
        const s = editor.getShape(subjectId as any) as any;
        if (!s) return;
        const nextVal = !((field === "size" ? s.meta?.didrawSizePinned : s.meta?.pinned) === true);
        editor.updateShape({
          id: s.id, type: s.type,
          meta: { ...s.meta, [field === "size" ? "didrawSizePinned" : "pinned"]: nextVal },
        });
      }}
      role={role}
      onRoleSelect={(r) => {
        const s = editor.getShape(subjectId as any) as any;
        if (!s) return;
        editor.updateShape({ id: s.id, type: s.type, meta: { ...s.meta, didrawRole: r } });
      }}
    />
  );
};
```

- [ ] **Step 3: Wire into `TldrawComponents.tsx`**

Modify `apps/frontend/src/chrome/TldrawComponents.tsx`:

```ts
// Imports (add)
import { SettingsPopover } from "../settings/SettingsPopover";

// Inside the returned TLComponents object, add:
return {
  // ... existing SharePanel / Toolbar / ContextMenu
  InFrontOfTheCanvas: () => <SettingsPopover space={space} room={room} />,
};
```

- [ ] **Step 4: Smoke check — type-check passes**

```bash
bun run --cwd apps/frontend typecheck
```
Expected: no TypeScript errors.

- [ ] **Step 5: Smoke check — frontend tests pass**

```bash
bun test --cwd apps/frontend src
```
Expected: existing 283 + new tests PASS.

- [ ] **Step 6: Manual visual verify — start dev, Option+click, check popovers**

```bash
bun --cwd apps/frontend dev &
# Open http://localhost:5173 in browser (chrome-devtools MCP)
# 1. Option+click empty canvas → BoardPanel opens
# 2. Option+click schema-container → SelectionPanel (1 container)
# 3. Option+click node → NodePanel
# 4. Esc closes popover
# 5. Pan canvas with popover open → closes
```

Если popover не появляется или позиционируется не туда — debug step before commit.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/settings/ apps/frontend/src/chrome/TldrawComponents.tsx
git commit -m "feat(settings-popover): wire SettingsPopover via InFrontOfTheCanvas"
```

---

## Task 19: Styles — minimal CSS for popover + sections

**Files:**
- Create: `apps/frontend/src/settings/styles.css`
- Modify: `apps/frontend/src/main.tsx` (или App.tsx) — import the css

- [ ] **Step 1: Add stylesheet**

```css
/* apps/frontend/src/settings/styles.css */
.settings-popover {
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 8px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.08);
  padding: 10px 12px;
  font-size: 12px;
  color: #333;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
}
.settings-popover__panel { display: flex; flex-direction: column; gap: 10px; }
.settings-section__label { color: #999; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 4px; }
.settings-section__row { display: flex; gap: 4px; flex-wrap: wrap; }
.settings-section__row--stacked { flex-direction: column; }
.settings-section__row--wrap { flex-wrap: wrap; }
.settings-section__hint { font-size: 10px; color: #aaa; }
.settings-btn {
  padding: 3px 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: #fafafa;
  font-size: 11px;
  cursor: pointer;
}
.settings-btn:hover { background: #f0f0f0; }
.settings-btn--on { background: #4a8af0; color: white; border-color: #4a8af0; }
.settings-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.settings-btn__kbd { margin-left: 6px; font-size: 10px; color: #999; }
.settings-link {
  background: none; border: none; color: #4a8af0; cursor: pointer; font-size: 11px; padding: 0;
}
.settings-popover__footer { font-size: 10px; color: #aaa; padding-top: 4px; border-top: 1px solid #eee; }
.settings-popover__header { display: flex; justify-content: space-between; margin-bottom: 8px; }
.settings-popover__form { display: flex; flex-direction: column; gap: 6px; max-height: 380px; overflow-y: auto; }
.settings-field { display: flex; align-items: center; justify-content: space-between; font-size: 11px; }
.settings-field__input { width: 80px; padding: 2px 6px; border: 1px solid #ddd; border-radius: 4px; font-size: 11px; }
```

- [ ] **Step 2: Import css in main.tsx**

Find `apps/frontend/src/main.tsx` and add:

```ts
import "./settings/styles.css";
```

(После существующего `import "./styles.css"`.)

- [ ] **Step 3: Verify dev server reloads cleanly**

Manual: open dev server, popover должен иметь финальный look.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/settings/styles.css apps/frontend/src/main.tsx
git commit -m "style(settings-popover): popover stylesheet"
```

---

## Task 20: A11y polish — focus trap + keyboard nav + preset hints

**Files:**
- Modify: `apps/frontend/src/settings/SettingsPopover.tsx`
- Modify: `apps/frontend/src/settings/panels/BoardPanel.tsx`

- [ ] **Step 0: Add `aria-describedby` для spacing presets в BoardPanel**

Per spec §8: presets имеют sub-label "Compact: ~50% tighter spacing", "Roomy: ~50% more breathing room".

В `BoardPanel.tsx`, в preset buttons rendering loop add:

```tsx
const PRESET_HINTS: Record<PresetName, string> = {
  Compact: "Tighter spacing — fits more on screen",
  Normal: "Default spacing",
  Roomy: "Generous spacing — easier to read",
};

// in button:
<button
  // ...existing
  aria-describedby={`preset-hint-${name}`}
>
  {name}
</button>
<span id={`preset-hint-${name}`} className="sr-only">{PRESET_HINTS[name]}</span>
```

Add `.sr-only` to `styles.css`:

```css
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
```

- [ ] **Step 1: Add focus management to SettingsPopover**

В `SettingsPopover.tsx` после render, add:

```tsx
useEffect(() => {
  if (!target) return;
  const el = popoverRef.current;
  if (!el) return;
  // Focus first focusable element
  const first = el.querySelector<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])');
  first?.focus();

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Tab") return;
    const focusables = Array.from(el!.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
  el.addEventListener("keydown", onKey);
  return () => el.removeEventListener("keydown", onKey);
}, [target]);
```

- [ ] **Step 2: Manual a11y verify**

- Tab cycles within popover, doesn't leak.
- Shift+Tab cycles backward.
- Esc closes (already wired).

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/settings/SettingsPopover.tsx apps/frontend/src/settings/panels/BoardPanel.tsx apps/frontend/src/settings/styles.css
git commit -m "feat(settings-popover): focus trap + tab cycling + preset hints"
```

---

## Task 21: Final integration — full test + visual gate

- [ ] **Step 1: Run full test suite**

```bash
bun run test                                    # backend + domain + cli + client
bun test --cwd apps/frontend src                # frontend
```
Expected: 1418+ tests PASS (baseline 1418 + new tests). No regressions.

- [ ] **Step 2: Type-check all packages**

```bash
bun run --cwd apps/frontend typecheck
bun run --cwd apps/backend typecheck
```
Expected: clean.

- [ ] **Step 3: Visual gate via chrome-devtools MCP**

Start dev server, open existing test room, перформ:

```
A. Empty canvas → Option+click → BoardPanel должен открыться у курсора.
   Сменить preset Normal → Compact → backend POST → backend layout применяется → canvas обновляется.

B. Single Frame selected → Option+click на Frame → SelectionPanel "1 container".
   Сменить Direction LR → RL → канвас перелэйаут'ится.

C. Single node selected → Option+click на node → NodePanel.
   Toggle 📌 size → meta.didrawSizePinned записан → WS broadcast → backend знает.

D. Multi-selection (3 nodes + 1 frame) → Option+click → SelectionPanel "1 container, 3 nodes".
   Click "Force re-layout" → backend layout-selection с forceUnpin=true → канвас перелэйаут.

E. Esc / click outside / pan canvas → popover закрывается.
```

Если any step fails — debug per phase before commit.

- [ ] **Step 4: Update CHANGELOG**

Append entry under `## Unreleased` в `CHANGELOG.md`:

```md
### Added
- Settings popover (DRW-NNN): Option+click открывает контекстную панель — SelectionPanel / NodePanel / BoardPanel. BoardPanel exposes spacing presets (Compact/Normal/Roomy) + Advanced drill-down ко всем 16 LayoutParams. Pin size/position через editor.updateShape + WS sync. `room.meta.layoutParams` управляется новым `GET+POST /api/board/layout-params`; `POST /api/agent/layout-selection` поддерживает `forceUnpin` для разового override pinned dimensions.
```

(DRW номер — взять из Task 0; подставить вместо `DRW-NNN`.)

- [ ] **Step 5: Final commit**

```bash
git add CHANGELOG.md
git commit -m "docs(settings-popover): changelog entry"
```

- [ ] **Step 6: Mark backlog task Done**

```bash
backlog task edit DRW-NNN -s "Done"
```

- [ ] **Step 7: Phase summary**

Push не делаем (`feedback-no-remote-push`). Merge в main через `--no-ff` после user acceptance (`feedback-merge-needs-acceptance`). Не tag'аем — per [[feedback-versioning-tags-only-on-release]].

---

## Notes for executors

- **Pin path:** мы НЕ создаём `POST /api/shape/:id/pin`. Pin делается через `editor.updateShape({ meta })` — WS sync передаёт backend'у. Это match'ит role-picker pattern.
- **Backend WS roomMeta broadcast:** если ещё нет helper'а — добавить минимальный (Task 6 Step 5). Использовать тот же transport pattern, что для shape-updates. Не изобретать новый WS-message-format если есть pre-existing.
- **`useValue` cells:** не overengineer reactivity; для popover'а простые `useValue` достаточно. Если performance деградирует — оптимизация в otherwise-iteration.
- **Visual gate (Task 21 Step 3):** controller (main agent) делает chrome-devtools verification сам, не делегирует subagent'у — per `feedback-no-subagent-screenshot-trust`.
- **Optimistic UI:** для board params local state в `<SettingsPopover />` обновляется сразу, fetch async. На error — keep prev. Не делать долгий "Saving…" overlay на v1 — простой optimistic + console.warn на error.
- **`getContainer()`:** `editor.getContainer()` — tldraw API, returns the root `.tl-container` element. Если signature другая в 5.x — fall back к `document.querySelector('.tl-container')` в hook.
- **CSS layering:** popover внутри `InFrontOfTheCanvas` slot уже над canvas. Дополнительный `z-index: 1` на popover'е достаточен. Если другие overlays (DRW-134) конфликтуют — повысить до 100.
