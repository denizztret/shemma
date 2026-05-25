# DRW-150: Custom `schema-container` shape — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить `geo + meta.didrawSubgraph` обёртки на native tldraw shape `schema-container` с frame-like behavior, per-container direction (TB/LR/custom), mermaid style support и context-menu UI.

**Architecture:** Frontend регистрирует custom `SchemaContainerShapeUtil extends BaseFrameLikeShapeUtil`. Backend factory `makeSchemaContainerShape` создаёт shape вместо `geo+meta`. `isContainerShape` + `readContainerDirection` имеют dual-path для backwards-compat (legacy `geo+meta.didrawSubgraph` продолжает работать). Pass A пропускает custom direction containers. Auto-flip side-effect handler + context-menu UI.

**Tech Stack:** TypeScript (Bun backend + Vite frontend), tldraw 5.0.0, ELK 0.9.x.

**Spec:** `docs/superpowers/specs/2026-05-25-drw-150-schema-container-shape.md` v0.2.

**Branch:** `feature/drw-150-schema-container` from current `main` (`26040e9` HEAD post-DRW-163).

**Release:** 0.26.0 — bundle DRW-157..163 (unreleased bugs) + DRW-150 (feature) в одном minor bump. Separate 0.25.4 не выпускаем — чище SemVer single transition.

---

## Task 1: Setup branch + verify baseline

**Files:**
- No file changes (git operation only).

- [ ] **Step 1: Create branch from main**

Run: `git checkout main && git log --oneline -1`
Expected: `26040e9 docs: CHANGELOG для DRW-160 + DRW-161 (cluster unreleased)` (or similar HEAD post-DRW-163)

Run: `git checkout -b feature/drw-150-schema-container`
Expected: `Switched to a new branch 'feature/drw-150-schema-container'`

- [ ] **Step 2: Verify test suite baseline**

Run: `bun run test 2>&1 | grep -E "fail|^Ran" | tail -8`
Expected: `0 fail` everywhere, `Ran 109 + 870 + 47 + 217 + 246` (cumulative 1489+ backend; +262 frontend = 1751+).

Run: `bun test --cwd apps/frontend src 2>&1 | tail -3`
Expected: `262 pass, 0 fail`.

- [ ] **Step 3: Commit branch marker (empty)**

Run: `git commit --allow-empty -m "chore(drw-150): start feature/drw-150-schema-container

Baseline: main HEAD 26040e9 (post DRW-157..163 cluster).
Target release: 0.26.0 (bundle bugs + feature)."`

---

## Task 2: Mermaid parser — collect subgraph styles (DRW-162 subsumed)

**Files:**
- Modify: `apps/backend/src/domain/schema/mermaid-parser.ts`
- Modify: `apps/backend/src/domain/schema/mermaid-parser.test.ts`

- [ ] **Step 1: Write failing test for subgraph style collection**

In `apps/backend/src/domain/schema/mermaid-parser.test.ts`, append at end of file (before final `})`):

```ts
test("DRW-162: collects subgraph styles from style directives", () => {
  const src = `flowchart TB
 subgraph INPUT["Вход"]
   SE["SourceEvent"]
 end
 subgraph TRANSPORT["Доставка"]
   AS["AnalyticsSinkProtocol"]
 end
 style INPUT fill:#e3f2fd,stroke:#1565c0,color:#000
 style TRANSPORT fill:#C8E6C9,stroke:#2e7d32
 style SE fill:#fff,stroke:#000
`;
  const r = parseMermaidFlowchart(src, {
    suffixLen: 6,
    existingIds: new Set(),
    generateId: (slug, existing) => `${slug}-xxxxxx` as NodeId,
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.subgraphStyles).toBeDefined();
  expect(r.subgraphStyles.get("INPUT")).toEqual({ fill: "#e3f2fd", stroke: "#1565c0", color: "#000" });
  expect(r.subgraphStyles.get("TRANSPORT")).toEqual({ fill: "#C8E6C9", stroke: "#2e7d32" });
  // Leaf-node styles остаются раздельно
  expect(r.nodeStyles.get("SE")).toBeDefined();
});
```

- [ ] **Step 2: Run failing test**

Run: `bun test apps/backend/src/domain/schema/mermaid-parser.test.ts -t "DRW-162"`
Expected: FAIL — `r.subgraphStyles` is undefined OR doesn't have INPUT key.

- [ ] **Step 3: Implement subgraphStyles in parser**

In `apps/backend/src/domain/schema/mermaid-parser.ts`:

(a) Find `ParseResult` ok-variant type, add field:
```ts
subgraphStyles: Map<string, MermaidNodeStyle>;
```

(b) In parser body where `nodeStyles` is built, add parallel collection:
```ts
const subgraphStyles = new Map<string, MermaidNodeStyle>();
const subgraphNames = new Set<string>();  // collected when subgraph X[...] encountered
// ... existing parse loop ...
// When parsing `style <TOKEN> fill:...`:
//   if subgraphNames.has(token) → subgraphStyles.set(token, parsed);
//   else → nodeStyles.set(token, parsed)  (existing path)
```

(c) Track `subgraphNames` when parsing `subgraph <NAME>[...]` lines.
(d) Return `subgraphStyles` in result ok-variant.

- [ ] **Step 4: Run test to verify pass**

Run: `bun test apps/backend/src/domain/schema/mermaid-parser.test.ts -t "DRW-162"`
Expected: PASS.

- [ ] **Step 5: Run full parser test file (regression)**

Run: `bun test apps/backend/src/domain/schema/mermaid-parser.test.ts`
Expected: All tests pass (including pre-existing DRW-152/153/155 + new DRW-162).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/domain/schema/mermaid-parser.ts apps/backend/src/domain/schema/mermaid-parser.test.ts
git commit -m "feat(drw-162): parser collects subgraph styles separately

style <subgraphName> fill:#... теперь tracking'ся в отдельный
subgraphStyles Map (keyed by subgraph slug), параллельно с nodeStyles
для leaf nodes. Token classifier использует subgraphNames set
(построенный при парсинге 'subgraph X[...]' lines).

