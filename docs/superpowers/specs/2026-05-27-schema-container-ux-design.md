# SchemaContainer UX cluster — Design Spec

**Version:** v0.1
**Date:** 2026-05-27
**Backlog:** DRW-186
**Status:** Draft → review → execute

## Goal

Complete the SchemaContainer UX feedback loop: manual creation, inline label edit, native-parity title position settings, and visual fidelity for fill rendering. Parallel concern — toolbar restructure (M-button relocation).

## Motivation

After DRW-180 (frame+container direction/layout) and DRW-181 (style propagation), SchemaContainer reached feature parity with Frame for layout/style — but **UX gaps surfaced in live testing**:

1. **No creation path.** Container can only be created by duplicating an existing one. New users cannot bootstrap a board.
2. **Double-click broken.** Double-click on the label currently creates a child text shape inside the container (default tldraw behavior for frame-like shapes), instead of editing the title.
3. **Fill mismatch.** `fill: "solid"` renders 100% saturated (image 23 in conversation), whereas native tldraw `<rect>` with `solid` fill draws a translucent overlay (image 25). Visual fidelity broken.
4. **No title-position board policy.** Each container independently carries `titlePosition`. There is no way to enforce uniform "all containers in this board show title outside / inside-center / inside-left" — and `inside-left` doesn't exist yet.

Plus a parallel toolbar concern surfaced in the screenshot: M-button currently lives in **both** primary toolbar slot and overflow popover. User wants it only in the overflow popover, with SchemaContainer creation tool added next to it.

## Scope

### In scope

1. **Toolbar restructure** (sub-feature A)
   - Remove M-button from primary toolbar slot.
   - Register both M-tool and SchemaContainer-tool via `uiOverrides.tools`. Both appear in native overflow popover.

2. **SchemaContainer creation tool** (sub-feature B)
   - Custom `StateNode` subclass with drag-from-corner gesture (parity with `FrameShapeTool`).
   - Default props inherit from tldraw style picker state (color/fill/dash).
   - Title position of new container = `room.meta.containerTitlePosition` (board-default).

3. **Inline label edit** (sub-feature C)
   - `canEdit()` returns true.
   - Double-click intercepted: enters edit mode instead of creating child text shape.
   - HTML overlay `<input>` at label position; commits to `props.name` on Esc/Enter/blur.
   - Label rendered with tldraw default sans-serif font (parity with Frame), not hardcoded SVG style.

4. **Title position 4-way + board policy** (sub-feature D — extended in phase 2)
   - Props enum extended: `titlePosition: "outside-frame" | "outside-banner" | "inside-center" | "inside-left"`.
     - `outside-frame` — native tldraw Frame parity (neutral white/panel bg, dark text, top-left aligned, ~13px).
     - `outside-banner` — coloured banner above body with **monolith corners** (banner top corners rounded, body bottom corners rounded, no gap between).
     - `inside-center` — label inside body top, centered, shape-color text.
     - `inside-left` — label inside body top, left-aligned (12px padding), shape-color text.
   - Migrations:
     - Phase 1 (`/1`): legacy `"inside"` → `"inside-center"`.
     - Phase 2 (`/2`): legacy `"outside"` → `"outside-banner"` (visual совпадает с phase-1 outside).
   - Persistent `room.meta.containerTitlePosition` (board-default).
   - BoardPanel: section "Заголовок контейнеров" with 4-toggle UI (`Frame / Баннер / Центр / Слева`).
   - SelectionPanel: per-container override (only when a single container is selected).
   - Resolution chain at creation time: `room.meta.containerTitlePosition` → `props.titlePosition`. At render time: `props.titlePosition` always wins.

5. **Fill rendering parity** (sub-feature E)
   - Replace direct `<rect fill={colorCss}>` for `fill: "solid"` with native-equivalent rendering.
   - Investigation step (Plan Task 2): probe tldraw 5.x `getFillDef` / `useDefaultColorTheme` exports OR replicate native `<GeoShapeUtil>` fill SVG logic.
   - After fix: `none`/`semi`/`solid` visually match native rectangle (validation via side-by-side screenshot).

