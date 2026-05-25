# DRW-150: Custom tldraw shape `schema-container` — Design Spec

**Status:** Draft v0.1 (2026-05-25)
**Target release:** 0.26.0
**Author session:** continuation of post-DRW-149 cluster, brainstormed 2026-05-25

## 1. Goals & Non-goals

### 1.1 Goals
- Заменить `geo + meta.didrawSubgraph=true` обёртки на отдельный tldraw shape тип `schema-container`.
- Получить **frame-like behavior**: resize контейнера не масштабирует children; drag shape over container reparent'ит её; drag out — to page.
- Per-container layout **direction** (`TB` / `LR` / `custom`) с auto-flip на `custom` при manual user-drag ребёнка.
- Subgraph fill/stroke из mermaid `style <subgraphName> ...` директив (раньше игнорировались).
- Поддержать стандартные tldraw style controls (color / fill / dash) через standard `TLDefault*Style` props.

### 1.2 Non-goals (отдельные/future tickets)
- `direction: "BT" | "RL"` — P1 в DRW-150.x (после MVP).
- Arrow style toggle (curved ↔ orthogonal) — отдельная задача, упомянута в DRW-150 backlog, не в этой phase.
- Custom UI panel (Miro-style multi-shape settings) — отдельная задача.
- Migration старых комнат — skip (backwards-compat: `geo+meta.didrawSubgraph` продолжает детектиться `isContainerShape`).

## 2. Background & Motivation

Сейчас (после DRW-134 / DRW-156 / DRW-157):
- Subgraph wrappers создаются как `geo` rectangles с `meta.role="boundary"` + `meta.didrawSubgraph=true` + дополнительными meta-полями (`didrawSubgraphName`, `didrawSubgraphDirection`).
- `geo` shape — обычная фигура tldraw. При resize tldraw scales children **пропорционально** (built-in tldraw behavior). User: *"эти сейчас полностью растягивают свое содержимое если увеличивать их размер"*.
- Mermaid `style INPUT fill:#e3f2fd,...` не применяется к этим wrappers (DRW-162) — wrappers получают hardcoded `color:"grey", fill:"semi"`.
- Direction задаётся только через `meta.didrawSubgraphDirection`, read-only (нельзя поменять после import).

Решение: новый custom shape — наследует frame behavior, имеет typed direction prop, fill/color props mapping в `TLDefault*Style`.

## 3. Architecture

### 3.1 Shape registration (frontend)

`apps/frontend/src/shapes/schema-container/SchemaContainerShape.ts`:

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
} from 'tldraw'

export type SchemaContainerDirection = 'TB' | 'LR' | 'custom'
export type SchemaContainerTitlePosition = 'inside' | 'outside'

export interface SchemaContainerProps {
  w: number
  h: number
  name: string
  direction: SchemaContainerDirection
  titlePosition: SchemaContainerTitlePosition
  color: TLDefaultColorStyle
  fill: TLDefaultFillStyle
  dash: TLDefaultDashStyle
}

export type SchemaContainerShape = TLBaseShape<'schema-container', SchemaContainerProps>

export const schemaContainerShapeProps: RecordProps<SchemaContainerShape> = {
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
  name: T.string,
  direction: T.literalEnum('TB', 'LR', 'custom'),
  titlePosition: T.literalEnum('inside', 'outside'),
  color: DefaultColorStyle,
  fill: DefaultFillStyle,
  dash: DefaultDashStyle,
}
```

`apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx`:

```ts
import { BaseFrameLikeShapeUtil, HTMLContainer, SVGContainer, TLResizeInfo } from 'tldraw'

export class SchemaContainerShapeUtil extends BaseFrameLikeShapeUtil<SchemaContainerShape> {
  static override type = 'schema-container' as const
  static override props = schemaContainerShapeProps

  override getDefaultProps(): SchemaContainerProps {
    return {
      w: 300, h: 200, name: 'Container',
      direction: 'TB', titlePosition: 'inside',
      color: 'grey', fill: 'semi', dash: 'dashed',
    }
  }

  override component(shape: SchemaContainerShape) {
    return shape.props.titlePosition === 'outside'
      ? renderOutsideTitle(shape, this.editor)
      : renderInsideTitle(shape, this.editor)
  }

