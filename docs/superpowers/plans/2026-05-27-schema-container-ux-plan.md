# SchemaContainer UX cluster — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development with **phase-end review override** (per project CLAUDE.md: no spec/quality review between tasks; final review only at phase end).

**Goal:** Implement DRW-186 sub-features A–E (toolbar restructure, creation tool, inline label edit, title position 3-way + board policy, fill rendering parity).

**Architecture:** State-node-based custom tool for drag-from-corner creation. Custom `uiOverrides.tools` registration so M and SchemaContainer land in native overflow popover. tldraw migration sequence for `titlePosition` enum expansion. Board-default persistence via `room.meta.containerTitlePosition` mirroring DRW-180/181 endpoint pattern. HTML-overlay label editor replacing SVG text.

**Tech Stack:** tldraw 5.x (`StateNode`, `HTMLContainer`, `useEditableText`, `createShapePropsMigrationSequence`, `uiOverrides`), React 18, Bun backend.

**Spec:** docs/superpowers/specs/2026-05-27-schema-container-ux-design.md
**Backlog:** DRW-186
**Baseline:** branch `feature/drw-186-container-ux` from main `2946df0`.

---

## File structure

**Actual frontend structure (verified by reading repo):**
- BoardPanel = pure props-driven component at `apps/frontend/src/settings/panels/BoardPanel.tsx`
- SelectionPanel = pure props-driven component at `apps/frontend/src/settings/panels/SelectionPanel.tsx`
- Section components in `apps/frontend/src/settings/sections/`
- API client functions in `apps/frontend/src/settings/api.ts`
- State management lives in `apps/frontend/src/settings/SettingsPopover.tsx` (useState + useEffect, no SWR)

**New files:**
- `apps/frontend/src/shapes/schema-container/SchemaContainerTool.ts` — StateNode subclass + pure helpers (`computeShapeBoundsFromDrag`, `buildSchemaContainerShape`)
- `apps/frontend/src/shapes/schema-container/SchemaContainerTool.test.ts` — pure helper tests
- `apps/frontend/src/shapes/schema-container/SchemaContainerLabel.tsx` — HTML label render (Frame parity) + edit overlay
- `apps/frontend/src/shapes/schema-container/SchemaContainerMigrations.ts` — migration sequence
- `apps/frontend/src/shapes/schema-container/title-position.ts` — pure helpers (`migrateTitlePosition`, `normalizeTitlePosition`)
- `apps/frontend/src/shapes/schema-container/title-position.test.ts` — unit tests
- `apps/frontend/src/shapes/schema-container/title-position-board.ts` — `resolveBoardTitlePosition(editor)` reads from `editor.getDocumentSettings().meta`
- `apps/frontend/src/ui-overrides.ts` — `uiOverrides` + `assetUrls` constants
- `apps/frontend/src/settings/sections/ContainerTitlePositionSection.tsx` — board-level UI (3-toggle), pure-props
- `apps/frontend/src/settings/sections/ContainerTitlePositionOverrideSection.tsx` — per-container UI (3-toggle), pure-props
- `apps/frontend/public/icons/tool-schema-container.svg`, `tool-mermaid.svg`
- `apps/backend/src/routes/board-container-title-position.ts` — GET/POST endpoint (Hono router factory pattern, DI)
- `apps/backend/test/routes/board-container-title-position.test.ts` — endpoint tests

**Modified files:**
- `apps/frontend/src/shapes/schema-container/SchemaContainerShape.ts` — titlePosition enum
- `apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx` — canEdit, onDoubleClick, migrations, label HTML, fill fix
- `apps/frontend/src/chrome/TldrawComponents.tsx` — remove M inline; pass-through Toolbar
- `apps/frontend/src/App.tsx` — register `tools={[SchemaContainerTool]}` + `overrides={buildUiOverrides(...)}` + `assetUrls={...}` on `<Tldraw>`
- `apps/frontend/src/settings/api.ts` — add `getContainerTitlePosition` / `postContainerTitlePosition`
- `apps/frontend/src/settings/SettingsPopover.tsx` — useState for `containerTitlePosition`; on mount fetch; on save POST + sync to `editor.updateDocumentSettings({ meta: { containerTitlePosition } })`
- `apps/frontend/src/settings/panels/BoardPanel.tsx` — accept `containerTitlePosition` + `onContainerTitlePositionChange` props; render new section
- `apps/frontend/src/settings/panels/SelectionPanel.tsx` — conditional `ContainerTitlePositionOverrideSection` when single container
- Backend server bootstrap (find via `grep -rn boardStyleDefaultsRoutes apps/backend/src`) — mount `boardContainerTitlePositionRoutes(deps)`
- `CHANGELOG.md` — DRW-186 entry

---

## Task 1: Probe tldraw 5.x `uiOverrides.tools` + `StateNode` API

**Files:**
- Read: `node_modules/tldraw/src/lib/ui/overrides.ts` (or wherever TLUiOverrides type lives)
- Read: `node_modules/tldraw/src/lib/shapes/frame/FrameShapeTool.tsx`
- Create: `docs/probes/2026-05-27-drw-186-probe-tool-api.md`

- [ ] **Step 1: Locate tldraw TLUiOverrides type**

```bash
find node_modules/tldraw -name "*.d.ts" -exec grep -l "TLUiOverrides" {} \; | head -3
grep -A 20 "interface TLUiOverrides" $(find node_modules/tldraw -name "*.d.ts" | head -10) 2>/dev/null | head -50
```

- [ ] **Step 2: Locate FrameShapeTool source**

```bash
find node_modules/tldraw -name "FrameShapeTool*" -type f
```