### Out of scope

- **Font selector** — deferred. SchemaContainer label uses tldraw default sans-serif font (no `props.font`). Rationale: Frame doesn't have font selector either; uniform-look is the policy.
- **Pattern fill (4th mode)** — not currently supported by SchemaContainer; add only if fill-parity fix requires it. Otherwise scope-creep.
- **Migration of `room.meta.containerTitlePosition` over WS broadcast** — falls under [[di-draw-project:DRW-182]] (broadcastRoomMeta no-op). Not blocking; per-tab sync via reload OR explicit refetch is acceptable.

## Architecture

### Sub-feature A: Toolbar restructure

**Current state** (`apps/frontend/src/chrome/TldrawComponents.tsx:168-202`):
- `Toolbar` component wraps `<DefaultToolbar>` and appends `<button>M</button>` as a sibling of `<DefaultToolbarContent />`. Tldraw's `OverflowingToolbar` may move it to overflow when there's no room, but it also keeps it in primary slot when there is.

**Target state**:
- M-button removed from `Toolbar` children.
- Both M-tool and SchemaContainer-tool registered via `<Tldraw overrides={uiOverrides}>` where `uiOverrides.tools` returns a record of `TLUiToolItem` entries.
- `Toolbar` becomes a thin pass-through: `<DefaultToolbar><DefaultToolbarContent/></DefaultToolbar>` — no custom children.
- Default tldraw overflow algorithm distributes tools between primary slots and overflow popover; custom tools (M, container) naturally land in overflow because they're not "preferred" tools.

**Tldraw 5.x reference**: `uiOverrides.tools` is a function `(editor, tools, helpers) => tools` that returns extended `tools` record. Each tool item has `id`, `label`, `icon`, `kbd`, `onSelect`, plus optional `meta`. Icons are registered separately via `assetUrls.icons[<key>]`.

**Icon assets**:
- M-tool: use string letter "M" as SVG (no asset file needed) OR provide a 16×16 SVG icon. Provisional: SVG with `<text>M</text>` baked in.
- SchemaContainer-tool: SVG matching the visual in the screenshot — outlined rectangle with double-stroke or container-glyph. Provisional: 16×16 SVG with `<rect>` + `<rect>` (nested) suggesting "container".

### Sub-feature B: SchemaContainer creation tool

**Pattern**: subclass `StateNode` like tldraw's internal `FrameShapeTool` (cannot import — it's not in public API; must replicate from docs). Two child states:
- `Idle` — pointer down → enter `Pointing`.
- `Pointing` — pointer move (drag threshold) → start drag-create with initial bounds; pointer up before threshold → no-op.

On drag-create:
```ts
const { originPagePoint, currentPagePoint } = editor.inputs;
const id = createShapeId();
const bounds = Box.FromPoints([originPagePoint, currentPagePoint]);
editor.createShape({
  id,
  type: "schema-container",
  x: bounds.x,
  y: bounds.y,
  props: {
    w: bounds.w,
    h: bounds.h,
    name: "Container",
    direction: "TB",
    titlePosition: resolveBoardTitlePosition(editor),  // ← from room.meta
    color: editor.getStyleForNextShape(DefaultColorStyle) as TLDefaultColorStyle,
    fill: editor.getStyleForNextShape(DefaultFillStyle) as TLDefaultFillStyle,
    dash: editor.getStyleForNextShape(DefaultDashStyle) as TLDefaultDashStyle,
  },
});
```

After drag completes: `editor.setCurrentTool("select")` and select the new shape (parity with Frame).

**Style inheritance**: `editor.getStyleForNextShape(<style-prop>)` reads the current style picker selection. This mirrors native behavior — when user picks "red + dashed + semi", the next created shape gets those defaults.