  override getIndicatorPath(shape: SchemaContainerShape) {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }
}
```

Register в `<Tldraw shapeUtils={[SchemaContainerShapeUtil, ...]}>` в frontend entry (apps/frontend/src/canvas/Canvas.tsx или подобном).

### 3.2 Backend factory

`apps/backend/src/routes/schema.ts` — заменить `makeGroupBoundaryShape` на `makeSchemaContainerShape`:

```ts
function makeSchemaContainerShape(opts: {
  id?: string
  name: string
  parentId: string
  direction?: 'TB' | 'LR' | 'BT' | 'RL'
  style?: MermaidNodeStyle  // DRW-153 type (fill/stroke hex)
}): TLRecord {
  // Map mermaid hex → tldraw style (DRW-153 helper).
  const styleProps = opts.style ? resolveSubgraphStyle(opts.style) : {}

  return {
    id: opts.id ?? childShapeId(),
    typeName: 'shape',
    type: 'schema-container',
    x: 0, y: 0,
    parentId: opts.parentId,
    index: 'a1',
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      w: 300, h: 200,
      name: opts.name,
      direction: normalizeDirection(opts.direction),  // BT→TB, RL→LR для MVP
      titlePosition: 'inside',
      color: styleProps.color ?? 'grey',
      fill: styleProps.fill ?? 'semi',
      dash: 'dashed',
    },
    meta: {
      // Legacy markers сохраняем для backwards-compat detection в isContainerShape.
      didrawSubgraph: true,
      didrawSubgraphName: opts.name,
      didrawSchemaParent: opts.parentId,
    },
  } as TLRecord
}
```

**Normalize direction** для MVP: BT → TB, RL → LR (с warning в log если получили BT/RL — добавить полную поддержку в DRW-150.x).

**Style resolution:**
```ts
function resolveSubgraphStyle(s: MermaidNodeStyle): Partial<SchemaContainerProps> {
  const out: Partial<SchemaContainerProps> = {}
  if (s.fill) out.color = hexToTldrawColor(s.fill)       // border = fill (по DRW-153 pattern)
  if (s.fill) out.fill = 'semi'                           // у нас всегда semi fill, hex выбирает color
  if (s.stroke && !s.fill) out.color = hexToTldrawColor(s.stroke)
  return out
}
```

### 3.3 Mermaid parser update

`apps/backend/src/domain/schema/mermaid-parser.ts`:
- Сейчас `nodeStyles` / `nodeStylesByNodeId` собирает `style <leafNode> fill:...`.
- Расширить: парсить `style <subgraphName> fill:...` (uppercase ID matching subgraph name) и эмитить отдельный `subgraphStyles: Map<string, MermaidNodeStyle>` keyed by subgraph slug.
- `routes/schema.ts` при build'е group actions передаёт `subgraphStyles.get(name)` в `makeSchemaContainerShape`.

### 3.4 Layout integration

`apps/backend/src/domain/layout.ts`:
- `isContainerShape(s)`: добавить branch `s.type === "schema-container"`. Legacy `geo + meta.didrawSubgraph` сохраняется (backwards-compat).
- `runPassA` direction lookup:

```ts
function readContainerDirection(container: ShapeRec): string | undefined {
  // New schema-container: props.direction
  if (container.type === 'schema-container') {
    const d = container.props?.direction
    if (d === 'custom') return undefined  // skip Pass A — preserve manual positions
    if (typeof d === 'string') return MERMAID_DIR_TO_ELK[d]
  }
  // Legacy geo + meta
  const subgraphDir = container.meta?.didrawSubgraphDirection
  if (typeof subgraphDir === 'string') return MERMAID_DIR_TO_ELK[subgraphDir]
  return undefined
}
```

- **Custom direction → skip Pass A**: если `props.direction === "custom"`, в `runLayoutSubgraph` пропускаем этот container в Pass A loop. Children сохраняют existing positions (parent-relative, не trogаем). Pass B всё ещё видит container как leaf node с current size.

### 3.5 Auto-flip mechanism (frontend)

`apps/frontend/src/shapes/schema-container/SchemaContainerAutoFlip.ts`:

```ts
export function registerAutoFlipDirection(editor: Editor) {
  return editor.store.sideEffects.registerAfterChangeHandler('shape', (prev, next, source) => {
    if (source !== 'user') return  // skip remote/AI changes
    if (prev.type !== next.type) return
    if (next.type === 'arrow' || next.type === 'schema-container') return

    // Position change of a shape whose parent is schema-container?
    const positionChanged = prev.x !== next.x || prev.y !== next.y
    if (!positionChanged) return
    if (next.parentId === prev.parentId && next.parentId.startsWith('shape:')) {
      const parent = editor.getShape(next.parentId)
      if (parent?.type === 'schema-container') {
        // Auto-flip parent.props.direction → 'custom'
        if ((parent.props as SchemaContainerProps).direction !== 'custom') {
          editor.updateShape({
            id: parent.id,
            type: 'schema-container',
            props: { ...parent.props, direction: 'custom' },
          })
        }
      }
    }
  })
}
```

Caveat: side effect handler сам триггерит updateShape — нужно guard от рекурсии (the `source` сравнение спасает, потому что updateShape с tldraw source='programmatic', not 'user').

### 3.6 Context menu UI

`apps/frontend/src/canvas/overrides.ts` (или existing):

```ts
const overrides: TLUiOverrides = {
  actions(editor, actions) {
    return {
      ...actions,
      'schema-container-direction-tb': {
        id: 'schema-container-direction-tb',
        label: 'Direction: Top → Bottom',
        readonlyOk: false,
        onSelect() {
          setSchemaContainerDirection(editor, 'TB')
        },
      },
      'schema-container-direction-lr': {
        id: 'schema-container-direction-lr',
        label: 'Direction: Left → Right',
        readonlyOk: false,
        onSelect() {
          setSchemaContainerDirection(editor, 'LR')
        },
      },
      'schema-container-direction-custom': {
        id: 'schema-container-direction-custom',
        label: 'Direction: Custom (manual)',
        readonlyOk: false,
        onSelect() {
          setSchemaContainerDirection(editor, 'custom')
        },
      },
    }
  },
  contextMenu(editor, schema, helpers) {
    // Append Direction sub-menu when selected shapes include schema-container
    const selected = editor.getSelectedShapes()
    const containers = selected.filter(s => s.type === 'schema-container')
    if (containers.length === 0) return schema
    return menuGroup('direction-submenu', [
      menuSubmenu('schema-container-direction', 'Direction', [
        menuItem(actions['schema-container-direction-tb']),
        menuItem(actions['schema-container-direction-lr']),
        menuItem(actions['schema-container-direction-custom']),
      ])
    ])(schema)
  },
}