DRW-162 subsumed в DRW-150 work. Mermaid-parser change — first task
поскольку backend factory зависит от subgraphStyles.

+1 regression test проверяет collection для multi-subgraph + leaf mix."
```

---

## Task 3: Backend factory — `makeSchemaContainerShape` + style resolver

**Files:**
- Modify: `apps/backend/src/routes/schema.ts`
- Modify: `apps/backend/src/routes/schema.test.ts`

- [ ] **Step 1: Write failing test for new factory output**

In `apps/backend/src/routes/schema.test.ts`, append (после DRW-159 test):

```ts
test("DRW-150: subgraph wrapper создаётся как schema-container shape", async () => {
  const { app, rooms } = makeApp({ inMemory: true });
  const res = await postCreate(app, {
    raw: `flowchart TB
 subgraph INPUT["Вход"]
   SE["SourceEvent"]
 end
 style INPUT fill:#e3f2fd,stroke:#1565c0
`,
  });
  expect(res.status).toBe(200);
  const room = await rooms.get("schema-test");
  // Find the subgraph wrapper shape
  const wrapper = Object.values(room.store.store).find(
    (r: any) => r?.type === "schema-container",
  ) as any;
  expect(wrapper).toBeDefined();
  expect(wrapper.type).toBe("schema-container");
  expect(wrapper.props.name).toBe("Вход");
  expect(wrapper.props.direction).toBe("TB");  // mermaid header
  expect(wrapper.props.titlePosition).toBe("inside");  // default
  // Style: stroke priority — mermaid stroke #1565c0 → tldraw color (blue/light-blue nearest)
  expect(wrapper.props.color).toBeDefined();
  expect(wrapper.props.fill).toBe("semi");  // fill presence → semi mode
  expect(wrapper.props.dash).toBe("dashed");
  // Legacy meta marker сохраняется для backwards-compat
  expect(wrapper.meta.didrawSubgraph).toBe(true);
});
```

- [ ] **Step 2: Run failing test**

Run: `bun test apps/backend/src/routes/schema.test.ts -t "DRW-150"`
Expected: FAIL — `type === "schema-container"` not found (factory still creates `geo`).

- [ ] **Step 3: Add `normalizeDirection` + `resolveSubgraphStyle` helpers**

In `apps/backend/src/routes/schema.ts`, near top imports + helpers section:

```ts
function normalizeDirection(d: "TB" | "LR" | "BT" | "RL" | undefined): "TB" | "LR" {
  if (d === "BT") return "TB";
  if (d === "RL") return "LR";
  if (d === "LR") return "LR";
  return "TB";
}

function resolveSubgraphStyle(s: import("../domain/schema/mermaid-parser").MermaidNodeStyle): {
  color?: string;
  fill?: "semi";
} {
  const out: { color?: string; fill?: "semi" } = {};
  // Priority: stroke first (mermaid stroke = border, tldraw color = border).
  if (s.stroke) out.color = hexToTldrawColor(s.stroke);
  else if (s.fill) out.color = hexToTldrawColor(s.fill);
  if (s.fill) out.fill = "semi";
  return out;
}
```

- [ ] **Step 4: Add `makeSchemaContainerShape` factory**

In `apps/backend/src/routes/schema.ts`, near `makeGroupBoundaryShape`:

```ts
function makeSchemaContainerShape(opts: {
  id?: string;
  name: string;
  parentId: string;
  direction?: "TB" | "LR" | "BT" | "RL";
  style?: import("../domain/schema/mermaid-parser").MermaidNodeStyle;
}): TLRecord {
  const id = opts.id ?? childShapeId();
  const styleProps = opts.style ? resolveSubgraphStyle(opts.style) : {};
  return {
    id,
    typeName: "shape",
    type: "schema-container",
    x: 0,
    y: 0,
    parentId: opts.parentId,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      w: 300,
      h: 200,
      name: opts.name,
      direction: normalizeDirection(opts.direction),
      titlePosition: "inside",
      color: styleProps.color ?? "grey",
      fill: styleProps.fill ?? "semi",
      dash: "dashed",
    },
    meta: {
      didrawSubgraph: true,
      didrawSubgraphName: opts.name,
      didrawSchemaParent: opts.parentId,
    },
  } as TLRecord;
}
```

- [ ] **Step 5: Replace `makeGroupBoundaryShape` calls in POST handler**

In `apps/backend/src/routes/schema.ts`, find call site (around line 632):
- Replace `makeGroupBoundaryShape({...})` → `makeSchemaContainerShape({...style: parseResult.subgraphStyles.get(name)})`.
- Old function `makeGroupBoundaryShape` — keep for now (may be used elsewhere, remove если unused в Task 4 cleanup).

- [ ] **Step 6: Run test to verify pass**

Run: `bun test apps/backend/src/routes/schema.test.ts -t "DRW-150"`
Expected: PASS.

- [ ] **Step 7: Run full schema test file (regression)**

Run: `bun test apps/backend/src/routes/schema.test.ts`
Expected: All tests pass (including DRW-156 services parenting, DRW-159 color, DRW-150 new).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/routes/schema.ts apps/backend/src/routes/schema.test.ts
git commit -m "feat(drw-150): backend creates schema-container instead of geo+meta

POST /api/schema/create теперь создаёт subgraph wrappers как
schema-container shapes (type='schema-container') с typed props
(direction, titlePosition, color, fill, dash) + legacy meta markers
(didrawSubgraph: true) для backwards-compat detection.

normalizeDirection: BT/RL → TB/LR (MVP, full BT/RL в DRW-150.x).
resolveSubgraphStyle: stroke priority over fill для tldraw color
(stroke is border semantically; fill presence → 'semi' mode).

+1 test проверяет factory output."
```

---

## Task 4: Layout integration — dual-path `isContainerShape` + `readContainerDirection`

**Files:**
- Modify: `apps/backend/src/domain/layout.ts`
- Modify: `apps/backend/tests/domain/layout.test.ts`

- [ ] **Step 1: Write failing test for schema-container Pass A skip on custom**

In `apps/backend/tests/domain/layout.test.ts`, append (после DRW-161 test):