**Title position resolution**: helper `resolveBoardTitlePosition(editor)` reads `room.meta.containerTitlePosition` (stored in tldraw `documentSettings.meta` OR our backend `room.meta`). Spec §Title position resolution below details storage.

### Sub-feature C: Inline label edit

**Current state**: `SchemaContainerShapeUtil` doesn't override `canEdit()`. Tldraw's default behavior for frame-like shapes is to allow inserting child shapes on double-click. Hence text shape appears.

**Target state**:
- Override `canEdit(): boolean { return true; }`.
- `component()` reads `this.editor.getEditingShapeId() === shape.id`; when true, renders an HTML `<input>` overlay positioned at the label area; otherwise renders the static label.
- Edit overlay positioned via `<HTMLContainer>` (tldraw's helper for HTML-in-canvas-space).
- Commit logic:
  - Esc → discard edit, restore previous `props.name`.
  - Enter → commit current input value to `props.name`, exit edit mode.
  - Blur → same as Enter (commit + exit).
- After exit: `editor.setEditingShape(null)`.
- Double-click intercept: `BaseFrameLikeShapeUtil.onDoubleClick` likely fires the default "create child" — override `onDoubleClick(shape: SchemaContainerShape)` in `SchemaContainerShapeUtil` to call `editor.setEditingShape(shape.id)` instead. Verify in plan Task 3 probe.

**Label rendering for parity with Frame**:
- Current SVG `<text fontSize={20} fontWeight={500}>...` is replaced with `<HTMLContainer>` wrapping a `<div>` styled with tldraw's standard label CSS (font: `var(--tl-font-sans, sans-serif)`, size matching Frame's label).
- For `titlePosition: "outside-frame" | "outside-banner"` — label HTML rendered above the body, mirroring current SVG layout but as DOM.
- For `inside-center` / `inside-left` — label HTML inside the body at top, with `text-align: center` or `text-align: left`.

### Sub-feature D: Title position 4-way + board policy

**Schema changes** (phase 2):
- `SchemaContainerProps.titlePosition`: `"outside-frame" | "outside-banner" | "inside-center" | "inside-left"` (phase 1 had `"outside" | "inside-center" | "inside-left"`).
- `schemaContainerShapeProps.titlePosition`: `T.literalEnum("outside-frame", "outside-banner", "inside-center", "inside-left")`.
- `DEFAULT_SCHEMA_CONTAINER_PROPS.titlePosition`: stays `"inside-center"`.

**Migrations** (sequence в `SchemaContainerMigrations.ts`):
- `/1` — legacy `"inside"` → `"inside-center"` (phase 1).
- `/2` — legacy `"outside"` → `"outside-banner"` (phase 2). Визуал phase-1 outside был coloured banner — поэтому миграция семантически no-op для пользователя; новые контейнеры выбирают между `outside-frame` (neutral) и `outside-banner` (coloured).
- Final defensive coerce — unknown values → `"inside-center"`.
- Backward shape load (room snapshots persisted to disk via @shemma/backend) must pass через оба step'а.

**Render-layer**:
- `outside-frame`: ТОЛЬКО body rect (с shape-color stroke и body fill); label плавает над body как plain HTML overlay без bg/outline. Text — `var(--tl-color-text)`, top-left aligned, 13px sans (native tldraw Frame parity per user feedback image 29). Никакого encompassing outline'а — это ключевое отличие от banner-варианта.
- `outside-banner`: monolith outline + saturated colour banner fill (top corners rounded only) + body fill (bottom corners rounded only) — single rounded outer stroke без gap'а между баннером и телом. Text — `#fff`, центр, 13px. Реализовано через два `<path>` (banner top portion + body bottom portion, square borders в стыке) + один `<rect>` outline сверху с `rx=4`.
- `inside-center` / `inside-left`: rect body + HTML label overlay внутри сверху, 13px, цвет shape'а.