function setSchemaContainerDirection(editor: Editor, direction: 'TB' | 'LR' | 'custom') {
  const targets = editor.getSelectedShapes().filter(s => s.type === 'schema-container')
  for (const t of targets) {
    editor.updateShape({ id: t.id, type: 'schema-container', props: { ...t.props, direction } })
  }
  // Optionally trigger immediate layout pass для selected containers
  if (direction !== 'custom') triggerLayoutSelection(editor, targets.map(t => t.id))
}
```

После изменения direction → optional immediate layout: вызов backend `/api/layout?scope=affected&affectedIds=<container>` (или local через `runLayout` если есть frontend variant).

### 3.7 Title rendering — inside vs outside

```tsx
function renderInsideTitle(shape: SchemaContainerShape, editor: Editor) {
  const { w, h, name, color, fill, dash } = shape.props
  return (
    <SVGContainer>
      <rect
        width={w} height={h}
        fill={getFillCss(fill, color)}
        stroke={getColorCss(color)}
        strokeDasharray={getDashArray(dash)}
        rx={4} ry={4}
      />
      <text
        x={w / 2}
        y={28}                          // ≈ 24px font + padding
        textAnchor="middle"
        fontSize={20}
        fontWeight={500}
        fill={getColorCss(color)}
      >
        {name}
      </text>
    </SVGContainer>
  )
}

function renderOutsideTitle(shape: SchemaContainerShape, editor: Editor) {
  // Body + header bar above (frame-style).
  // Header bar: -28px above shape, full width, label centered.
  // ...
}
```

Точный pixel-perfect рендеринг — детали в plan.

## 4. Data Flow

```
mermaid raw
  → parseMermaidFlowchart (DRW-152, +DRW-162 subgraphStyles)
  → SchemaActions[] (schema-group includes direction + style)
  → routes/schema.ts applySchemaActions
  → makeSchemaContainerShape(name, direction, style)
  → store.added — schema-container shape
  → bus.publish → frontend WS
  → editor.store.applyDiff (after DRW-159 fix)
  → SchemaContainerShapeUtil.component() рендерит
  → user drag → editor.store.sideEffects.afterChange → auto-flip direction='custom'
  → user right-click → context menu Direction → updateShape props.direction
  → layout pass (manual или auto) → runPassA reads container.props.direction