```ts
test("DRW-150: schema-container with direction='custom' → Pass A skipped, children preserve positions", async () => {
  const frame = makeShape("shape:e_frame", "frame", { type: "frame", x: 0, y: 0, w: 800, h: 600 });
  // schema-container с custom direction
  const cont = makeShape("shape:e_cont", "cont", {
    type: "schema-container" as any,
    parentId: "shape:e_frame",
    x: 0, y: 0, w: 400, h: 300,
    props: { w: 400, h: 300, name: "cont", direction: "custom", titlePosition: "inside",
             color: "grey", fill: "semi", dash: "dashed" } as any,
  });
  const aShape = makeShape("shape:e_a", "a", { parentId: "shape:e_cont", x: 50, y: 50 });
  const bShape = makeShape("shape:e_b", "b", { parentId: "shape:e_cont", x: 150, y: 200 });
  const s = snapshotWith([frame, cont, aShape, bShape]);
  const idx = rebuildDidrawIndex(s);
  const affectedIds = new Set(["shape:e_frame", "shape:e_cont", "shape:e_a", "shape:e_b"]);
  const r = await runLayout(s, { mode: "layered-tb", scope: "affected", affectedIds }, idx);
  expect(r.reason).toBeUndefined();
  const ns = applyStoreChanges(s, r.batch);
  // Children should preserve their custom positions (50,50) and (150,200) — not re-laid out
  const aAfter = ns.store["shape:e_a"] as { x: number; y: number };
  const bAfter = ns.store["shape:e_b"] as { x: number; y: number };
  expect(aAfter.x).toBe(50);
  expect(aAfter.y).toBe(50);
  expect(bAfter.x).toBe(150);
  expect(bAfter.y).toBe(200);
});
```

- [ ] **Step 2: Add schema-container detection in `isContainerShape`**

In `apps/backend/src/domain/layout.ts`, modify `isContainerShape`:

```ts
function isContainerShape(r: ShapeRec): boolean {
  if (r.type === "frame") return true;
  if (r.type === "schema-container") return true;  // DRW-150
  if (r.type === "geo" && r.meta?.role === "boundary") return true;
  if (r.type === "geo" && r.meta?.didrawSubgraph === true) return true;
  return false;
}
```

- [ ] **Step 3: Add `readContainerDirection` helper**

In `apps/backend/src/domain/layout.ts`, после `MERMAID_DIR_TO_ELK` map:

```ts
function readContainerDirection(container: ShapeRec): string | undefined {
  // DRW-150: new schema-container has typed props.direction
  if (container.type === "schema-container") {
    const d = (container.props as Record<string, unknown> | undefined)?.direction;
    if (d === "custom") return undefined;  // custom — caller checks separately
    if (typeof d === "string") return MERMAID_DIR_TO_ELK[d];
  }
  // Legacy geo + meta
  const subgraphDir = container.meta?.didrawSubgraphDirection;
  if (typeof subgraphDir === "string") return MERMAID_DIR_TO_ELK[subgraphDir];
  return undefined;
}

function isCustomDirection(container: ShapeRec): boolean {
  if (container.type !== "schema-container") return false;
  return (container.props as Record<string, unknown> | undefined)?.direction === "custom";
}
```

- [ ] **Step 4: Update `runPassA` to use `readContainerDirection`**

In `apps/backend/src/domain/layout.ts:runPassA`, replace:
```ts
const subgraphDir = container.meta?.didrawSubgraphDirection;
const elkDir = typeof subgraphDir === "string" ? MERMAID_DIR_TO_ELK[subgraphDir] : undefined;
```
with:
```ts
const elkDir = readContainerDirection(container);
```

- [ ] **Step 5: Add custom skip guards in `runLayoutSubgraph`**

In `apps/backend/src/domain/layout.ts:runLayoutSubgraph`, after Pass A loops setup, before each `await runPassA(...)`:

```ts
// Process top-level anchors
for (const anchorId of topLevelAnchorIds) {
  const anchor = frameById.get(anchorId);
  if (!anchor) continue;
  if (isCustomDirection(anchor)) continue;  // DRW-150: skip custom — preserve manual positions
  // ... existing Pass A logic ...
}

// Process selected containers
for (const sc of topLevelSelectedContainers) {
  if (isCustomDirection(sc)) continue;  // DRW-150
  // ... existing Pass A logic ...
}
```

- [ ] **Step 6: Run test to verify pass**

Run: `bun test apps/backend/tests/domain/layout.test.ts -t "DRW-150"`
Expected: PASS.

- [ ] **Step 7: Run full layout test file (regression)**

Run: `bun test apps/backend/tests/domain/layout.test.ts`
Expected: All tests pass (21+1 = 22).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/domain/layout.ts apps/backend/tests/domain/layout.test.ts
git commit -m "feat(drw-150): layout dual-path для schema-container + custom skip

isContainerShape: новый branch type==='schema-container' рядом с legacy
geo+meta.didrawSubgraph (backwards-compat). readContainerDirection
читает props.direction для нового типа, fallback к meta для legacy.
runPassA использует unified helper.

runLayoutSubgraph: explicit guard isCustomDirection(container) → skip
Pass A loop. Children preserve existing parent-relative positions.

+1 regression test проверяет custom skip semantics."
```

---

## Task 5: Frontend — `SchemaContainerShape` types + props schema

**Files:**
- Create: `apps/frontend/src/shapes/schema-container/SchemaContainerShape.ts`
- Modify: `apps/frontend/src/shapes/schema-container/index.ts` (create as barrel)

- [ ] **Step 1: Create shape directory + types file**

Create `apps/frontend/src/shapes/schema-container/SchemaContainerShape.ts`:

```ts
import {
  DefaultColorStyle,
  DefaultDashStyle,
  DefaultFillStyle,
  RecordProps,
  T,
  TLBaseShape,
  TLDefaultColorStyle,
  TLDefaultDashStyle,
  TLDefaultFillStyle,
} from "tldraw";

export type SchemaContainerDirection = "TB" | "LR" | "custom";
export type SchemaContainerTitlePosition = "inside" | "outside";