**Backend persistence**:
- `room.meta.containerTitlePosition: "outside-frame" | "outside-banner" | "inside-center" | "inside-left" | null` (null = unset, defaults to `"inside-center"`).
- GET `/api/board/container-title-position?space=...&room=...` → `{ value: "..." | null }`.
- POST `/api/board/container-title-position` body `{ value: "..." | null }` → persists to `room.meta`, broadcast via WS (per `broadcastRoomMeta` if available; see DRW-182 note).
- Backend lives alongside existing `/api/board/style-defaults` (DRW-181) and `/api/board/layout-params` endpoints. Same pattern.

**Frontend resolution chain**:
- **At creation time** (sub-feature B): tool reads board-default via cached `useBoardContainerTitlePosition(space, room)` hook; sets `props.titlePosition` directly. After creation, props is the SSOT for that container's rendering.
- **At render time** (sub-feature C component): `props.titlePosition` is the only source — no resolution chain. Per-shape value is the SSOT once written.
- **Per-container override** (SelectionPanel UI): writes `props.titlePosition` directly to the selected shape. Same as DRW-180 per-frame direction.

**UI**:
- `BoardPanel/sections/ContainerTitlePositionSection.tsx`: 3-toggle button row. Reads/writes via `useBoardContainerTitlePosition` hook. Always visible.
- `SelectionPanel/sections/ContainerTitlePositionSection.tsx`: same 3-toggle UI; visible only when `counts.containers === 1` (single-container selection). Writes `props.titlePosition` of selected shape via WS-batched POST.

**Reuse**:
- Hook `useBoardContainerTitlePosition` shape parallels `useBoardStyleDefaults` (DRW-181) and `useBoardLayoutParams` (DRW-180). Probe Plan Task 6 will confirm exact pattern.

### Sub-feature E: Fill rendering parity

**Current bug**:
```ts
const fillCss =
  fill === "none" ? "transparent"
  : fill === "solid" ? colorCss                            // ← 100% saturated
  : getColorValue(colors, color, "semi");                  // semi
```

`colorCss = getColorValue(colors, color, "solid")` returns the **fully saturated** hex (e.g. red `#e03131`). When applied as SVG `fill`, the rect renders 100% solid — too saturated.

**Native tldraw behavior** (verified visually in conversation image 25):
- `fill: "solid"` for `<rect>` renders with a **translucent-ish darker tint** — likely uses the saturated color but with reduced opacity (e.g. 50–70%), OR uses a separate `pattern.solid` SVG definition with built-in opacity.

**Investigation step** (Plan Task 2 — probe):
- Read tldraw source: `node_modules/tldraw/src/lib/shapes/shared/defaultStyleDefs.tsx` (or wherever `getFillDef` lives).
- Determine the right import path and helper signature.
- Replicate native rendering in `renderInsideTitle` / `renderOutsideTitle`.

**Likely solution**:
- Import tldraw's fill SVG `<defs>` (pattern + solid) into our `SchemaContainerShapeUtil` and apply `fill={`url(#${fillId})`}` instead of direct CSS color.
- OR import `getFillDef` helper and consume the same `<defs>` block via `editor.svgDefs`.

Implementation deferred to plan Task 2 probe outcome.

## Title position resolution (detailed)

### Three-layer scope (extended in phase 3 / frame-scope)

| Layer | Setting key | Effect on existing containers | Effect on new containers |
|---|---|---|---|
| Board (BoardPanel) | `room.meta.containerTitlePosition` | None (no retroactive update) | Default for NEW containers created outside a Frame, or inside a Frame that has no scope-override |
| Frame (SelectionPanel @ single Frame) | `frame.meta.didrawContainerTitlePosition` | **Bulk-apply**: writes the chosen value into `props.titlePosition` of all existing SchemaContainer children of this Frame | Default for NEW containers created inside this Frame (overrides board-default) |
| Per-container (SelectionPanel @ single Container) | `shape.props.titlePosition` | The container itself | Not applicable (this IS the per-shape value) |

The Frame itself does NOT change visually — `didrawContainerTitlePosition` is a "scope memo" that influences (a) bulk-apply at the moment of UI change and (b) inheritance for newly-created child SchemaContainers. The Frame remains a native tldraw Frame; only SchemaContainer children take part in the title-position scope.