```

## 5. Edge Cases & Concerns

### 5.1 Schema migration (v2 already shipped)
Existing v2 rooms содержат `type:"geo" + meta.didrawSubgraph=true` wrappers. Backwards-compat: `isContainerShape` ОБА типа поддерживает; runPassA direction lookup ОБА путя. Никакой shape type migration не делается. **Импортированные mermaid в новые комнаты** получают `schema-container`. **Импорты в существующие v2 комнаты** также создают новый `schema-container` тип; старые `geo+meta` wrappers (созданные до 0.26.0) сохраняются в той же комнате side-by-side — допустимо, layout/render оба пути одинаково работают.

### 5.2 Auto-flip recursion
Side-effect handler триггерит `updateShape` с source='programmatic'. Сравнение `if (source !== 'user') return` спасает от рекурсии. Проверить в test.

### 5.3 Style fill conflict с tldraw color
TLDraw `color` = border + label color. `fill` = enum (none/semi/solid/pattern). Hex из mermaid `fill:#e3f2fd` мапится в nearest TLDefaultColorStyle (DRW-153 logic). Это даёт colored border + semi-fill (translucent). Точное соответствие mermaid (where fill is BG, stroke is border) не достижимо в TLDraw 5.x palette без custom rendering. Принимаем приближение.

**Альтернатива (P2):** не использовать TLDefault*Style; иметь полные hex props (`fillHex: string`, `strokeHex: string`) с custom render. Но тогда теряем standard tldraw style panel — user feedback negative.

### 5.4 Custom direction после mermaid import
Если mermaid задаёт `direction LR`, новый wrapper получает `direction: 'LR'`. После import user может вручную перетащить child → direction auto-flip → 'custom'. Это intended.

### 5.5 Layout integration с custom
`runPassA` skip если `direction === 'custom'`. Pass B всё ещё видит container как leaf node с current `w/h`. Pass B layout'ит positions container'а среди sibling containers, но не лезет внутрь. Children сохраняют existing parent-relative coords.

### 5.6 BaseFrameLikeShapeUtil canResize
По default `BaseBoxShapeUtil.canResize() = true`. Resize cascading determined `onResize` — base implementation only updates w/h, не trogает children. Это default frame-like resize. Не override'им.

### 5.7 Locked container
`canReceiveNewChildrenOfType(shape) = !shape.isLocked` — наследуем. Locked → не reparent (стандарт frame).

## 6. Test Strategy

### 6.1 Backend tests
- `schema.test.ts`: POST /api/schema/create → mermaid с subgraph → batch.added содержит shape `type === 'schema-container'`, `props.direction === <mermaid direction>`, `props.name === <subgraph label>`.
- `schema.test.ts` style: `style INPUT fill:#e3f2fd` → schema-container получает соответствующий `color/fill`.
- `layout.test.ts`: schema-container с `direction:"custom"` → Pass A skip; children preserve positions.
- `mermaid-parser.test.ts`: парсер эмитит `subgraphStyles` map.

### 6.2 Frontend tests
- `SchemaContainerShapeUtil.test.tsx` (новый): shape registration + rendering snapshot.
- Auto-flip: симуляция user drag → `editor.updateShape` (source=user) → parent.props.direction → 'custom'.
- Context menu: simulating right-click + selecting "Direction: LR" → updateShape called.

### 6.3 Integration / E2E
- Manual: import mermaid с subgraph LR → resize container → children не масштабируются → drag external shape into container → reparent → drag child manually → direction auto-flip → context-menu Direction:LR → triggers layout re-run.

## 7. Open Questions (для plan'а)