export interface SchemaContainerProps {
  w: number;
  h: number;
  name: string;
  direction: SchemaContainerDirection;
  titlePosition: SchemaContainerTitlePosition;
  color: TLDefaultColorStyle;
  fill: TLDefaultFillStyle;
  dash: TLDefaultDashStyle;
}

export type SchemaContainerShape = TLBaseShape<"schema-container", SchemaContainerProps>;

export const schemaContainerShapeProps: RecordProps<SchemaContainerShape> = {
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
  name: T.string,
  direction: T.literalEnum("TB", "LR", "custom"),
  titlePosition: T.literalEnum("inside", "outside"),
  color: DefaultColorStyle,
  fill: DefaultFillStyle,
  dash: DefaultDashStyle,
};

export const DEFAULT_SCHEMA_CONTAINER_PROPS: SchemaContainerProps = {
  w: 300,
  h: 200,
  name: "Container",
  direction: "TB",
  titlePosition: "inside",
  color: "grey",
  fill: "semi",
  dash: "dashed",
};
```

Create barrel `apps/frontend/src/shapes/schema-container/index.ts`:
```ts
export * from "./SchemaContainerShape";
export * from "./SchemaContainerShapeUtil";
```
(Util comes in Task 6.)

- [ ] **Step 2: Commit**

```bash
git add apps/frontend/src/shapes/schema-container/SchemaContainerShape.ts apps/frontend/src/shapes/schema-container/index.ts
git commit -m "feat(drw-150): schema-container shape types + props schema

TLBaseShape<'schema-container', SchemaContainerProps> с typed props
(direction TB/LR/custom, titlePosition inside/outside, color/fill/dash
через standard TLDefault*Style для совместимости со style panel).

schemaContainerShapeProps validator используется при register'е в
shapeUtils массиве (next task)."
```

---

## Task 6: Frontend — `SchemaContainerShapeUtil` + inside render

**Files:**
- Create: `apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx`

- [ ] **Step 1: Create shape util with inside render**

Create `apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx`:

```tsx
import {
  BaseFrameLikeShapeUtil,
  Editor,
  SVGContainer,
  getDefaultColorTheme,
  useIsDarkMode,
} from "tldraw";
import {
  DEFAULT_SCHEMA_CONTAINER_PROPS,
  SchemaContainerShape,
  schemaContainerShapeProps,
} from "./SchemaContainerShape";

export class SchemaContainerShapeUtil extends BaseFrameLikeShapeUtil<SchemaContainerShape> {
  static override type = "schema-container" as const;
  static override props = schemaContainerShapeProps;

  override getDefaultProps() {
    return { ...DEFAULT_SCHEMA_CONTAINER_PROPS };
  }

  override component(shape: SchemaContainerShape) {
    return shape.props.titlePosition === "outside"
      ? renderOutsideTitle(shape, this.editor)
      : renderInsideTitle(shape, this.editor);
  }