### Resolution at creation time (new SchemaContainer)

`resolveTitlePositionForNew(editor, parentId?)` (in `title-position-board.ts`) walks the chain nearest-first:

1. If `parentId` resolves to a Frame with string `meta.didrawContainerTitlePosition` → use that (coerced via `normalizeTitlePosition`).
2. Else use `room.meta.containerTitlePosition` (board-default), coerced.
3. Else fall back to `"inside-center"`.

The board-level `getDefaultProps()` path remains via `resolveBoardTitlePosition(editor)` (no parent context); frame inheritance is applied via `editor.sideEffects.registerBeforeCreateHandler("shape", ...)` (`registerContainerTitlePositionInherit`), which knows `shape.parentId` at the moment of commit and overrides `props.titlePosition` if the parent Frame carries the memo.

### Resolution at render time

| Source | When read | Priority |
|---|---|---|
| `shape.props.titlePosition` | Render time | **Always wins** (SSOT for that container) |

Frame `meta.didrawContainerTitlePosition` is **not** consulted at render time — it is purely a creation-time / bulk-apply trigger.

**Important**: Board-default and Frame-default are **NOT** dynamic per-render. Changing board-default does **NOT** retroactively flip existing containers (per original spec). Changing the Frame-default DOES bulk-apply once to the current children at the moment of the UI change (and updates the memo for future creations), but after that, each container's `props.titlePosition` is independent again.

This avoids a coordination layer (no need for `containerTitlePosition: null` sentinel meaning "inherit").

## Edge cases

| Case | Behaviour |
|---|---|
| Migration from pre-DRW-186 room (props has `"inside"`) | Migration to `"inside-center"` on load (step `/1`) |
| Migration from DRW-186 phase 1 room (props has `"outside"`) | Migration to `"outside-banner"` on load (step `/2`); визуал не меняется |
| Migration sees unknown value | Coerce to `"inside-center"` (defensive) |
| User picks color/fill/dash, then drag-creates → check defaults | Tool reads `editor.getStyleForNextShape` at drag-start, snapshot to props |
| Edit mode + selection change | Esc-equivalent: commit, exit edit, allow selection change |
| Edit mode + window blur | Commit + exit (same as input blur) |
| Edit mode + Backspace on empty input | Allowed — `props.name = ""` is valid; render falls back to "Container" placeholder ONLY in render (not stored) |
| Tool active + click on existing shape | Tool ignores click; user can drag in empty area only OR cancel via Esc |
| Concurrent edit + remote update of same shape | Last-write-wins; OK for v0.1, formal CRDT is out of scope |
| BoardPanel toggle changes value → existing containers | **Do NOT** retroactively update (per design above). UI shows board-default for "next created"; per-container override always wins for existing ones |

## Testing strategy

| Layer | What is tested | Type |
|---|---|---|
| Unit (frontend) | Migration `"inside"` → `"inside-center"`; unknown → `"inside-center"` | Pure function |
| Unit (frontend) | `resolveBoardTitlePosition(editor)` reads `room.meta` cache correctly | Pure function via mocked editor |
| Unit (frontend) | Label edit commit/discard semantics (Esc / Enter / blur) | Pure helper if extractable; otherwise component test |
| Integration (frontend) | Tool registration — `editor.getTool("schema-container")` resolves; activating tool sets state to schema-container.idle | Editor instance test |
| Integration (frontend) | drag-create on empty area produces shape with correct props (style defaults + board title pos) | Editor instance test |
| Integration (backend) | GET/POST `/api/board/container-title-position` round-trip persists to room.meta | HTTP test |
| Visual (manual) | Side-by-side native rectangle vs SchemaContainer for fill `none/semi/solid`, all 12 colors | Chrome DevTools MCP screenshot |
| Visual (manual) | Label edit UX — double-click → input appears → type → Esc/Enter | Chrome DevTools MCP |
| Visual (manual) | Toolbar — M removed from primary; M + container both in overflow popover | Chrome DevTools MCP screenshot |