- **Q1:** Какой триггер для immediate re-layout после context-menu direction change — explicit API call или local frontend `runLayout`? (Lean: backend trigger via POST /api/layout/selection.)
- **Q2:** Точная visual identity inside-title — текст внутри shape сверху-по-центру с какой font-size/color? Bootstrap pikne (font: 20, color = props.color).
- **Q3:** Frame-bar высота для outside-title — 32px / 28px / адаптивная под font-size?
- **Q4:** Pass A skip semantics — preserve абсолютные positions или относительные? Lean: relative (текущий child.x/y inside container остаются).
- **Q5:** Что если user удалит/архивирует пресет-комнату? Старые comm с geo+meta wrappers продолжают читаться (`isContainerShape` legacy branch).

Эти вопросы — для уточнения в Plan, не блокеры spec'а.

## 8. Migration & Rollout

- **Skip migration** (per brainstorm). Existing rooms — backwards-compat в `isContainerShape` и `readContainerDirection`.
- **Release:** 0.26.0 — отдельный minor (breaking конструктивно? Нет, новый shape type, без удаления старого pathway. Но `makeGroupBoundaryShape` → `makeSchemaContainerShape` — внутренний refactor, не публичный API).
- **CHANGELOG:** новый Added section "schema-container shape type" + "subgraph color from mermaid `style` directives" + AC list.
- **Cluster context:** DRW-150 идёт ОТДЕЛЬНОЙ phase от DRW-157..163 (которые ещё unreleased). DRW-157..163 — bug-fix cluster, ship as 0.25.4 ПЕРЕД DRW-150 или вместе с 0.26.0? **Lean: ship 0.25.4 (DRW-157..163) сначала**, потом DRW-150 как 0.26.0. Чище SemVer (bugs first, features second).

## 9. Acceptance Criteria

- **AC-1:** Зарегистрирован shape type `'schema-container'` в frontend tldraw schema; props validated через `T.literalEnum / T.string / T.nonZeroNumber / DefaultColorStyle / DefaultFillStyle / DefaultDashStyle`.
- **AC-2:** Backend `makeSchemaContainerShape` создаёт shape `type:"schema-container"` вместо `geo+meta.role=boundary`. Legacy `meta.didrawSubgraph` сохраняется для backwards-compat detection.
- **AC-3:** Resize контейнера НЕ масштабирует children (frame-like default).
- **AC-4:** Drag shape onto/off container → reparent (frame-like default).
- **AC-5:** `props.direction: "TB" | "LR" | "custom"` влияет на autolayout: TB/LR override'ит `runPassA`, custom skip'ает.
- **AC-6:** Manual user drag ребёнка контейнера → `props.direction → "custom"` через side-effect handler.
- **AC-7:** Context-menu "Direction" submenu видим когда selected shape is `schema-container`; setting direction immediately updateShape + triggers re-layout (если direction !== custom).
- **AC-8:** Mermaid `style <subgraphName> fill:#hex` → schema-container получает соответствующий `color/fill` (DRW-153 hex→tldraw color mapping).
- **AC-9:** Mermaid `subgraph X\ndirection LR\nend` → schema-container.props.direction = "LR".
- **AC-10:** Standard tldraw style panel (color/fill/dash) работает на selected schema-container.
- **AC-11:** Backwards-compat: existing v2 rooms с `geo+meta.didrawSubgraph` продолжают рендерить и layout'иться корректно (legacy branch в `isContainerShape` и `readContainerDirection`).
- **AC-12:** `titlePosition: "inside" | "outside"` prop существует, default `"inside"`; render switch реализован.
- **AC-13:** Backend + frontend test suite зелёный; new tests cover AC-1..AC-12.
- **AC-14:** CHANGELOG обновлён; release commit + tag 0.26.0 (после ship'а 0.25.4 cluster).

## 10. Cluster sequencing (important)

```
Now (unreleased на main):
├── DRW-157 (isContainerShape detection)
├── DRW-158 (virtual chain edges)
├── DRW-159 (frame.color regression)
├── DRW-160 (mermaid direction → autolayout mode)
├── DRW-161 (Pass A cross-subgraph edge lift)
└── DRW-163 (container top padding 40→72)

Step 1: Ship 0.25.4 release commit + tag — bundle DRW-157..163 (bug-fix cluster).
Step 2: feature/drw-150 branch + subagent-driven-development.
Step 3: 0.26.0 release commit + tag (DRW-150).
```

Это даёт чёткую separation: bug fixes vs new feature.

---

**End of Spec v0.1.**