Read the file. Note:
- How drag-from-corner works (Pointing state's onPointerMove → start dragging).
- How initial shape is created with `editor.createShape`.
- How style defaults are read (`editor.getStyleForNextShape`).

- [ ] **Step 3: Read `assetUrls` mechanism**

```bash
grep -rn "assetUrls" node_modules/tldraw/dist-esm/lib/ui --include="*.d.ts" 2>/dev/null | head -10
```

Note: `assetUrls.icons[<key>]` — map of icon names → URLs. Required for tool icons.

- [ ] **Step 4: Write findings to `docs/probes/2026-05-27-drw-186-probe-tool-api.md`**

Capture:
- TLUiOverrides.tools signature (exact types).
- StateNode subclass pattern (constructor, children, transitionTo).
- Drag-from-corner sequence (Idle → Pointing → Dragging).
- How to register `assetUrls` + icon SVG.
- Any unexpected required fields.

- [ ] **Step 5: Commit**

```bash
git add docs/probes/2026-05-27-drw-186-probe-tool-api.md
git commit -m "probe(DRW-186): document tldraw uiOverrides.tools + StateNode API"
```

---

## Task 2: Probe tldraw fill rendering helpers

**Files:**
- Read: `node_modules/tldraw/src/lib/shapes/geo/GeoShapeUtil.tsx`
- Read: `node_modules/tldraw/src/lib/shapes/shared/defaultStyleDefs.tsx`
- Append to: `docs/probes/2026-05-27-drw-186-probe-tool-api.md`

- [ ] **Step 1: Find GeoShape fill rendering**

```bash
grep -rn "fill === \"solid\"\|getFillDef\|FillStyleDef" node_modules/tldraw/src/lib/shapes 2>/dev/null | head -20
```

Note how native rect applies `fill="solid"` — likely via SVG `<defs>` pattern or via opacity/color modulation.

- [ ] **Step 2: Test live in browser**

Open `http://localhost:5173/`. Create native rect with `fill="solid"` red. Inspect DOM:
- Is the `<rect>` `fill` attribute `url(#...)` or a hex color?
- If hex — what opacity / alpha is applied?

Capture screenshot for record.

- [ ] **Step 3: Document the replication path**

Update probe doc with:
- Exact tldraw export to import (e.g. `getFillDef` from `tldraw` or `@tldraw/editor`).
- OR the SVG pattern source code to copy if export doesn't exist.
- Decision: import vs replicate.

- [ ] **Step 4: Commit**

```bash
git add docs/probes/2026-05-27-drw-186-probe-tool-api.md
git commit -m "probe(DRW-186): document native rect fill rendering"
```

---

## Task 3: Probe `canEdit` + double-click intercept for frame-like shapes

**Files:**
- Read: `node_modules/tldraw/src/lib/shapes/frame/FrameShapeUtil.tsx` (compare to our `SchemaContainerShapeUtil`)
- Read: `node_modules/tldraw/src/lib/editor/tools/SelectTool/childStates/Idle.ts` (or wherever double-click handler lives)
- Append to: probe doc

- [ ] **Step 1: Find BaseFrameLikeShapeUtil source**

```bash
find node_modules/tldraw -name "BaseFrameLikeShapeUtil*" -type f
```

Note:
- Default `canEdit()` — likely false.
- Default `onDoubleClick(shape)` — likely creates child text shape.
- Hooks tldraw uses to enter edit mode (`editor.setEditingShape(id)`).

- [ ] **Step 2: Verify override mechanism**

In `SchemaContainerShapeUtil`, the override pattern is the same as Frame. Confirm:
- `override canEdit() { return true; }` is sufficient to enable editing.
- `override onDoubleClick(shape)` returning `void` (no shape mutation) — does tldraw still create child text? If yes, need to call `editor.setEditingShape(shape.id)` explicitly.

- [ ] **Step 3: Document**

Update probe doc with:
- Override signature for `canEdit` / `onDoubleClick` in tldraw 5.x.
- Expected behavior change.
- Any required `editor.cancelDoubleClick()` or event suppression.

- [ ] **Step 4: Commit**

```bash
git add docs/probes/2026-05-27-drw-186-probe-tool-api.md
git commit -m "probe(DRW-186): document canEdit + onDoubleClick override"
```

---

## Task 4: Extend `titlePosition` enum + add migration

**Files:**
- Modify: `apps/frontend/src/shapes/schema-container/SchemaContainerShape.ts`
- Create: `apps/frontend/src/shapes/schema-container/title-position.ts`
- Create: `apps/frontend/src/shapes/schema-container/title-position.test.ts`
- Create: `apps/frontend/src/shapes/schema-container/SchemaContainerMigrations.ts`

- [ ] **Step 1: Write the failing migration test first**

```ts
// title-position.test.ts
import { describe, it, expect } from "bun:test";
import { migrateTitlePosition, normalizeTitlePosition } from "./title-position";

describe("titlePosition migration", () => {
  it("migrates legacy 'inside' → 'inside-center'", () => {
    expect(migrateTitlePosition("inside")).toBe("inside-center");
  });
  it("preserves 'outside'", () => {
    expect(migrateTitlePosition("outside")).toBe("outside");
  });
  it("coerces unknown → 'inside-center'", () => {
    expect(migrateTitlePosition("foobar")).toBe("inside-center");
    expect(migrateTitlePosition(undefined as unknown as string)).toBe("inside-center");
  });
  it("normalizeTitlePosition rejects null", () => {
    expect(normalizeTitlePosition(null)).toBe("inside-center");
  });
});
```

Run: `bun test apps/frontend/src/shapes/schema-container/title-position.test.ts`. Expected: FAIL (module doesn't exist).

- [ ] **Step 2: Implement `title-position.ts`**

```ts
// title-position.ts
export type SchemaContainerTitlePosition =
  | "outside"
  | "inside-center"
  | "inside-left";

const VALID = new Set<string>(["outside", "inside-center", "inside-left"]);

export function migrateTitlePosition(value: unknown): SchemaContainerTitlePosition {
  if (value === "inside") return "inside-center";
  if (typeof value === "string" && VALID.has(value)) {
    return value as SchemaContainerTitlePosition;
  }
  return "inside-center";
}

export function normalizeTitlePosition(
  value: unknown,
): SchemaContainerTitlePosition {
  return migrateTitlePosition(value);
}
```

Run: tests PASS.

- [ ] **Step 3: Update `SchemaContainerShape.ts`**

```ts
// SchemaContainerShape.ts (relevant changes)
export type SchemaContainerTitlePosition =
  | "outside"
  | "inside-center"
  | "inside-left";

// In schemaContainerShapeProps:
titlePosition: T.literalEnum("outside", "inside-center", "inside-left"),

// In DEFAULT_SCHEMA_CONTAINER_PROPS:
titlePosition: "inside-center",
```

Re-export `SchemaContainerTitlePosition` from one location (`title-position.ts` is canonical; shape file re-exports for backward import paths).

- [ ] **Step 4: Create `SchemaContainerMigrations.ts`**

```ts
// SchemaContainerMigrations.ts
import { createShapePropsMigrationSequence } from "tldraw";

export const schemaContainerMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: "com.shemma.schema-container/1",
      up: (props: Record<string, unknown>) => {
        if (props.titlePosition === "inside") {
          props.titlePosition = "inside-center";
        }
        if (
          typeof props.titlePosition !== "string" ||
          !["outside", "inside-center", "inside-left"].includes(
            props.titlePosition as string,
          )
        ) {
          props.titlePosition = "inside-center";
        }
      },
    },
  ],
});
```

Confirm API via Task 1 probe (signature may need adjustment to `createShapeRecordPropsMigrationSequence` or `defineMigrations` depending on tldraw 5.x version).

- [ ] **Step 5: Wire migration to ShapeUtil**

In `SchemaContainerShapeUtil.tsx`:
```ts
import { schemaContainerMigrations } from "./SchemaContainerMigrations";

export class SchemaContainerShapeUtil extends BaseFrameLikeShapeUtil<SchemaContainerShape> {
  static override type = "schema-container" as const;
  static override props = schemaContainerShapeProps;
  static override migrations = schemaContainerMigrations;
  // ...
}
```

- [ ] **Step 6: Update existing render functions for new enum**

In `SchemaContainerShapeUtil.tsx`, `renderInsideTitle` is called only when `titlePosition !== "outside"`. Now there are 2 inside variants — adjust selector:

```ts
override component(shape: SchemaContainerShape) {
  return shape.props.titlePosition === "outside"
    ? renderOutsideTitle(shape, this.editor)
    : renderInsideTitle(shape, this.editor);  // handles both inside-center + inside-left
}
```

Inside `renderInsideTitle`, switch text `x` / `textAnchor` based on `titlePosition`:
- `inside-center` → `x={w / 2} textAnchor="middle"`
- `inside-left` → `x={12} textAnchor="start"`

This is interim — Task 11 replaces SVG text with HTML.

- [ ] **Step 7: Update getGeometry for new enum**

In `getGeometry`:
```ts
const labelHeight =
  titlePosition === "outside" ? OUTSIDE_LABEL_HEIGHT : INSIDE_LABEL_HEIGHT;
```

This stays — both inside variants use the same label height.

- [ ] **Step 8: Run all tests to verify no regressions**

```bash
bun run test
```

Expected: 2095 + new tests passing.

- [ ] **Step 9: Commit**

```bash
git add apps/frontend/src/shapes/schema-container/
git commit -m "feat(DRW-186): titlePosition enum 3-way + migration

Expand titlePosition from 'inside'/'outside' to 'outside'/'inside-center'/'inside-left'.
Migration coerces legacy 'inside' → 'inside-center' and unknown values to default.
Pure helpers in title-position.ts (migrateTitlePosition / normalizeTitlePosition).
Render selector branches on outside vs inside; inside-left uses textAnchor='start' (interim SVG impl)."
```

---

## Task 5: SchemaContainerTool (drag-from-corner StateNode)

**Files:**
- Create: `apps/frontend/src/shapes/schema-container/SchemaContainerTool.ts`
- Create: `apps/frontend/src/shapes/schema-container/SchemaContainerTool.test.ts`

- [ ] **Step 1: Write failing pure-helper test**

Frontend testing pattern in this repo (e.g. `pin-auto-toggle.test.ts`) — pure helpers tested in isolation, editor-bound logic verified manually via dev stand. Extract drag-create into a pure helper:

```ts
// SchemaContainerTool.test.ts
import { describe, it, expect } from "bun:test";
import { computeShapeBoundsFromDrag, buildSchemaContainerShape } from "./SchemaContainerTool";

describe("computeShapeBoundsFromDrag", () => {
  it("computes positive bounds for diagonal drag", () => {
    const b = computeShapeBoundsFromDrag({ x: 100, y: 50 }, { x: 300, y: 200 });
    expect(b).toEqual({ x: 100, y: 50, w: 200, h: 150 });
  });
  it("normalizes inverted drag (drag-up-left)", () => {
    const b = computeShapeBoundsFromDrag({ x: 300, y: 200 }, { x: 100, y: 50 });
    expect(b).toEqual({ x: 100, y: 50, w: 200, h: 150 });
  });
  it("enforces minimum size 50×50", () => {
    const b = computeShapeBoundsFromDrag({ x: 100, y: 100 }, { x: 110, y: 105 });
    expect(b.w).toBeGreaterThanOrEqual(50);
    expect(b.h).toBeGreaterThanOrEqual(50);
  });
});

describe("buildSchemaContainerShape", () => {
  it("creates shape spec with provided bounds and style defaults", () => {
    const spec = buildSchemaContainerShape({
      bounds: { x: 100, y: 50, w: 200, h: 150 },
      titlePosition: "inside-center",
      color: "red",
      fill: "semi",
      dash: "solid",
    });
    expect(spec.type).toBe("schema-container");
    expect(spec.x).toBe(100);
    expect(spec.props.w).toBe(200);
    expect(spec.props.titlePosition).toBe("inside-center");
    expect(spec.props.color).toBe("red");
  });
});
```

Run: FAIL (module doesn't exist).

- [ ] **Step 2: Implement `SchemaContainerTool.ts`**

Pattern from Task 1 probe — fill in based on documented `StateNode` API. Pure helpers extracted; tool wraps them:

```ts
// SchemaContainerTool.ts
import {
  StateNode,
  createShapeId,
  DefaultColorStyle,
  DefaultDashStyle,
  DefaultFillStyle,
} from "tldraw";
import type {
  TLDefaultColorStyle,
  TLDefaultDashStyle,
  TLDefaultFillStyle,
} from "tldraw";
import { DEFAULT_SCHEMA_CONTAINER_PROPS } from "./SchemaContainerShape";
import { resolveBoardTitlePosition } from "./title-position-board";  // created in Task 8
import type { SchemaContainerTitlePosition } from "./title-position";

export type Bounds = { x: number; y: number; w: number; h: number };

const MIN_SIZE = 50;

export function computeShapeBoundsFromDrag(
  origin: { x: number; y: number },
  current: { x: number; y: number },
): Bounds {
  const x = Math.min(origin.x, current.x);
  const y = Math.min(origin.y, current.y);
  const w = Math.max(Math.abs(current.x - origin.x), MIN_SIZE);
  const h = Math.max(Math.abs(current.y - origin.y), MIN_SIZE);
  return { x, y, w, h };
}

export interface BuildShapeOpts {
  bounds: Bounds;
  titlePosition: SchemaContainerTitlePosition;
  color: TLDefaultColorStyle;
  fill: TLDefaultFillStyle;
  dash: TLDefaultDashStyle;
}

export function buildSchemaContainerShape(opts: BuildShapeOpts) {
  return {
    type: "schema-container" as const,
    x: opts.bounds.x,
    y: opts.bounds.y,
    props: {
      ...DEFAULT_SCHEMA_CONTAINER_PROPS,
      w: opts.bounds.w,
      h: opts.bounds.h,
      titlePosition: opts.titlePosition,
      color: opts.color,
      fill: opts.fill,
      dash: opts.dash,
    },
  };
}

class Idle extends StateNode {
  static override id = "idle";
  override onPointerDown = () => {
    this.parent.transition("pointing");
  };
}

class Pointing extends StateNode {
  static override id = "pointing";
  override onPointerMove = () => {
    if (this.editor.inputs.isDragging) {
      this.startCreating();
    }
  };
  override onPointerUp = () => {
    this.parent.transition("idle");
  };
  private startCreating() {
    const { originPagePoint, currentPagePoint } = this.editor.inputs;
    const bounds = computeShapeBoundsFromDrag(
      { x: originPagePoint.x, y: originPagePoint.y },
      { x: currentPagePoint.x, y: currentPagePoint.y },
    );
    const id = createShapeId();
    const spec = buildSchemaContainerShape({
      bounds,
      titlePosition: resolveBoardTitlePosition(this.editor),
      color: this.editor.getStyleForNextShape(DefaultColorStyle) as TLDefaultColorStyle,
      fill: this.editor.getStyleForNextShape(DefaultFillStyle) as TLDefaultFillStyle,
      dash: this.editor.getStyleForNextShape(DefaultDashStyle) as TLDefaultDashStyle,
    });
    this.editor.createShape({ id, ...spec });
    this.editor.setSelectedShapes([id]);
    this.parent.transition("idle");
    this.editor.setCurrentTool("select");
  }
}

export class SchemaContainerTool extends StateNode {
  static override id = "schema-container";
  static override initial = "idle";
  static override children = () => [Idle, Pointing];
}
```

- [ ] **Step 3: Provide stub for `resolveBoardTitlePosition`**

In `title-position-board.ts` (NEW):
```ts
// title-position-board.ts
import type { Editor } from "tldraw";
import { normalizeTitlePosition, type SchemaContainerTitlePosition } from "./title-position";

export function resolveBoardTitlePosition(editor: Editor): SchemaContainerTitlePosition {
  // Read from documentSettings.meta (synced from /api/board/container-title-position).
  // Setter: useBoardContainerTitlePosition writes through to documentSettings.meta.
  const meta = editor.getDocumentSettings().meta as Record<string, unknown> | undefined;
  return normalizeTitlePosition(meta?.containerTitlePosition);
}
```

Confirm `getDocumentSettings().meta` is the right API; Task 1 probe should clarify. If not — use a side channel like `window.__shemmaContainerTitlePosition` (cache populated by hook).

- [ ] **Step 4: Run tests**

```bash
bun test apps/frontend/src/shapes/schema-container/
```

Expected: PASS (or `it.todo` if TestEditor isn't usable — defer to manual verify).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/shapes/schema-container/
git commit -m "feat(DRW-186): SchemaContainerTool drag-from-corner

StateNode subclass with Idle + Pointing children (parity with FrameShapeTool).
Reads style defaults from editor.getStyleForNextShape; resolves board title position via documentSettings.meta."
```

---

## Task 6: Register tools via uiOverrides + remove M inline

**Files:**
- Create: `apps/frontend/src/ui-overrides.ts`
- Modify: `apps/frontend/src/App.tsx`
- Modify: `apps/frontend/src/chrome/TldrawComponents.tsx`

- [ ] **Step 1: Create `ui-overrides.ts`**

```ts
// ui-overrides.ts
import type { TLUiOverrides, TLUiAssetUrlOverrides } from "tldraw";

export function buildUiOverrides(opts: {
  onMermaidImport?: () => void;
}): TLUiOverrides {
  return {
    tools(_editor, tools, _helpers) {
      // Add SchemaContainer tool entry
      tools["schema-container"] = {
        id: "schema-container",
        label: "Container",
        icon: "tool-schema-container",  // asset key
        kbd: "c",
        onSelect: () => _editor.setCurrentTool("schema-container"),
      };
      // Add Mermaid import tool entry (no actual tool state — invokes callback)
      if (opts.onMermaidImport) {
        tools["mermaid-import"] = {
          id: "mermaid-import",
          label: "Mermaid",
          icon: "tool-mermaid",
          kbd: "$m",  // ⌘M
          onSelect: opts.onMermaidImport,
        };
      }
      return tools;
    },
  };
}

export const SHEMMA_ASSET_URLS: TLUiAssetUrlOverrides = {
  icons: {
    "tool-schema-container": "/icons/tool-schema-container.svg",
    "tool-mermaid": "/icons/tool-mermaid.svg",
  },
};
```

Adjust `TLUiAssetUrlOverrides` shape per Task 1 probe outcome.

- [ ] **Step 2: Create icon SVG files**

`apps/frontend/public/icons/tool-schema-container.svg`:
```xml
<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="3" width="12" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <rect x="4" y="5" width="8" height="6" rx="0.5" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.6"/>
</svg>
```

`apps/frontend/public/icons/tool-mermaid.svg`:
```xml
<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <text x="8" y="12" text-anchor="middle" font-family="monospace" font-size="11" font-weight="600" fill="currentColor">M</text>
</svg>
```

- [ ] **Step 3: Wire to `<Tldraw>` in App.tsx**

In App.tsx around line 705:
```tsx
import { SchemaContainerTool } from "./shapes/schema-container/SchemaContainerTool";
import { buildUiOverrides, SHEMMA_ASSET_URLS } from "./ui-overrides";

// ...
<Tldraw
  shapeUtils={[SchemaContainerShapeUtil]}
  tools={[SchemaContainerTool]}
  overrides={buildUiOverrides({ onMermaidImport: () => setMermaidOpen(true) })}
  assetUrls={SHEMMA_ASSET_URLS}
  // ... rest unchanged
>
```

- [ ] **Step 4: Strip M-button from `TldrawComponents.tsx`**

Replace the `Toolbar:` field with a pass-through:
```tsx
Toolbar: () => (
  <DefaultToolbar>
    <DefaultToolbarContent />
  </DefaultToolbar>
),
```

Remove the `onMermaidImport?: () => void` parameter handling AND the inline `<button>M</button>` block. Update `opts` signature to drop `onMermaidImport`.

Update App.tsx call to `buildTldrawComponents(space, room, { onTidySelection, onExportSelection, onSetContainerDirection })` — without `onMermaidImport`.

- [ ] **Step 5: Live verify in browser**

Refresh `http://localhost:5173/`. Open the overflow popover (chevron). Expect: M-icon + container-icon at the bottom. Primary toolbar: no M-button.

Test: click container icon → cursor changes. Drag on canvas → SchemaContainer created.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/ui-overrides.ts apps/frontend/public/icons/ apps/frontend/src/App.tsx apps/frontend/src/chrome/TldrawComponents.tsx
git commit -m "feat(DRW-186): register schema-container + mermaid tools via uiOverrides

Both tools land in native overflow popover; M-button removed from primary toolbar slot.
Icons in apps/frontend/public/icons/. assetUrls.icons map registered via SHEMMA_ASSET_URLS."
```

---

## Task 7: Backend endpoint for `containerTitlePosition`

**Files:**
- Create: `apps/backend/src/routes/board-container-title-position.ts` (flat path, mirrors `board-style-defaults.ts`)
- Modify: backend server bootstrap (where `boardStyleDefaultsRoutes` is wired — find via `grep -rn boardStyleDefaultsRoutes apps/backend/src`)
- Create: `apps/backend/test/routes/board-container-title-position.test.ts` (mirrors `apps/backend/test/routes/board-style-defaults.test.ts`)

- [ ] **Step 1: Read existing test pattern**

```bash
cat apps/backend/test/routes/board-style-defaults.test.ts
```

Use the same DI pattern (mock `getRoom` / `persistRoom` / `broadcastRoomMeta` in test).

- [ ] **Step 2: Write failing test**

```ts
// apps/backend/test/routes/board-container-title-position.test.ts
import { describe, it, expect } from "bun:test";
import { boardContainerTitlePositionRoutes } from "../../src/routes/board-container-title-position";
import { Hono } from "hono";

function makeApp(roomMeta: Record<string, unknown> = {}) {
  const persists: Array<[string, string]> = [];
  const broadcasts: Array<[string, string]> = [];
  const app = new Hono();
  app.route("/", boardContainerTitlePositionRoutes({
    getRoom: async () => ({ meta: roomMeta }),
    persistRoom: (s, r) => persists.push([s, r]),
    broadcastRoomMeta: (s, r) => broadcasts.push([s, r]),
  }));
  return { app, persists, broadcasts, roomMeta };
}

describe("GET /api/board/container-title-position", () => {
  it("returns null when unset", async () => {
    const { app } = makeApp({});
    const res = await app.request("/api/board/container-title-position?space=s&room=r");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: null });
  });

  it("returns persisted value", async () => {
    const { app } = makeApp({ containerTitlePosition: "outside" });
    const res = await app.request("/api/board/container-title-position?space=s&room=r");
    expect(await res.json()).toEqual({ value: "outside" });
  });

  it("400 when space/room missing", async () => {
    const { app } = makeApp({});
    const res = await app.request("/api/board/container-title-position");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/board/container-title-position", () => {
  it("persists, broadcasts, and returns ok", async () => {
    const ctx = makeApp({});
    const res = await ctx.app.request("/api/board/container-title-position?space=s&room=r", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "inside-left" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ctx.roomMeta.containerTitlePosition).toBe("inside-left");
    expect(ctx.persists).toEqual([["s", "r"]]);
    expect(ctx.broadcasts).toEqual([["s", "r"]]);
  });

  it("rejects invalid enum value", async () => {
    const { app } = makeApp({});
    const res = await app.request("/api/board/container-title-position?space=s&room=r", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "wrong" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts null to clear", async () => {
    const ctx = makeApp({ containerTitlePosition: "outside" });
    const res = await ctx.app.request("/api/board/container-title-position?space=s&room=r", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: null }),
    });
    expect(res.status).toBe(200);
    expect(ctx.roomMeta.containerTitlePosition).toBeUndefined();
  });
});
```

Run: FAIL (route module doesn't exist).

- [ ] **Step 3: Implement endpoint**

Mirror `board-style-defaults.ts`:
```ts
// apps/backend/src/routes/board-container-title-position.ts
import { Hono } from "hono";

const VALID = ["outside", "inside-center", "inside-left"] as const;
type TitlePosition = (typeof VALID)[number];

export type BoardContainerTitlePositionDeps = {
  getRoom: (
    space: string,
    room: string,
  ) => Promise<{ meta?: Record<string, unknown> } | undefined>;
  persistRoom: (space: string, room: string) => void;
  broadcastRoomMeta: (space: string, room: string) => void;
};

export function boardContainerTitlePositionRoutes(deps: BoardContainerTitlePositionDeps) {
  return new Hono()
    .get("/api/board/container-title-position", async (c) => {
      const space = c.req.query("space");
      const room = c.req.query("room");
      if (!space || !room) {
        return c.json({ error: "space and room required" }, 400);
      }
      const r = await deps.getRoom(space, room);
      const value = (r?.meta?.containerTitlePosition as TitlePosition | undefined) ?? null;
      return c.json({ value });
    })
    .post("/api/board/container-title-position", async (c) => {
      const space = c.req.query("space");
      const room = c.req.query("room");
      if (!space || !room) {
        return c.json({ error: "space and room required" }, 400);
      }
      const body = await c.req
        .json<{ value?: TitlePosition | null }>()
        .catch(() => ({}) as { value?: TitlePosition | null });
      const value = body.value;
      if (value !== null && value !== undefined && !VALID.includes(value)) {
        return c.json({ error: "invalid value" }, 400);
      }
      const r = await deps.getRoom(space, room);
      if (!r) return c.json({ error: "room not found" }, 404);
      if (!r.meta) r.meta = {};
      const meta = r.meta as Record<string, unknown>;
      if (value === null || value === undefined) {
        delete meta.containerTitlePosition;
      } else {
        meta.containerTitlePosition = value;
      }
      deps.persistRoom(space, room);
      deps.broadcastRoomMeta(space, room);
      return c.json({ ok: true });
    });
}
```

- [ ] **Step 4: Wire into server bootstrap**

Find where `boardStyleDefaultsRoutes` is mounted:
```bash
grep -rn "boardStyleDefaultsRoutes" apps/backend/src
```

Mount `boardContainerTitlePositionRoutes(deps)` at the same level. Reuse `deps` object (same `getRoom`/`persistRoom`/`broadcastRoomMeta` references).

- [ ] **Step 5: Run tests**

```bash
bun --cwd apps/backend test routes/board-container-title-position
```

Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/board-container-title-position.ts apps/backend/test/routes/board-container-title-position.test.ts apps/backend/src/  # plus bootstrap file
git commit -m "feat(DRW-186): backend endpoint /api/board/container-title-position

GET/POST CRUD persisting to room.meta. Mirrors /api/board/style-defaults pattern.
Validation: enum (outside|inside-center|inside-left) or null to clear.
broadcastRoomMeta wired (no-op until DRW-182 lands)."
```

---

## Task 8: API client + SettingsPopover state + BoardPanel section

**Files:**
- Modify: `apps/frontend/src/settings/api.ts` — add fetchers
- Modify: `apps/frontend/src/settings/SettingsPopover.tsx` — useState + fetch on mount + POST on change + sync to editor.documentSettings.meta
- Create: `apps/frontend/src/settings/sections/ContainerTitlePositionSection.tsx` — pure-props 3-toggle
- Modify: `apps/frontend/src/settings/panels/BoardPanel.tsx` — accept new props, render section
- Modify: `apps/frontend/src/shapes/schema-container/title-position-board.ts` — read from editor.documentSettings.meta

- [ ] **Step 1: Read existing `getStyleDefaults` for pattern**

```bash
sed -n '50,90p' apps/frontend/src/settings/api.ts
```

Note signature shape and error handling.

- [ ] **Step 2: Add fetchers to api.ts**

```ts
// At bottom of apps/frontend/src/settings/api.ts
import { normalizeTitlePosition, type SchemaContainerTitlePosition } from "../shapes/schema-container/title-position";

export type ContainerTitlePositionResponse = {
  value: SchemaContainerTitlePosition | null;
};

export async function getContainerTitlePosition(
  space: string,
  room: string,
): Promise<ContainerTitlePositionResponse> {
  const url = `/api/board/container-title-position?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function postContainerTitlePosition(
  space: string,
  room: string,
  value: SchemaContainerTitlePosition | null,
): Promise<void> {
  const url = `/api/board/container-title-position?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
```

- [ ] **Step 3: Implement section component**

```tsx
// apps/frontend/src/settings/sections/ContainerTitlePositionSection.tsx
import type { SchemaContainerTitlePosition } from "../../shapes/schema-container/title-position";

const OPTIONS: { value: SchemaContainerTitlePosition; label: string }[] = [
  { value: "outside", label: "Снаружи" },
  { value: "inside-center", label: "По центру" },
  { value: "inside-left", label: "Слева" },
];

export type ContainerTitlePositionSectionProps = {
  current: SchemaContainerTitlePosition;
  onChange: (next: SchemaContainerTitlePosition) => void;
  title?: string;
};

export function ContainerTitlePositionSection({
  current,
  onChange,
  title = "Заголовок контейнеров",
}: ContainerTitlePositionSectionProps) {
  return (
    <section className="settings-popover__section">
      <h3 className="settings-popover__section-title">{title}</h3>
      <div role="radiogroup" aria-label={title} className="settings-toggle-row">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={current === opt.value}
            onClick={() => onChange(opt.value)}
            className={
              "settings-toggle" + (current === opt.value ? " settings-toggle--active" : "")
            }
          >
            {opt.label}
          </button>
        ))}
      </div>
    </section>
  );
}
```

Reuse existing CSS classes from sibling sections; copy or adjust class names by inspecting `StylesSection.tsx` and matching styles.

- [ ] **Step 4: Wire state into SettingsPopover**

In `apps/frontend/src/settings/SettingsPopover.tsx`, add alongside existing `styleDefaults` / `boardParams` state:

```tsx
import { getContainerTitlePosition, postContainerTitlePosition } from "./api";
import { normalizeTitlePosition, type SchemaContainerTitlePosition } from "../shapes/schema-container/title-position";
import { useEditor } from "tldraw";

// inside component
const editor = useEditor();
const [containerTitlePosition, setContainerTitlePosition] =
  useState<SchemaContainerTitlePosition>("inside-center");

useEffect(() => {
  getContainerTitlePosition(space, room)
    .then((r) => setContainerTitlePosition(normalizeTitlePosition(r.value)))
    .catch(() => setContainerTitlePosition("inside-center"));
}, [space, room]);

// Mirror state into editor.documentSettings.meta so SchemaContainerTool can read it
useEffect(() => {
  if (!editor) return;
  const meta = (editor.getDocumentSettings().meta ?? {}) as Record<string, unknown>;
  if (meta.containerTitlePosition !== containerTitlePosition) {
    editor.updateDocumentSettings({
      meta: { ...meta, containerTitlePosition },
    });
  }
}, [editor, containerTitlePosition]);

const onContainerTitlePositionChange = async (next: SchemaContainerTitlePosition) => {
  setContainerTitlePosition(next);  // optimistic
  try {
    await postContainerTitlePosition(space, room, next);
  } catch {
    // revert on failure — refetch
    const r = await getContainerTitlePosition(space, room);
    setContainerTitlePosition(normalizeTitlePosition(r.value));
  }
};
```

Pass `containerTitlePosition` and `onContainerTitlePositionChange` as props to `<BoardPanel ... />`.

- [ ] **Step 5: Update BoardPanel props + render section**

In `apps/frontend/src/settings/panels/BoardPanel.tsx`:

```tsx
// Add to BoardPanelProps:
containerTitlePosition: SchemaContainerTitlePosition;
onContainerTitlePositionChange: (next: SchemaContainerTitlePosition) => void;
```

Render below `StylesSection`:
```tsx
<ContainerTitlePositionSection
  current={containerTitlePosition}
  onChange={onContainerTitlePositionChange}
/>
```

- [ ] **Step 6: Wire `title-position-board.ts` to editor.documentSettings.meta**

```ts
// title-position-board.ts (created stub in Task 5, now finalize)
import type { Editor } from "tldraw";
import { normalizeTitlePosition, type SchemaContainerTitlePosition } from "./title-position";

export function resolveBoardTitlePosition(editor: Editor): SchemaContainerTitlePosition {
  const meta = editor.getDocumentSettings().meta as Record<string, unknown> | undefined;
  return normalizeTitlePosition(meta?.containerTitlePosition);
}
```

- [ ] **Step 7: Live verify**

Refresh page. Open Settings popover → BoardPanel shows "Заголовок контейнеров" with 3 toggles. Click toggles persist (refresh → value retained). Create new container via drag tool → uses selected position.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/settings/api.ts apps/frontend/src/settings/SettingsPopover.tsx apps/frontend/src/settings/sections/ContainerTitlePositionSection.tsx apps/frontend/src/settings/panels/BoardPanel.tsx apps/frontend/src/shapes/schema-container/title-position-board.ts
git commit -m "feat(DRW-186): board-level container title position UI

SettingsPopover useState + fetch on mount + POST on change + sync to editor.documentSettings.meta.
BoardPanel new section 'Заголовок контейнеров' with 3-toggle (outside / inside-center / inside-left).
SchemaContainerTool reads board-default via resolveBoardTitlePosition(editor)."
```

---

## Task 9: SelectionPanel per-container override

**Files:**
- Create: `apps/frontend/src/settings/sections/ContainerTitlePositionOverrideSection.tsx` (or reuse Task 8 section with different label)
- Modify: `apps/frontend/src/settings/panels/SelectionPanel.tsx`
- Modify: `apps/frontend/src/settings/SettingsPopover.tsx` (wire override callback)

- [ ] **Step 1: Read existing SelectionPanel to understand props shape**

```bash
sed -n '1,80p' apps/frontend/src/settings/panels/SelectionPanel.tsx
```

Note how it handles single vs multi-container selection (look for `counts.containers === 1` or similar).

- [ ] **Step 2: Reuse `ContainerTitlePositionSection` with different title prop**

The component from Task 8 already accepts `title` prop. For SelectionPanel context, pass `title="Заголовок этого контейнера"`. No new component file needed.

- [ ] **Step 3: Add props + render in SelectionPanel**

```tsx
// SelectionPanel.tsx additions:
import { ContainerTitlePositionSection } from "../sections/ContainerTitlePositionSection";

// Add to SelectionPanelProps:
singleContainerTitlePosition?: SchemaContainerTitlePosition;  // undefined → don't render section
onSingleContainerTitlePositionChange?: (next: SchemaContainerTitlePosition) => void;

// In render, where other container-only sections live:
{singleContainerTitlePosition && onSingleContainerTitlePositionChange && (
  <ContainerTitlePositionSection
    current={singleContainerTitlePosition}
    onChange={onSingleContainerTitlePositionChange}
    title="Заголовок этого контейнера"
  />
)}
```

- [ ] **Step 4: Wire single-container detection in SettingsPopover**

In `SettingsPopover.tsx`, compute single-container state from existing selection logic:

```tsx
import type { SchemaContainerShape } from "../shapes/schema-container/SchemaContainerShape";

const singleContainer = useValue(
  "single-container",
  () => {
    const ids = editor.getSelectedShapeIds();
    if (ids.length !== 1) return null;
    const shape = editor.getShape(ids[0]);
    return shape?.type === "schema-container"
      ? (shape as SchemaContainerShape)
      : null;
  },
  [editor],
);

const onSingleContainerTitlePositionChange = (next: SchemaContainerTitlePosition) => {
  if (!singleContainer) return;
  editor.updateShape({
    id: singleContainer.id,
    type: "schema-container",
    props: { titlePosition: next },
  } as never);
};
```

Pass to `<SelectionPanel>`:
```tsx
singleContainerTitlePosition={singleContainer?.props.titlePosition}
onSingleContainerTitlePositionChange={onSingleContainerTitlePositionChange}
```

- [ ] **Step 5: Live verify**

Select single container → SelectionPanel shows section "Заголовок этого контейнера". Toggle → container re-renders with new label position. Select 2+ containers OR non-container → section hidden.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/settings/panels/SelectionPanel.tsx apps/frontend/src/settings/SettingsPopover.tsx
git commit -m "feat(DRW-186): per-container title position override in SelectionPanel

Reuses ContainerTitlePositionSection with different title prop.
Visible only when single container selected; writes props.titlePosition via editor.updateShape."
```

---

## Task 10: Inline label edit (canEdit + intercept double-click)

**Files:**
- Modify: `apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx`
- Create: `apps/frontend/src/shapes/schema-container/SchemaContainerLabel.tsx`

- [ ] **Step 1: Add `canEdit` override**

```ts
// SchemaContainerShapeUtil.tsx
override canEdit(_shape: SchemaContainerShape): boolean {
  return true;
}
```

- [ ] **Step 2: Override `onDoubleClick`**

Per Task 3 probe outcome:
```ts
override onDoubleClick(shape: SchemaContainerShape) {
  this.editor.setEditingShape(shape.id);
  return; // don't allow default child-text creation
}
```

If default behavior persists (probe shows default fires regardless), use `editor.markEventAsHandled` or equivalent — confirm from probe.

- [ ] **Step 3: Implement `SchemaContainerLabel.tsx`**

```tsx
// SchemaContainerLabel.tsx
import { HTMLContainer, useEditor } from "tldraw";
import { useEffect, useRef, useState } from "react";
import type { SchemaContainerShape } from "./SchemaContainerShape";

interface Props {
  shape: SchemaContainerShape;
  isEditing: boolean;
  labelX: number;
  labelY: number;
  labelW: number;
  labelH: number;
  color: string;
  align: "center" | "left";
  variant: "inside" | "outside";
}

export function SchemaContainerLabel({
  shape, isEditing, labelX, labelY, labelW, labelH, color, align, variant,
}: Props) {
  const editor = useEditor();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(shape.props.name);

  useEffect(() => {
    if (isEditing) {
      setDraft(shape.props.name);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isEditing, shape.props.name]);

  const commit = (value: string) => {
    editor.updateShape({
      id: shape.id,
      type: "schema-container",
      props: { name: value },
    } as never);
    editor.setEditingShape(null);
  };
  const discard = () => editor.setEditingShape(null);

  const fontStyle: React.CSSProperties = {
    font: variant === "outside"
      ? '500 14px var(--tl-font-sans, system-ui)'
      : '500 18px var(--tl-font-sans, system-ui)',
    color: variant === "outside" ? "#fff" : color,
  };

  return (
    <HTMLContainer
      style={{
        position: "absolute",
        left: labelX,
        top: labelY,
        width: labelW,
        height: labelH,
        display: "flex",
        alignItems: "center",
        justifyContent: align === "center" ? "center" : "flex-start",
        paddingLeft: align === "left" ? 12 : 0,
        pointerEvents: isEditing ? "all" : "none",
      }}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(draft); }
            else if (e.key === "Escape") { e.preventDefault(); discard(); }
          }}
          onBlur={() => commit(draft)}
          style={{
            ...fontStyle,
            background: "transparent",
            border: "none",
            outline: "1px solid var(--color-selected, #5d5dff)",
            padding: "0 4px",
            width: "calc(100% - 16px)",
            textAlign: align,
          }}
        />
      ) : (
        <div style={{ ...fontStyle, userSelect: "none" }}>{shape.props.name}</div>
      )}
    </HTMLContainer>
  );
}
```

- [ ] **Step 4: Wire into ShapeUtil component()**

In `SchemaContainerShapeUtil.tsx`:
```tsx
override component(shape: SchemaContainerShape) {
  const isEditing = this.editor.getEditingShapeId() === shape.id;
  return shape.props.titlePosition === "outside"
    ? renderOutsideTitle(shape, this.editor, isEditing)
    : renderInsideTitle(shape, this.editor, isEditing);
}
```

Update `renderInsideTitle` / `renderOutsideTitle` to accept `isEditing` and render `<SchemaContainerLabel />` instead of inline `<text>`. (Task 11 finishes this fully; this task just wires the param.)

- [ ] **Step 5: Live verify**

Select container, double-click → input appears at label location. Type → text changes. Esc → reverts. Enter / click-away → commits. Child text shape no longer created.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/shapes/schema-container/
git commit -m "feat(DRW-186): inline label edit on double-click

canEdit returns true; onDoubleClick enters edit mode instead of creating child text.
SchemaContainerLabel renders HTML <input> overlay when editing; Esc discards, Enter/blur commits to props.name."
```

---

## Task 11: Label HTML render (Frame parity font)

**Files:**
- Modify: `apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx`

- [ ] **Step 1: Replace `<text>` in `renderInsideTitle` with `<SchemaContainerLabel>`**

```tsx
function renderInsideTitle(shape: SchemaContainerShape, editor: Editor, isEditing: boolean) {
  const colorMode = useColorMode();
  const { w, h, color, fill, dash, titlePosition } = shape.props;
  const theme = editor.getCurrentTheme();
  const colors = theme.colors[colorMode];
  const colorCss = getColorValue(colors, color, "solid");
  // ... fill / dash logic unchanged for now, fixed in Task 12

  const align = titlePosition === "inside-left" ? "left" : "center";

  return (
    <>
      <SVGContainer style={{ pointerEvents: "all" }}>
        <rect width={w} height={h} fill={fillCss} stroke={colorCss} strokeWidth={2} strokeDasharray={strokeDasharray} rx={4} ry={4} />
      </SVGContainer>
      <SchemaContainerLabel
        shape={shape}
        isEditing={isEditing}
        labelX={0}
        labelY={0}
        labelW={w}
        labelH={INSIDE_LABEL_HEIGHT}
        color={colorCss}
        align={align}
        variant="inside"
      />
    </>
  );
}
```

- [ ] **Step 2: Same for `renderOutsideTitle`**

```tsx
function renderOutsideTitle(shape: SchemaContainerShape, editor: Editor, isEditing: boolean) {
  // ... color / fill setup
  return (
    <>
      <SVGContainer style={{ pointerEvents: "all" }}>
        <rect x={0} y={-BAR_HEIGHT} width={w} height={BAR_HEIGHT} fill={colorCss} rx={4} ry={4} />
        <rect width={w} height={h} fill={fillCss} stroke={colorCss} strokeWidth={2} strokeDasharray={strokeDasharray} rx={4} ry={4} />
      </SVGContainer>
      <SchemaContainerLabel
        shape={shape}
        isEditing={isEditing}
        labelX={0}
        labelY={-BAR_HEIGHT}
        labelW={w}
        labelH={BAR_HEIGHT}
        color="#fff"
        align="center"
        variant="outside"
      />
    </>
  );
}
```

- [ ] **Step 3: Live verify**

Container labels render in tldraw default sans-serif (matches Frame). Inside-center and outside variants visible; inside-left shows label flush-left.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx
git commit -m "feat(DRW-186): label renders via HTML for Frame parity font

Replace hardcoded SVG <text fontSize=20 fontWeight=500> with HTML overlay using --tl-font-sans CSS variable. Inside-center, inside-left, outside variants all use unified label component."
```

---

## Task 12: Fill rendering parity with native rectangle

**Files:**
- Modify: `apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx`

- [ ] **Step 1: Apply Task 2 probe outcome**

Two likely paths (use the one the probe identified):

**Option A — import tldraw fill helpers:**
```tsx
import { useDefaultColorTheme, getFillDef } from "tldraw";  // exact names per probe

function renderInsideTitle(shape, editor, isEditing) {
  const theme = useDefaultColorTheme();
  const { color, fill, w, h } = shape.props;
  // Render <rect fill={getFillUrl(fill, color, theme)} />
}
```

**Option B — replicate native pattern:**
Copy the SVG `<defs>` block from tldraw's `defaultStyleDefs.tsx` and apply `fill={`url(#tl-fill-${fill}-${color})`}`.

- [ ] **Step 2: Visual A/B test**

In browser:
1. Create native rectangle, set color=red, fill=solid.
2. Create SchemaContainer, set color=red, fill=solid.
3. Side-by-side visual check — they should look identical.

Repeat for `semi` and `none`. Capture screenshots before/after fix.

- [ ] **Step 3: Confirm `none` and `semi` still work**

`fill === "none"` should render no fill (transparent). `fill === "semi"` should be slightly translucent (already worked per image 24).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx
git commit -m "fix(DRW-186): fill rendering parity with native rectangle

solid fill now uses tldraw fill defs (matching native <rect> appearance).
Before fix: <rect fill={colorCss}> rendered 100% saturated.
After fix: visually identical to native rect for all 12 colors × {none|semi|solid}."
```

---

## Task 13: Live verification + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run full test suite**

```bash
bun run test
bun test --cwd apps/frontend src
```

Expected: 2095 baseline + new tests (migration ~4, tool registration if TestEditor works ~2, endpoint ~3, title-position helpers ~4 = ~13 added) all green.

- [ ] **Step 2: Chrome DevTools MCP visual checklist**

Per [[feedback-no-subagent-screenshot-trust]] — controller does this, not a subagent.

1. Toolbar: M removed from primary slot; both M + container in overflow popover.
2. Create container via drag from overflow tool → SchemaContainer appears with default size + style.
3. Style inheritance: pick red+dashed+semi in style picker, then drag-create → new container is red/dashed/semi.
4. Double-click label → input appears. Type → text updates. Enter commits. Esc reverts. Click-away commits.
5. Fill side-by-side: native rect vs container for all 12 colors × {none, semi, solid}.
6. BoardPanel "Заголовок контейнеров" section visible; toggle changes board-default. Reload → toggle persists. New container picks current toggle value.
7. SelectionPanel single-container: override section visible. Toggle override → existing container re-renders. Selection of 2+ containers → section hidden.

- [ ] **Step 3: Update CHANGELOG.md**

Add under `## Unreleased`:
```markdown
### Added (DRW-186 — SchemaContainer UX cluster)

- **SchemaContainer creation tool** in native overflow popover (drag-from-corner gesture like Frame). Style defaults inherit from tldraw style picker; title position from board-default.
- **Inline label edit** — double-click on container label enters edit mode (HTML <input> overlay); Esc reverts, Enter/blur commits to props.name. Replaces previous behaviour where double-click created a child text shape.
- **Title position 3-way** — props.titlePosition expanded from `inside`/`outside` to `outside`/`inside-center`/`inside-left`. Legacy `inside` migrates to `inside-center` on shape load.
- **Board-default `room.meta.containerTitlePosition`** — persistent setting applied to new containers; per-container override available in SelectionPanel when single container selected. New endpoint `/api/board/container-title-position` (GET/POST).
- **BoardPanel section "Заголовок контейнеров"** — 3-radio toggle for board-default title position.

### Changed (DRW-186)

- **Toolbar restructure** — M-button removed from primary toolbar slot; M and SchemaContainer tools live exclusively in native overflow popover via `uiOverrides.tools` registration. M hotkey ⌘M unchanged.
- **Label rendering** — SchemaContainer label now uses HTML overlay with `var(--tl-font-sans)` CSS variable for Frame parity, replacing hardcoded SVG `<text fontSize=20 fontWeight=500>`.

### Fixed (DRW-186)

- **Fill rendering** — `fill: "solid"` on SchemaContainer now uses tldraw native fill defs (matching native `<rect>` appearance) instead of direct CSS color. Previous behaviour rendered 100% saturated; new behaviour matches native rectangle visually for all 12 colors.
```

- [ ] **Step 4: Update backlog status to "In Progress"**

```bash
# via mcp tool — handled by controller, not subagent
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(DRW-186): CHANGELOG entry for SchemaContainer UX cluster"
```

---

## Task 14: Phase-end review (controller-driven)

Per CLAUDE.md override: `code-simplifier` pass + single spec+quality review at phase end (NOT between tasks).

- [ ] **Step 1: Run `code-simplifier` subagent across full diff**

```bash
git diff main...HEAD --stat
# Spawn code-simplifier with diff
```

Apply simplifications surgically.

- [ ] **Step 2: Spec + quality review subagent**

Single pass over full diff with spec doc as input. Categorize findings:
- **Spec mismatch** (impl deviates from spec)
- **Quality** (refactor opportunities, missing tests, dead code)

- [ ] **Step 3: Fix findings**

Per [[feedback-batched-reviews]] — apply fixes in a single follow-up commit batch. Each finding gets its own commit if non-trivial; trivial fixes can be bundled.

- [ ] **Step 4: Verify tests pass after fixes**

```bash
bun run test
bun test --cwd apps/frontend src
```

- [ ] **Step 5: Final verification screenshot**

One last visual sanity check matching Task 13 step 2.

- [ ] **Step 6: Backlog → Done**

```bash
# mcp__backlog__task_edit DRW-186 status "Done" + finalSummary
```

- [ ] **Step 7: Squash + merge to main (await user acceptance first)**

Per [[feedback-merge-needs-acceptance]]: do NOT merge before user testing. Wait for explicit user "ок, merge". When approved:

```bash
git checkout feature/drw-186-container-ux
git reset --soft <baseline>
git commit -m "feat(DRW-186): SchemaContainer UX cluster

- A. Toolbar restructure (M moved to overflow popover, container tool added)
- B. SchemaContainerTool drag-from-corner (parity with Frame)
- C. Inline label edit (canEdit + HTML overlay, intercept dbl-click)
- D. Title position 3-way (outside/inside-center/inside-left) + board policy
- E. Fill rendering parity with native rectangle

Tests: <N> pass / 0 fail (+<delta>).

Spec: docs/superpowers/specs/2026-05-27-schema-container-ux-design.md
Plan: docs/superpowers/plans/2026-05-27-schema-container-ux-plan.md"

git checkout main
git merge --no-ff feature/drw-186-container-ux -m "merge: feature/drw-186-container-ux → main (DRW-186)"
git branch -d feature/drw-186-container-ux
```

Update memory `di-draw-project.md` with new HEAD + DRW-186 SHIPPED section.

---

## Self-review pass (completed 2026-05-27)

- [x] Each task has concrete file paths and code snippets (no "implement here" placeholders).
- [x] Tests precede impl in tasks 4–7 (TDD discipline).
- [x] Probe tasks (1, 2, 3) come FIRST, before production code that depends on tldraw API knowledge.
- [x] Migration plan (Task 4) lands BEFORE tool that depends on new enum (Task 5).
- [x] Backend endpoint (Task 7) lands before frontend hook (Task 8) that consumes it.
- [x] BoardPanel UI (Task 8) lands before SelectionPanel override (Task 9) — board-default must exist before per-shape override semantically makes sense.
- [x] Label edit (Task 10) lands before HTML rendering refactor (Task 11) — edit infrastructure first, then visual unification.
- [x] Fill fix (Task 12) AFTER label HTML refactor (Task 11) — avoids merge conflicts in same file.
- [x] Phase-end review (Task 14) explicit per CLAUDE.md override.
- [x] User-acceptance gate explicit before merge per [[feedback-merge-needs-acceptance]].
- [x] Squash-then-no-ff workflow per [[feedback-squash-merge]] in Task 14.
- [x] Function names consistent: `migrateTitlePosition` / `normalizeTitlePosition` / `resolveBoardTitlePosition` — no naming drift.
- [x] `inside-center` and `inside-left` enum values consistent across all 14 tasks.

## Followups (tracked for backlog after DRW-186 ships)

- "Apply title position to all containers" bulk action — out of scope for v0.1.
- DRW-182 `broadcastRoomMeta` extension to include `containerTitlePosition` — needed for cross-tab live sync.
- Factor common pattern between `useBoardStyleDefaults`, `useBoardLayoutParams`, `useBoardContainerTitlePosition` into a generic `useBoardMeta<T>` hook if a 4th board-default emerges.