  override getIndicatorPath(shape: SchemaContainerShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}

function renderInsideTitle(shape: SchemaContainerShape, editor: Editor) {
  const { w, h, name, color, fill, dash } = shape.props;
  const isDark = false;  // simplification — useIsDarkMode hook не доступен вне component func
  const theme = getDefaultColorTheme({ isDarkMode: isDark });
  const colorCss = theme[color].solid;
  const fillCss = fill === "none" ? "transparent" : fill === "solid" ? colorCss : `${colorCss}33`;
  const strokeDasharray =
    dash === "dashed" ? "8 4" : dash === "dotted" ? "1 4" : dash === "draw" ? undefined : undefined;

  return (
    <SVGContainer style={{ pointerEvents: "all" }}>
      <rect
        width={w}
        height={h}
        fill={fillCss}
        stroke={colorCss}
        strokeWidth={2}
        strokeDasharray={strokeDasharray}
        rx={4}
        ry={4}
      />
      <text
        x={w / 2}
        y={28}
        textAnchor="middle"
        fontSize={20}
        fontWeight={500}
        fill={colorCss}
        style={{ userSelect: "none" }}
      >
        {name}
      </text>
    </SVGContainer>
  );
}

function renderOutsideTitle(shape: SchemaContainerShape, editor: Editor) {
  // Placeholder — frame-bar style render. Implemented в Task 7.
  // Fallback to inside для совместимости пока.
  return renderInsideTitle(shape, editor);
}
```

- [ ] **Step 2: Verify no compile errors**

Run: `cd apps/frontend && bunx tsc --noEmit 2>&1 | tail -20`
Expected: 0 errors related to schema-container files. (TS may complain про unused `editor` arg в outside placeholder — accept as TODO.)

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx
git commit -m "feat(drw-150): SchemaContainerShapeUtil extends BaseFrameLikeShapeUtil

Inherits frame-like behavior:
- isFrameLike() = true (clipping, full-brush selection)
- onDragShapesIn/Out — reparent to/from container
- providesBackgroundForChildren = true
- canReceiveNewChildrenOfType = !locked

Inside render: rectangle с dashed border, semi fill, title по center-top
(y=28 ≈ font 20 + padding). Outside placeholder = inside в этой task'е,
proper outside рендер в Task 7."
```

---

## Task 7: Frontend — outside title render variant

**Files:**
- Modify: `apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx`

- [ ] **Step 1: Replace `renderOutsideTitle` with frame-bar implementation**

Replace placeholder function in `SchemaContainerShapeUtil.tsx`:

```tsx
function renderOutsideTitle(shape: SchemaContainerShape, _editor: Editor) {
  const { w, h, name, color, fill, dash } = shape.props;
  const theme = getDefaultColorTheme({ isDarkMode: false });
  const colorCss = theme[color].solid;
  const fillCss = fill === "none" ? "transparent" : fill === "solid" ? colorCss : `${colorCss}33`;
  const strokeDasharray =
    dash === "dashed" ? "8 4" : dash === "dotted" ? "1 4" : undefined;
  const BAR_HEIGHT = 28;

  return (
    <SVGContainer style={{ pointerEvents: "all" }}>
      {/* Outside title bar — rendered ABOVE the shape body (y negative) */}
      <rect
        x={0}
        y={-BAR_HEIGHT}
        width={w}
        height={BAR_HEIGHT}
        fill={colorCss}
        rx={4}
        ry={4}
      />
      <text
        x={w / 2}
        y={-BAR_HEIGHT / 2 + 6}
        textAnchor="middle"
        fontSize={16}
        fontWeight={500}
        fill="#fff"
        style={{ userSelect: "none" }}
      >
        {name}
      </text>
      {/* Body */}
      <rect
        width={w}
        height={h}
        fill={fillCss}
        stroke={colorCss}
        strokeWidth={2}
        strokeDasharray={strokeDasharray}
        rx={4}
        ry={4}
      />
    </SVGContainer>
  );
}
```

- [ ] **Step 2: Verify compile**

Run: `cd apps/frontend && bunx tsc --noEmit 2>&1 | grep -i "error" | head -5`
Expected: no errors mentioning schema-container.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx
git commit -m "feat(drw-150): outside title bar render variant

Frame-bar above shape (negative y), full-width color background,
white text centered. 28px height. Toggle через props.titlePosition.

Default остаётся 'inside' для совместимости с user expectation per
brainstorm 2026-05-25. Outside заложен для future setting."
```

---

## Task 8: Frontend — register shape util в App.tsx

**Files:**
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: Import SchemaContainerShapeUtil and pass as shapeUtils**

In `apps/frontend/src/App.tsx`, find imports section near top, add:
```ts
import { SchemaContainerShapeUtil } from "./shapes/schema-container";
```

Find `<Tldraw>` mount (line ~673), add `shapeUtils` prop:
```tsx
<Tldraw
  shapeUtils={[SchemaContainerShapeUtil]}
  onMount={(ed) => {
    setEditor(ed);
    if (import.meta.env.DEV) {
      (window as any).__editor = ed;
    }
  }}
  components={tldrawComponents}
/>
```

- [ ] **Step 2: Smoke test — frontend builds without runtime error**

Run: `cd apps/frontend && bun run build 2>&1 | tail -10`
Expected: build success, no errors.

(Alternative if no build script: skip — bun's vite dev would catch errors at runtime.)

- [ ] **Step 3: Run frontend tests**

Run: `bun test --cwd apps/frontend src 2>&1 | tail -3`
Expected: All pass (262, no regressions).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/App.tsx
git commit -m "feat(drw-150): register SchemaContainerShapeUtil в <Tldraw>

shapeUtils prop добавлен с SchemaContainerShapeUtil. Tldraw editor
теперь знает про 'schema-container' type → может render'ить +
управлять drag-reparent / resize / clipping out of the box."
```

---

## Task 9: Frontend — auto-flip side-effect handler

**Files:**
- Create: `apps/frontend/src/shapes/schema-container/SchemaContainerAutoFlip.ts`
- Modify: `apps/frontend/src/App.tsx`
- Create: `apps/frontend/src/shapes/schema-container/SchemaContainerAutoFlip.test.ts`

- [ ] **Step 1: Write failing test for auto-flip**

Create `apps/frontend/src/shapes/schema-container/SchemaContainerAutoFlip.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Editor, TLShapeId, createTLStore, defaultShapeUtils } from "tldraw";
import { SchemaContainerShapeUtil } from "./SchemaContainerShapeUtil";
import { registerAutoFlipDirection } from "./SchemaContainerAutoFlip";

describe("DRW-150 auto-flip", () => {
  let editor: Editor;
  let cleanup: () => void;

  beforeEach(() => {
    const store = createTLStore({
      shapeUtils: [...defaultShapeUtils, SchemaContainerShapeUtil],
    });
    editor = new Editor({
      store,
      shapeUtils: [...defaultShapeUtils, SchemaContainerShapeUtil],
      tools: [],
      getContainer: () => document.createElement("div"),
    });
    cleanup = registerAutoFlipDirection(editor);
  });

  afterEach(() => {
    cleanup?.();
    editor?.dispose();
  });

  test("user drag leaf inside schema-container → direction flips to custom", () => {
    const containerId = "shape:cont1" as TLShapeId;
    const leafId = "shape:leaf1" as TLShapeId;

    editor.createShapes([
      {
        id: containerId,
        type: "schema-container",
        x: 0,
        y: 0,
        props: { w: 300, h: 200, name: "C", direction: "TB", titlePosition: "inside",
                 color: "grey", fill: "semi", dash: "dashed" },
      },
      {
        id: leafId,
        type: "geo",
        parentId: containerId,
        x: 50,
        y: 50,
        props: { geo: "rectangle", w: 100, h: 60, color: "blue", fill: "semi",
                 dash: "draw", size: "m", font: "draw", align: "middle",
                 verticalAlign: "middle", growY: 0, url: "", scale: 1,
                 labelColor: "black", richText: { type: "doc", content: [] } } as any,
      },
    ]);

    // Simulate user drag — updateShape with explicit history (mimics pointer drag)
    editor.updateShapes([{ id: leafId, type: "geo", x: 80, y: 70 }]);

    const container = editor.getShape(containerId) as any;
    expect(container.props.direction).toBe("custom");
  });

  test("programmatic (non-user) update — direction NOT flipped", () => {
    const containerId = "shape:cont2" as TLShapeId;
    const leafId = "shape:leaf2" as TLShapeId;

    editor.createShapes([
      { id: containerId, type: "schema-container", x: 0, y: 0,
        props: { w: 300, h: 200, name: "C", direction: "TB", titlePosition: "inside",
                 color: "grey", fill: "semi", dash: "dashed" } },
      { id: leafId, type: "geo", parentId: containerId, x: 50, y: 50,
        props: { geo: "rectangle", w: 100, h: 60, color: "blue", fill: "semi",
                 dash: "draw", size: "m", font: "draw", align: "middle",
                 verticalAlign: "middle", growY: 0, url: "", scale: 1,
                 labelColor: "black", richText: { type: "doc", content: [] } } as any },
    ]);

    // Programmatic update via mergeRemoteChanges (simulates AI / WS path)
    editor.store.mergeRemoteChanges(() => {
      editor.updateShapes([{ id: leafId, type: "geo", x: 80, y: 70 }]);
    });

    const container = editor.getShape(containerId) as any;
    expect(container.props.direction).toBe("TB");  // unchanged
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (module doesn't exist)**

Run: `bun test --cwd apps/frontend src/shapes/schema-container/SchemaContainerAutoFlip.test.ts`
Expected: ERR — Cannot find module "./SchemaContainerAutoFlip".

- [ ] **Step 3: Create auto-flip module**

Create `apps/frontend/src/shapes/schema-container/SchemaContainerAutoFlip.ts`:

```ts
import type { Editor, TLShape } from "tldraw";
import type { SchemaContainerProps, SchemaContainerShape } from "./SchemaContainerShape";

/**
 * DRW-150: When user manually drags a child shape inside a schema-container,
 * auto-flip the parent's direction to "custom" — preserving user's manual
 * positioning on next autolayout pass.
 *
 * Only user-source changes trigger flip. Remote/programmatic updates (AI,
 * WS sync, mergeRemoteChanges) are ignored.
 */
export function registerAutoFlipDirection(editor: Editor): () => void {
  return editor.store.sideEffects.registerAfterChangeHandler(
    "shape",
    (prev: TLShape, next: TLShape, source: "user" | "remote") => {
      if (source !== "user") return;
      // Skip arrow + schema-container itself
      if (next.type === "arrow") return;
      if (next.type === "schema-container") return;
      // Only position change (skip resize / props / etc.)
      const positionChanged = prev.x !== next.x || prev.y !== next.y;
      if (!positionChanged) return;
      // Parent must remain the same container (not a reparent event)
      if (next.parentId !== prev.parentId) return;
      if (!next.parentId?.startsWith("shape:")) return;
      const parent = editor.getShape(next.parentId);
      if (parent?.type !== "schema-container") return;
      const props = parent.props as SchemaContainerProps;
      if (props.direction === "custom") return;
      // Flip → custom
      editor.updateShape<SchemaContainerShape>({
        id: parent.id,
        type: "schema-container",
        props: { ...props, direction: "custom" },
      });
    },
  );
}
```

- [ ] **Step 4: Register in App.tsx onMount**

In `apps/frontend/src/App.tsx`, update `onMount`:

```tsx
import { SchemaContainerShapeUtil, registerAutoFlipDirection } from "./shapes/schema-container";

// ... inside <Tldraw>:
onMount={(ed) => {
  setEditor(ed);
  registerAutoFlipDirection(ed);  // DRW-150 auto-flip
  if (import.meta.env.DEV) {
    (window as any).__editor = ed;
  }
}}
```

Also update the barrel `index.ts`:
```ts
export * from "./SchemaContainerShape";
export * from "./SchemaContainerShapeUtil";
export * from "./SchemaContainerAutoFlip";
```

- [ ] **Step 5: Run test to verify pass**

Run: `bun test --cwd apps/frontend src/shapes/schema-container/SchemaContainerAutoFlip.test.ts`
Expected: 2 pass.

- [ ] **Step 6: Run full frontend suite**

Run: `bun test --cwd apps/frontend src 2>&1 | tail -3`
Expected: 264 pass (262 baseline + 2 new), 0 fail.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/shapes/schema-container/SchemaContainerAutoFlip.ts apps/frontend/src/shapes/schema-container/SchemaContainerAutoFlip.test.ts apps/frontend/src/shapes/schema-container/index.ts apps/frontend/src/App.tsx
git commit -m "feat(drw-150): auto-flip direction='custom' при manual child drag

registerAutoFlipDirection(editor) — store side-effect handler reagирует
на shape position changes с source='user'. Если parent — schema-container
и его props.direction !== 'custom', flip'ает направление в 'custom'.

Programmatic (mergeRemoteChanges) updates НЕ trigger flip — это важно для
AI patches и WS sync paths.

+2 теста: user drag flips; programmatic update — нет."
```

---

## Task 10: Frontend — context-menu UI для direction toggle

**Files:**
- Modify: `apps/frontend/src/chrome/TldrawComponents.tsx` (или existing overrides location)
- Create: `apps/frontend/src/shapes/schema-container/SchemaContainerActions.ts`
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: Find existing TLUiOverrides structure**

Run: `grep -rn "TLUiOverrides\|overrides\b" apps/frontend/src | head -10`

Identify the file where overrides are merged (likely `App.tsx` or `chrome/TldrawComponents.tsx`).

- [ ] **Step 2: Create direction actions module**

Create `apps/frontend/src/shapes/schema-container/SchemaContainerActions.ts`:

```ts
import type { Editor, TLUiActionsContextType } from "tldraw";
import type { SchemaContainerDirection, SchemaContainerProps, SchemaContainerShape } from "./SchemaContainerShape";

const DIRECTIONS: SchemaContainerDirection[] = ["TB", "LR", "custom"];

export function setSchemaContainerDirection(editor: Editor, direction: SchemaContainerDirection): void {
  const targets = editor.getSelectedShapes().filter((s) => s.type === "schema-container");
  if (targets.length === 0) return;
  for (const t of targets) {
    const props = t.props as SchemaContainerProps;
    if (props.direction === direction) continue;
    editor.updateShape<SchemaContainerShape>({
      id: t.id,
      type: "schema-container",
      props: { ...props, direction },
    });
  }
  // Trigger immediate layout pass via backend (если direction !== custom)
  if (direction !== "custom") {
    triggerLayoutSelection(editor, targets.map((t) => t.id));
  }
}

async function triggerLayoutSelection(editor: Editor, containerIds: string[]): Promise<void> {
  // Read space + room from current URL
  const url = new URL(window.location.href);
  const space = url.searchParams.get("space") ?? "default";
  const room = url.searchParams.get("room") ?? "default";
  try {
    await fetch(
      `/api/layout/selection?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ affectedIds: containerIds }),
      },
    );
  } catch {
    // Non-fatal: user can manually trigger via Cmd+Shift+L
  }
}