## Implementation file map

### New files
- `apps/frontend/src/shapes/schema-container/SchemaContainerTool.ts` — StateNode subclass with drag-from-corner.
- `apps/frontend/src/shapes/schema-container/SchemaContainerLabelEditor.tsx` — HTML input overlay component.
- `apps/frontend/src/shapes/schema-container/SchemaContainerToolIcon.svg` (or inline TSX) — 16×16 SVG icon for overflow popover.
- `apps/frontend/src/shapes/schema-container/SchemaContainerMigrations.ts` — tldraw `defineMigrations` config.
- `apps/frontend/src/board-panel/sections/ContainerTitlePositionSection.tsx` — 3-toggle UI.
- `apps/frontend/src/selection-panel/sections/ContainerTitlePositionSection.tsx` — same but per-shape.
- `apps/frontend/src/hooks/useBoardContainerTitlePosition.ts` — board-meta CRUD hook.
- `apps/frontend/src/ui-overrides.ts` — `uiOverrides` and `assetUrls` constants.

### Modified files
- `apps/frontend/src/shapes/schema-container/SchemaContainerShape.ts` — `titlePosition` enum expansion, default to `inside-center`.
- `apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx` — `canEdit`, `onDoubleClick`, `migrations`, label render via HTML, fill fix.
- `apps/frontend/src/chrome/TldrawComponents.tsx` — remove M-button inline, pass-through Toolbar.
- `apps/frontend/src/App.tsx` — register tools via `<Tldraw tools={...} overrides={...}>`, register `onMermaidImport` callback via tool action instead of inline button.
- `apps/frontend/src/board-panel/BoardPanel.tsx` — add `ContainerTitlePositionSection`.
- `apps/frontend/src/selection-panel/SelectionPanel.tsx` — conditional render `ContainerTitlePositionSection`.
- `apps/backend/src/routes/board/container-title-position.ts` — NEW endpoint (mirror style-defaults shape).
- `apps/backend/src/routes/index.ts` — wire new endpoint into router.

## Followups (out of scope; track for backlog)

- **"Apply title position to all containers"** action in BoardPanel — bulk update existing containers when board policy changes.
- **Migration for `room.meta.containerTitlePosition`** — if persisted before this feature ships, no-op (since key didn't exist).
- **Tooling**: factor common `uiOverrides.tools` registration pattern into a helper if a third custom tool emerges.
- **DRW-182 broadcastRoomMeta** — add `containerTitlePosition` to broadcast keys when DRW-182 lands.

## Self-review pass (completed 2026-05-27)

- [x] Spec uses `inside-center` / `inside-left` consistently (not `centerInside` / `leftInside`).
- [x] Migration plan covers both forward (read old) and unknown-value cases — defensive coerce added.
- [x] Toolbar plan addresses both removing M from primary AND keeping it accessible in overflow.
- [x] Fill investigation step in plan as Task 2 probe — not buried in design.
- [x] Resolution chain is "creation-time-only" — explicit "Important" callout in §Title position resolution.
- [x] Test plan covers migration (unit test for `inside` → `inside-center` and unknown coercion).
- [x] No font-selector references leaked from earlier brainstorm — only "deferred" mention in §Out of scope.
- [x] Migrations: confirmed no existing migrations on SchemaContainer — this is the first one.

## Related

- DRW-180 — per-frame direction/layout params; SAME resolution-chain pattern (creation-time + per-shape override).
- DRW-181 — board-default style propagation; SAME endpoint structure (`/api/board/<name>`).
- DRW-182 — `broadcastRoomMeta` no-op gap; followup for cross-tab sync of board defaults.
- DRW-185 — pin auto-toggle pattern (state-machine listener + pure helpers), reused for label-edit commit/discard if extractable.
- ADR-0005 — react() state-machine listener pattern; potentially reused for editing-state detection.