export function buildSchemaContainerActions(
  editor: Editor,
  baseActions: TLUiActionsContextType,
): TLUiActionsContextType {
  return {
    ...baseActions,
    "schema-container-direction-tb": {
      id: "schema-container-direction-tb",
      label: "Direction: Top → Bottom",
      readonlyOk: false,
      onSelect() { setSchemaContainerDirection(editor, "TB"); },
    },
    "schema-container-direction-lr": {
      id: "schema-container-direction-lr",
      label: "Direction: Left → Right",
      readonlyOk: false,
      onSelect() { setSchemaContainerDirection(editor, "LR"); },
    },
    "schema-container-direction-custom": {
      id: "schema-container-direction-custom",
      label: "Direction: Custom (manual)",
      readonlyOk: false,
      onSelect() { setSchemaContainerDirection(editor, "custom"); },
    },
  };
}
```

- [ ] **Step 3: Wire context menu override**

In appropriate overrides location (App.tsx or chrome), add:

```tsx
import { menuGroup, menuItem, menuSubmenu, TLUiOverrides } from "tldraw";
import { buildSchemaContainerActions } from "./shapes/schema-container/SchemaContainerActions";

const schemaContainerOverrides: TLUiOverrides = {
  actions(editor, actions) {
    return buildSchemaContainerActions(editor, actions);
  },
  contextMenu(editor, schema, helpers) {
    const selected = editor.getSelectedShapes();
    const containers = selected.filter((s) => s.type === "schema-container");
    if (containers.length === 0) return schema;
    const actions = helpers.actions;
    return menuGroup(
      "schema-container-direction-group",
      menuSubmenu(
        "schema-container-direction-submenu",
        "Direction",
        menuItem(actions["schema-container-direction-tb"]),
        menuItem(actions["schema-container-direction-lr"]),
        menuItem(actions["schema-container-direction-custom"]),
      ),
    )(schema);
  },
};
```

Pass to `<Tldraw>` as `overrides={schemaContainerOverrides}` (merge with existing overrides if any).

- [ ] **Step 4: Update barrel export**

`apps/frontend/src/shapes/schema-container/index.ts`:
```ts
export * from "./SchemaContainerShape";
export * from "./SchemaContainerShapeUtil";
export * from "./SchemaContainerAutoFlip";
export * from "./SchemaContainerActions";
```

- [ ] **Step 5: Verify frontend tests still pass**

Run: `bun test --cwd apps/frontend src 2>&1 | tail -3`
Expected: 264 pass.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/shapes/schema-container/SchemaContainerActions.ts apps/frontend/src/shapes/schema-container/index.ts apps/frontend/src/App.tsx
git commit -m "feat(drw-150): context-menu Direction submenu для schema-container

3 actions: Direction TB, Direction LR, Direction Custom (manual).
Setting direction → updateShape props.direction + trigger immediate
layout pass через POST /api/layout/selection (если !== custom).

Context menu submenu видим только когда selected shapes contain
schema-container."
```

---

## Task 11: Verify backend `/api/layout/selection` exists / is compatible

**Files:**
- Inspect: `apps/backend/src/routes/layout-selection.ts`

- [ ] **Step 1: Verify endpoint exists**

Run: `grep -rn "/api/layout/selection\|layoutSelection" apps/backend/src/routes`
Expected: route file found.

- [ ] **Step 2: Verify request shape matches frontend call**

Read `apps/backend/src/routes/layout-selection.ts`. Confirm POST endpoint accepts `{ affectedIds: string[] }` in body.

- [ ] **Step 3: If endpoint signature differs, adapt frontend OR backend**

If endpoint requires e.g. `selectedIds` instead of `affectedIds`:
- Adapt `SchemaContainerActions.ts:triggerLayoutSelection` body to match.

If endpoint missing entirely:
- Document gap as Q1 from spec. Implement minimal endpoint (POST /api/layout/selection → calls `runLayout` with `scope: "affected", affectedIds`).

- [ ] **Step 4: Smoke-test endpoint via curl**

Run: `curl -s -X POST "http://localhost:8787/api/layout/selection?space=di-draw&room=drw-150-test" -H "Content-Type: application/json" -d '{"affectedIds":["shape:test"]}' | head -c 200`
Expected: structured JSON response (likely empty layout since room/ids fake).

- [ ] **Step 5: Commit any backend adjustments**

If changes made:
```bash
git add apps/backend/src/routes/layout-selection.ts
git commit -m "fix(drw-150): align /api/layout/selection с frontend call signature"
```

If no changes — skip commit.

---

## Task 12: E2E manual verification

**Files:**
- No code — manual test.

- [ ] **Step 1: Restart backend on feature branch**

Run: `kill $(lsof -i :8787 -t -sTCP:LISTEN) 2>/dev/null; SHEMMA_PROFILE=release bun apps/backend/src/index.ts > /tmp/shemma-backend-drw150.log 2>&1 &`
Wait 5s.

Run: `curl -s http://localhost:8787/api/health`
Expected: version reflects feature branch HEAD.

- [ ] **Step 2: Open browser tab on fresh test room**

Navigate (via chrome-devtools MCP or user-side): `http://localhost:8787/?space=di-draw&room=drw-150-e2e`.

- [ ] **Step 3: Import user's EventDispatch schema via shemmaImportMermaid**

In browser console (or via evaluate_script):
```js
await window.shemmaImportMermaid(`---
config:
  layout: elk
---
flowchart TB
 subgraph INPUT["Вход"]
   SE["SourceEvent"]
 end
 subgraph TRANSPORT["Доставка"]
   direction LR
   AS["AnalyticsSinkProtocol"]
   DS["DelegateSinkProtocol"]
 end
 SE --> AS
 SE --> DS
 style INPUT fill:#e3f2fd,stroke:#1565c0
 style TRANSPORT fill:#C8E6C9,stroke:#2e7d32
`);
```

- [ ] **Step 4: Verify shape types and colors**

In console:
```js
window.editor.getCurrentPageShapes().filter(s => s.type === 'schema-container').map(s => ({
  name: s.props.name, dir: s.props.direction, color: s.props.color, fill: s.props.fill,
}))
```
Expected: 2 schema-container shapes, "Вход" с direction='TB', "Доставка" с direction='LR'. Colors mapped from mermaid stroke (different per subgraph).

- [ ] **Step 5: Verify frame-like resize**

In editor UI, select the "Доставка" container, drag a corner handle to enlarge.
Expected: AS and DS shapes inside DON'T scale — stay at original size; container box grows.

- [ ] **Step 6: Verify drag-to-reparent**

In editor UI, drag a standalone shape onto "Доставка" container.
Expected: shape becomes child (visible by indicator highlight on container during drag, and shape's parentId after drop equals container id).

- [ ] **Step 7: Verify auto-flip**

In editor UI, drag AS within "Доставка" container to a new position.
In console: `window.editor.getCurrentPageShapes().find(s => s.props?.name === 'Доставка').props.direction`
Expected: `"custom"`.

- [ ] **Step 8: Verify context-menu Direction toggle**

Right-click on "Вход" container → context menu → Direction submenu → "Left → Right".
In console: same query → expect `direction === "LR"`. Children re-laid out horizontally.

- [ ] **Step 9: Document outcome in commit**

Run:
```bash
git commit --allow-empty -m "test(drw-150): E2E verification passed

- Mermaid import создаёт schema-container shapes (frame-like).
- direction inherits из mermaid header + subgraph direction.
- Mermaid style fill/stroke → color/fill props.
- Resize не cascades children.
- Drag-to-reparent works.
- Manual leaf drag flips direction → 'custom'.
- Context-menu Direction submenu toggles direction + triggers re-layout."
```

---

## Task 13: CHANGELOG + release commit + tag

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json` (version bump)

- [ ] **Step 1: Update CHANGELOG**

In `CHANGELOG.md`, replace the "Unreleased" section with:

```markdown
## 0.26.0 — 2026-05-25 — DRW-150 schema-container + DRW-157..163 visual-fidelity cluster

### Added
- **DRW-150** — Custom tldraw shape `schema-container` заменяет `geo + meta.didrawSubgraph` обёртки. Frame-like behavior (resize не масштабирует children, drag-to-reparent). Typed props: `direction (TB/LR/custom)`, `titlePosition (inside/outside)`, plus standard TLDefault*Style для color/fill/dash. Per-container direction toggle через context-menu. Manual leaf drag → direction auto-flip to "custom". Backwards-compat: existing rooms с `geo+meta` обёртками продолжают работать (dual-path в layout integration). DRW-162 (subgraph styles from mermaid) subsumed.

### Fixed (preceeding bug cluster, also released in this bundle)
- **DRW-163** — Container top padding 40 → 72px (avoid title/first-row overlap).
- **DRW-161** — Pass A `buildPassAEdges` с lift'ом cross-subgraph endpoints до container level (chain ranking restored).
- **DRW-160** — autolayout уважает mermaid `flowchart TB/LR/BT/RL` direction (был hardcoded `layered-lr`).
- **DRW-159** — `makeFrameShape` добавил `props.color: "black"` для tldraw v5 валидации (ValidationError на WS apply path).
- **DRW-158** — Virtual chain edges для disconnected children с direction override (LR direction без internal edges раскладывал вертикально).
- **DRW-157** — `isContainerShape` детектит mermaid subgraph wrappers через `meta.didrawSubgraph`.

### Tests
- +N тестов across all packages. Backend 1500+, frontend 264+.
- E2E manual verified на user's EventDispatch schema.
```

(Adjust test counts to actual after Step 2.)

- [ ] **Step 2: Get final test counts**

Run: `bun run test 2>&1 | grep -E "^Ran" | tail -8`
Run: `bun test --cwd apps/frontend src 2>&1 | tail -3`

Note totals, update CHANGELOG numbers.

- [ ] **Step 3: Bump version**

In `package.json`:
```json
"version": "0.26.0"
```

Also in any sub-packages with version field (check `apps/backend/package.json` etc.).

Run: `grep -rln "\"version\":" apps packages 2>/dev/null | xargs grep -l "0.25"`
Update each to `"version": "0.26.0"`.

- [ ] **Step 4: Final full test suite**

Run: `bun run test 2>&1 | grep -E "fail|^Ran" | tail -10`
Expected: 0 fail everywhere.

Run: `bun test --cwd apps/frontend src 2>&1 | tail -3`
Expected: 0 fail.

- [ ] **Step 5: Commit release**

```bash
git add CHANGELOG.md package.json apps/*/package.json packages/*/package.json
git commit -m "release: 0.26.0 — DRW-150 schema-container + DRW-157..163 visual-fidelity cluster"
```

- [ ] **Step 6: Merge to main**

```bash
git checkout main
git merge --no-ff feature/drw-150-schema-container -m "merge: feature/drw-150-schema-container → main (0.26.0)"
git branch -d feature/drw-150-schema-container
```

- [ ] **Step 7: Tag**

```bash
git tag 0.26.0
git log --oneline -5
```

Expected: tag on release commit, history shows merge.

---

## Self-review checklist (run after writing all tasks)

1. **Spec coverage** — each AC-1..AC-14 in spec maps to at least one task above. ✓
   - AC-1: T5 (shape registration props)
   - AC-2: T3 (factory)
   - AC-3 / AC-4: T6 (extends BaseFrameLikeShapeUtil — inherited behavior); T12 E2E verifies
   - AC-5: T4 (direction read + Pass A skip)
   - AC-6: T9 (auto-flip)
   - AC-7: T10 (context-menu + immediate re-layout)
   - AC-8: T2 + T3 (parser subgraphStyles + factory resolver)
   - AC-9: T3 (factory `direction: normalizeDirection(opts.direction)`)
   - AC-10: T5 (standard TLDefault*Style props)
   - AC-11: T4 (dual-path); T12 E2E может проверить если есть legacy room
   - AC-12: T5 + T7 (titlePosition prop + outside render)
   - AC-13: T2, T3, T4, T9 (each adds tests)
   - AC-14: T13 (release)

2. **Placeholder scan** — `// ...` only в `// existing Pass A logic ...` references (intentional — pointer to existing code). No "TBD" / "TODO" / "fill in later". ✓

3. **Type consistency** — `SchemaContainerProps` used same way in all tasks. `direction` enum consistent. ✓

---

**End of Plan.**
