# DRW-186 probe — tldraw 5.x tool/UI/fill/edit API

> Status: probe-only. No production code touched.
> Spec: `docs/superpowers/specs/2026-05-27-schema-container-ux-design.md`
> Plan: `docs/superpowers/plans/2026-05-27-schema-container-ux-plan.md` Tasks 1–3
> tldraw versions pinned by `apps/frontend/package.json`: `tldraw@^5.0.0` (resolved → `5.0.0`), `@tldraw/editor@5.0.0`.
>
> Все пути ниже ведут в `node_modules/.bun/<pkg>@<ver>+<hash>/node_modules/<pkg>/...`. Для краткости ниже используются короткие алиасы:
> - `T/` = `tldraw@5.0.0+ab629783a4f35bff/.../tldraw/src`
> - `E/` = `@tldraw+editor@5.0.0+ab629783a4f35bff/.../@tldraw/editor/src`

`tldraw`'s public index делает `export * from '@tldraw/editor'` (T/`index.ts:57`), поэтому все символы (`StateNode`, `BaseBoxShapeTool`, `BaseFrameLikeShapeUtil`, `createShapeId`, `Box`, `getColorValue`, `TLUiOverrides`, `TLUiAssetUrlOverrides`, `onDragFromToolbarToCreateShape` и т.д.) импортируются из верхнеуровневого `"tldraw"`.

---

## Task 1 — `uiOverrides.tools` + `StateNode` API

### 1.1 `TLUiOverrides` shape

Файл: `T/lib/ui/overrides.ts` (см. строки 132–144).

```ts
export interface TLUiOverrides {
    actions?(
        editor: Editor,
        actions: TLUiActionsContextType,
        helpers: TLUiOverrideHelpers
    ): TLUiActionsContextType
    tools?(
        editor: Editor,
        tools: TLUiToolsContextType,
        helpers: TLUiOverrideHelpers
    ): TLUiToolsContextType
    translations?: TLUiTranslationProviderProps['overrides']
}
```

- `editor: Editor` — runtime editor instance, можно дергать `editor.setCurrentTool(...)`, `editor.getStyleForNextShape(...)`.
- `tools: TLUiToolsContextType = Record<string, TLUiToolItem>` (T/`lib/ui/hooks/useTools.tsx:49`). Это **мутабельная карта** — копия default-инвентаря (`select`, `hand`, `eraser`, `draw`, geo-семейство, `arrow`, `line`, `frame`, `text`, `asset`, `note`, `laser`, `embed`, `highlight`). Override может добавить новые ключи или переписать существующие.
- Возврат: новая карта. Идиома (см. T/`lib/ui/hooks/useTools.tsx:333-337`):
  ```ts
  const tools = Object.fromEntries(toolsArray.map((t) => [t.id, t]))
  if (overrides) return overrides(editor, tools, helpers)
  return tools
  ```
- `helpers: TLUiOverrideHelpers` — диалоги/toasts/clipboard/insertMedia/exportAs/copyAs/print + breakpoint flags (`T/lib/ui/overrides.ts:84-125`).

### 1.2 `TLUiToolItem` shape

T/`lib/ui/hooks/useTools.tsx:23-46`:

```ts
export interface TLUiToolItem<TranslationKey extends string = string,
                              IconType extends string = string> {
    id: string
    label: TranslationKey                  // не строка-литерал, а translation key (но any string accepted)
    shortcutsLabel?: TranslationKey
    icon: IconType | TLUiIconJsx           // строка из assetUrls.icons либо React-элемент
    onSelect(source: TLUiEventSource): void
    onDragStart?(source: TLUiEventSource, info: TLPointerEventInfo): void
    kbd?: string                           // 'c', 'v', 'cmd+u,ctrl+u' и т.д.
                                           // legacy символы: '!' = shift, '$' = cmd, '?' = alt
    readonlyOk?: boolean
    meta?: { [key: string]: any }
}
```

Пример нативной регистрации `frame` (T/`lib/ui/hooks/useTools.tsx:221-242`):

```ts
{
    id: 'frame',
    label: 'tool.frame',
    icon: 'tool-frame',
    kbd: 'f',
    onSelect(source) {
        editor.setCurrentTool('frame')
        onToolSelect(source, this)
    },
    onDragStart(source, info) {
        const scale = editor.getResizeScaleFactor()
        onDragFromToolbarToCreateShape(editor, info, {
            createShape: (id) =>
                editor.createShape({
                    id,
                    type: 'frame',
                    props: { w: 160 * 2 * scale, h: 90 * 2 * scale },
                }),
        })
        trackEvent('drag-tool', { source, id: 'frame' })
    },
},
```

`onDragStart` — необязательный hook для click-and-drag из тулбара на холст (поведение «дотащить инструмент» — отличается от drag-from-corner внутри холста). Для DRW-186 нам это **не нужно** — drag-from-corner делается через `StateNode` Pointing-стейт.

### 1.3 `StateNode` drag-from-corner pipeline (FrameShapeTool как референс)

Файл: `T/lib/shapes/frame/FrameShapeTool.ts` — **критически короткий**:

```ts
import { BaseBoxShapeTool, TLShape, TLShapeId } from '@tldraw/editor'

export class FrameShapeTool extends BaseBoxShapeTool {
    static override id = 'frame'
    static override initial = 'idle'
    override shapeType = 'frame' as const

    override onCreate(shape: TLShape | null): void {
        if (!shape) return
        // ... reparent enclosed siblings ...
        if (this.editor.getInstanceState().isToolLocked) {
            this.editor.setCurrentTool('frame')
        } else {
            this.editor.setCurrentTool('select.idle')
        }
    }
}
```

Главный takeaway: **frame не пишет drag-pipeline вручную**. Он наследует `BaseBoxShapeTool` (`E/lib/editor/tools/BaseBoxShapeTool/BaseBoxShapeTool.ts`):

```ts
export abstract class BaseBoxShapeTool extends StateNode {
    static override id = 'box'
    static override initial = 'idle'
    static override children(): TLStateNodeConstructor[] {
        return [Idle, Pointing]
    }
    abstract override shapeType: TLBaseBoxShape['type']
    onCreate?(_shape: TLShape | null): void | null
}
```

#### Idle child — `E/lib/editor/tools/BaseBoxShapeTool/children/Idle.ts`

```ts
export class Idle extends StateNode {
    static override id = 'idle'

    override onPointerDown(info: TLPointerEventInfo) {
        this.parent.transition('pointing', info)
    }

    override onEnter() {
        this.editor.setCursor({ type: 'cross', rotation: 0 })
    }

    override onCancel() {
        this.editor.setCurrentTool('select')
    }
}
```

#### Pointing child — `E/lib/editor/tools/BaseBoxShapeTool/children/Pointing.ts`

Ключевая логика (фрагмент строк 13–61):

```ts
override onPointerMove(info: TLPointerEventInfo) {
    const { editor } = this
    if (editor.inputs.getIsDragging()) {
        const originPagePoint = editor.inputs.getOriginPagePoint()
        const shapeType = (this.parent as BaseBoxShapeTool)!.shapeType
        const id = createShapeId()
        const creatingMarkId = editor.markHistoryStoppingPoint(`creating_box:${id}`)
        const newPoint = maybeSnapToGrid(originPagePoint, editor)

        this.editor.createShapes([{
            id,
            type: shapeType,
            x: newPoint.x,
            y: newPoint.y,
            props: { w: 1, h: 1 },
        }])
        const shape = editor.getShape(id)
        if (!shape) { this.cancel(); return }
        editor.select(id)

        const parent = this.parent as BaseBoxShapeTool
        this.editor.setCurrentTool('select.resizing', {
            ...info,
            target: 'selection',
            handle: 'bottom_right',
            isCreating: true,
            creatingMarkId,
            creationCursorOffset: { x: 1, y: 1 },
            onInteractionEnd: this.parent.id,
            onCreate: parent.onCreate
                ? (shape: TLShape | null) => parent.onCreate?.(shape)
                : undefined,
        })
    }
}

override onPointerUp() { this.complete() }   // click без drag — создание дефолтного размера в complete()
```

То есть последовательность drag-from-corner:

1. Idle.`onEnter` → cursor `cross`.
2. Idle.`onPointerDown(info)` → `transition('pointing', info)`.
3. Pointing.`onPointerMove`:
   - Если `editor.inputs.getIsDragging()` (порог dragging уже преодолён) → **создаёт shape 1×1 в `originPagePoint`** и **передаёт управление `select.resizing`** с `handle: 'bottom_right'`, `isCreating: true`. Select-tool сам резайзит shape пока пользователь тянет мышь, и в `onCreate` callback вызывается `parent.onCreate(shape)` после release.
4. Если без drag (просто click) — `onPointerUp` → `complete()` создаёт shape дефолтного размера в point, обновляет позицию (центрирует).

**Никакой ручной математики (`Math.min(origin, current)`, минимальные размеры и т.д.) делать не нужно** — план Task 5 с `computeShapeBoundsFromDrag` идеологически нативен только если мы НЕ хотим наследовать `BaseBoxShapeTool`. Рекомендация: **`SchemaContainerTool extends BaseBoxShapeTool`**, единственный override — `static override id = 'schema-container'` + `override shapeType = 'schema-container'` + опциональный `onCreate` для post-create логики (например, реализация style-defaults / titlePosition). См. финальный draft в §1.6 ниже.

#### `complete()` для click без drag — `E/.../children/Pointing.ts:80-139`

При простом клике (без drag) Pointing создаёт shape **в `originPagePoint`** без props (тогда сработают `getDefaultProps()`), потом сдвигает его на `(-w/2, -h/2)` чтобы центр оказался под курсором. Это даёт фрейм дефолтного размера.

### 1.4 `assetUrls` mechanism

#### Тип `TLUiAssetUrlOverrides`

T/`lib/ui/assetUrls.ts:8-15`:

```ts
export interface TLUiAssetUrls extends TLEditorAssetUrls {
    icons: Record<TLUiIconType | Exclude<string, TLUiIconType>, string>
    translations: Record<(typeof LANGUAGES)[number]['locale'], string>
    embedIcons: Partial<Record<(typeof DEFAULT_EMBED_DEFINITIONS)[number]['type'], string>>
}

export type TLUiAssetUrlOverrides = RecursivePartial<TLUiAssetUrls>
```

Глобальный merge в `useDefaultUiAssetUrlsWithOverrides` (T/`lib/ui/assetUrls.ts:42-58`) — обычный `Object.assign(...default, ...overrides)` по каждому из четырёх ключей (`fonts`, `icons`, `embedIcons`, `translations`). Override может **добавить новые ключи** в `icons` (TS-сигнатура допускает `Exclude<string, TLUiIconType>` — фактически any string).

#### Как иконка рендерится

T/`lib/ui/components/primitives/TldrawUiIcon.tsx:60-110`:

```ts
const assetUrls = useAssetUrls()
const asset = assetUrls.icons[icon as TLUiIconType] ?? assetUrls.icons['question-mark-circle']
// ...
ref.current.style.webkitMask = `url(${asset}) center 100% / 100% no-repeat`
// и
style={{
    color,
    mask: `url(${asset}) center 100% / 100% no-repeat`,
}}
```

**Критично:** иконка применяется как **CSS `mask`/`webkit-mask`**, т.е. SVG должен быть **single-color силуэт** (тело окрашивается через `color: currentColor`). Цветные многопалитровые SVG — НЕ работают (mask отбросит цвета, оставит только альфа-канал).

Дефолтные иконки tldraw хранятся как **merged SVG со sprite-фрагментами**: `${CDN}/icons/icon/0_merged.svg#${name}` (T/`lib/ui/assetUrls.ts:20`). Но override может указать URL индивидуального файла — это работает, потому что CSS `mask: url(...)` принимает любой SVG.

**Для DRW-186:**
- Положить `apps/frontend/public/icons/tool-schema-container.svg` и `tool-mermaid.svg`.
- Каждый SVG — однотонный (используем `fill="black"` — mask читает альфа-канал, color через `currentColor` в окружающем DOM).
- URL в override: `"tool-schema-container": "/icons/tool-schema-container.svg"` (Vite раздаёт `public/` с корня).
- В `TLUiToolItem` ставим `icon: "tool-schema-container"`.

#### Регистрация в `<Tldraw>`

T/`lib/Tldraw.tsx:81`: prop `assetUrls?: TLUiAssetUrlOverrides`. Передаётся в `useDefaultUiAssetUrlsWithOverrides(rest.assetUrls)` → `AssetUrlsProvider`. Plan-snippet корректен:

```tsx
<Tldraw
    shapeUtils={[SchemaContainerShapeUtil]}
    tools={[SchemaContainerTool]}
    overrides={buildUiOverrides({ ... })}
    assetUrls={{
        icons: {
            "tool-schema-container": "/icons/tool-schema-container.svg",
            "tool-mermaid": "/icons/tool-mermaid.svg",
        },
    }}
>
```

### 1.5 Прочие импорты (для Tasks 5–6)

- `createShapeId` — re-export from `@tldraw/tlschema` через `@tldraw/editor` → `import { createShapeId } from "tldraw"`.
- `Box.FromPoints(points)` — `E/lib/primitives/Box.ts:390-407`. Импорт: `import { Box } from "tldraw"`. **Для нашего сценария не нужно** — `BaseBoxShapeTool.Pointing` сам считает bounds через `select.resizing`.
- `editor.getStyleForNextShape(DefaultColorStyle)` — `E/lib/editor/Editor.ts:9103`. Работает.
- `editor.getDocumentSettings()` / `editor.updateDocumentSettings({ meta: { ... } })` — есть в `Editor.ts`, plan'овский подход к `containerTitlePosition` через documentSettings.meta валиден. (Подтверждается также `maybeSnapToGrid` в `E/.../children/Pointing.ts:151-156`, где `editor.getDocumentSettings().gridSize` используется напрямую.)

### 1.6 Рекомендуемый итоговый эскиз `SchemaContainerTool.ts`

Минимальная реализация, **существенно проще плана Task 5**:

```ts
// SchemaContainerTool.ts
import { BaseBoxShapeTool } from "tldraw";

export class SchemaContainerTool extends BaseBoxShapeTool {
  static override id = "schema-container";
  static override initial = "idle";
  override shapeType = "schema-container" as const;

  // Optional: если нужно после создания вернуться в select-tool без isToolLocked:
  // override onCreate(shape) {
  //   if (!shape) return;
  //   this.editor.setCurrentTool("select.idle");
  // }
}
```

Default `BaseBoxShapeTool.Pointing.complete()` уже:
- Создаёт shape с `getDefaultProps()` нашего ShapeUtil (т.е. `DEFAULT_SCHEMA_CONTAINER_PROPS` подставится).
- Стиль-defaults (`color`, `fill`, `dash`) применяются через `editor.applyStylesToShapes` автоматически — у tldraw есть spec-конформный path в `Editor.createShape` (см. `E/lib/editor/Editor.ts:8525-8540`, where `applyValue(style, this.getStyleForNextShape(style))` вызывается для каждого `StyleProp` в shape props).
- `titlePosition` — **проблема**: defaultProps пишет `"inside-center"`, а board-default из `room.meta.containerTitlePosition` нужно применить ПОСЛЕ. Самый чистый путь — override `onCreate(shape)`:

  ```ts
  override onCreate(shape: TLShape | null): void {
      if (!shape) return;
      const tp = resolveBoardTitlePosition(this.editor);
      if (tp !== shape.props.titlePosition) {
          this.editor.updateShape({
              id: shape.id,
              type: "schema-container",
              props: { titlePosition: tp },
          });
      }
      if (this.editor.getInstanceState().isToolLocked) {
          this.editor.setCurrentTool("schema-container");
      } else {
          this.editor.setCurrentTool("select.idle");
      }
  }
  ```

**Pure helpers `computeShapeBoundsFromDrag` / `buildSchemaContainerShape` из плана становятся излишними.** Их можно либо удалить из плана (BaseBoxShapeTool делает всё сам), либо оставить как unit-tested helpers ради coverage метрики — но они не на горячем пути.

### 1.7 Регистрация tool класса в `<Tldraw>`

```tsx
import { SchemaContainerTool } from "./shapes/schema-container/SchemaContainerTool";

<Tldraw
  shapeUtils={[SchemaContainerShapeUtil]}
  tools={[SchemaContainerTool]}        // ← массив StateNode subclasses
  overrides={buildUiOverrides({ ... })} // ← TLUiOverrides; tools(editor, tools, helpers)
  assetUrls={{ icons: { ... } }}
  ...
>
```

`tools` prop у `<Tldraw>` принимает массив **TLStateNodeConstructor** — конструкторов классов, не инстансов. tldraw сам инстанциирует их в editor.

---

## Task 2 — Native rect fill rendering parity

### 2.1 Где живёт правда (исходник tldraw)

`T/lib/shapes/geo/GeoShapeUtil.tsx:188-222` — `getDefaultDisplayValues` для GeoShape вычисляет `fillColor`:

```ts
strokeColor: getColorValue(colors, color, 'solid'),
strokeWidth: theme.strokeWidth * STROKE_SIZES[size],
fillColor:
    fill === 'none'
        ? 'transparent'
        : fill === 'semi'
            ? colors.solid                                            // ← обрати внимание
            : getColorValue(colors, color, DEFAULT_FILL_COLOR_NAMES[fill]),
patternFillFallbackColor: getColorValue(colors, color, 'semi'),
```

И mapping (`T/lib/shapes/shared/defaultFills.ts:3-11`):

```ts
export const DEFAULT_FILL_COLOR_NAMES: Record<
    Exclude<TLDefaultFillStyle, 'none' | 'semi'>,
    keyof TLDefaultColor
> = {
    solid: 'semi',          // ← КЛЮЧЕВОЕ: fill='solid' ⇒ palette variant 'semi'
    pattern: 'pattern',
    fill: 'fill',
    'lined-fill': 'linedFill',
}
```

**Расшифровка**: tldraw путает терминологию намеренно. `props.fill === 'solid'` отображается **полупрозрачной (`semi`) краской** палитры — это пастельный fill (`#f4dadb` для красного, `#dce1f8` для синего). А `props.fill === 'semi'` рендерится `colors.solid` — это **theme-level solid color** (страница-контрастный белёсый `#fcfffe` в light-режиме, тёмный в dark).

`GeoShapeBody` (T/`lib/shapes/geo/GeoShapeBody.tsx:34-55`) рисует:

```ts
{fill === 'none' ? null : fill === 'pattern' ? (
    <PatternFill d={fillPath} fillColor={fillColor} ... />
) : (
    <path fill={fillColor} d={fillPath} />
)}
{path.toSvg({ ..., props: { fill: 'none', stroke: strokeColor } })}
```

Т.е. **fill пишется напрямую как hex** в атрибуте `fill="..."`, без opacity/alpha modulation. Никакого `<defs>` `<pattern>` (кроме `fill='pattern'` ветки), никакого `fill='url(#...)'` — простой hex/rgba.

### 2.2 Live-инспекция (chrome-devtools MCP)

URL: `http://localhost:5173/?space=di-draw&room=drw-186-fill-probe`

Создал по три native geo и три SchemaContainer (через `editor.createShape`) с разными комбинациями. Прочитал `<rect>.fill` / `<path>.fill` атрибутов.

**Native `<geo>` rectangle** (рендерится как `<path>`, но `fill=` атрибут одинаков по форме):

| `props.fill` | Native rendered `fill` | Что это |
|---|---|---|
| `solid` (red) | `#f4dadb` | palette `red.semi` |
| `semi` (red) | `#fcfffe` | theme `colors.light.solid` (page-contrast) |
| `none` (red) | нет path | transparent |
| `solid` (blue) | `#dce1f8` | palette `blue.semi` |

**Current SchemaContainer** (`SchemaContainerShapeUtil.tsx:74-79`):

```ts
const fillCss =
    fill === "none" ? "transparent"
    : fill === "solid" ? colorCss                            // ← BUG: colorCss = getColorValue(colors, color, 'solid')
    : getColorValue(colors, color, "semi");
```

| `props.fill` | Current SC fill | Должно быть | Mismatch |
|---|---|---|---|
| `solid` (red) | `#e03131` (red.solid) | `#f4dadb` (red.semi) | 100% saturated bug |
| `semi` (red) | `#f4dadb` (red.semi) | `#fcfffe` (light.solid) | wrong shade |
| `none` | transparent | transparent | OK |

Скриншот side-by-side: `docs/probes/2026-05-27-drw-186-fill-comparison.png` (top row = native rects red solid/semi/none; bottom row = SchemaContainer same combos).

### 2.3 Дамп theme для red/blue (live от `editor.getCurrentTheme()`)

```js
red = {
  solid: '#e03131', fill: '#e03131', linedFill: '#e75f5f',
  frameHeadingStroke: '#e55757', frameHeadingFill: '#fef7f7',
  frameStroke: '#e55757', frameFill: '#fef9f9', frameText: '#000000',
  noteFill: '#FC8282', noteText: '#000000',
  semi: '#f4dadb', pattern: '#e55959',
  highlightSrgb: '#ff636e', highlightP3: 'color(display-p3 0.9992 0.4376 0.45)'
}
blue = {
  solid: '#4465e9', fill: '#4465e9', linedFill: '#6580ec',
  ... ,
  semi: '#dce1f8', pattern: '#6681ee',
  ...
}
colors.light.solid = '#fcfffe'
```

`colors.light.solid` — это НЕ `colors.light.<color>.solid`; это top-level `theme.colors.light.solid` (page-contrast «канва-белый»). В dark-теме там тёмный hex. См. `lightKeys` = `["text","background","negativeSpace","solid","cursor",...,"blue","red",...]` — массив включает И индексированные colors, И meta-ключи (`text`, `solid`, `background`).

### 2.4 Есть ли публичный экспорт `DEFAULT_FILL_COLOR_NAMES`?

```bash
grep -n "DEFAULT_FILL_COLOR_NAMES" node_modules/.bun/tldraw@5.0.0+.../tldraw/src/index.ts
# → no match
```

`DEFAULT_FILL_COLOR_NAMES` живёт в `T/lib/shapes/shared/defaultFills.ts`, **не re-exported** из публичного `tldraw` index. Это internal-имплементация (видимо специально, чтобы tldraw мог поменять mapping без breaking change).

`getFillDefForExport` / `getFillDefForCanvas` (`T/lib/shapes/shared/defaultStyleDefs.tsx`) — публичные, но они для SVG-export-defs (`SvgExportDef`) и canvas-`<defs>` (`TLShapeUtilCanvasSvgDef`), нужные ТОЛЬКО для `fill='pattern'` (нашему DRW-186 не нужен — мы не поддерживаем pattern на SchemaContainer; см. enum в `SchemaContainerShape.ts` если потребуется уточнение).

### 2.5 Решение для Task 12 — **Option B (replicate inline)**

Поскольку `DEFAULT_FILL_COLOR_NAMES` не public, не пытаемся импортировать. Заменяем `fill === "solid" ? colorCss : ...` на правильную ветку.

**Patch скетч для `SchemaContainerShapeUtil.tsx`:**

```ts
// helper, can live inline or be extracted
function resolveContainerFill(
  colors: TLThemeColors,                  // theme.colors[colorMode]
  color: TLDefaultColorStyle,
  fill: TLDefaultFillStyle,
): string {
  switch (fill) {
    case "none":    return "transparent";
    case "semi":    return colors.solid;                  // top-level theme color, not per-color variant
    case "solid":   return getColorValue(colors, color, "semi");  // pastel
    case "pattern":
    case "fill":
    case "lined-fill":
      // SchemaContainer enum is likely tighter than full TLDefaultFillStyle — branches may be unreachable.
      // Falling back to "semi" (legacy current behavior) keeps backward compat if enum extends later.
      return getColorValue(colors, color, "semi");
  }
}
```

Тогда `renderInsideTitle`/`renderOutsideTitle`:

```ts
const colors = theme.colors[colorMode];
const colorCss = getColorValue(colors, color, "solid");   // for stroke + label text on inside variant
const fillCss = resolveContainerFill(colors, color, fill);
```

**Проверка corner-cases:**
- `fill='none'` — без изменений, остаётся `transparent`. OK.
- `fill='semi'` — было `getColorValue(colors, color, 'semi')` = `#f4dadb`; станет `colors.solid` = `#fcfffe`. **Behavior change, но это и есть parity с native.**
- `fill='solid'` — было `#e03131`; станет `#f4dadb`. **Это и есть основной фикс.**

**Decision: use Option B (inline mapping).** Не импортировать internal helper, чтобы не зависеть от unstable internals tldraw. 7 строк свитч-кейса с явным комментом ссылкой на `defaultFills.ts` в этом probe — достаточно.

### 2.6 Note про dark mode + цвета без палитры

`getColorValue` для **string-color** (e.g. user указал `#ff0000` вместо палитрового имени) возвращает `color` без изменений (`E/lib/editor/managers/ThemeManager/defaultThemes.ts:614-618`):

```ts
const colorEntry = colors[color as TLDefaultColorStyle]
if (!colorEntry || typeof colorEntry === 'string') return color
return colorEntry[variant]
```

Это означает: если кто-то когда-то воткнёт custom hex в `props.color`, наш `resolveContainerFill` для `fill='solid'`/`'semi'` пойдёт по тому же fallback path что и tldraw — оба используют `getColorValue` под капотом. Дополнительной обработки не нужно.

Dark mode работает автоматически — `useColorMode()` уже возвращает текущий режим, `theme.colors[colorMode]` подбирает правильный sub-палитр. **Никаких отдельных бренчей для dark не пишем.**

---

---

## Task 3 — `canEdit` + `onDoubleClick` override для frame-like shapes

### 3.1 Дефолты в наследовании цепочки `BaseFrameLikeShapeUtil → BaseBoxShapeUtil → ShapeUtil`

**`ShapeUtil.canEdit` default** (`E/lib/editor/shapes/ShapeUtil.ts:298-305`):

```ts
canEdit(shape: Shape, info: TLEditStartInfo): boolean {
    return false                    // ← default = false
}
```

**`ShapeUtil.onDoubleClick` default** (`E/lib/editor/shapes/ShapeUtil.ts:952-959`):

```ts
onDoubleClick?(shape: Shape): TLShapePartial<Shape> | void   // optional, undefined by default
```

`BaseFrameLikeShapeUtil` (`E/lib/editor/shapes/BaseFrameLikeShapeUtil.tsx`) **НЕ переопределяет ни `canEdit`, ни `onDoubleClick`** — оно только пишет `isFrameLike`, `providesBackgroundForChildren`, `canReceiveNewChildrenOfType`, `canRemoveChildrenOfType`, `getClipPath`, `onDragShapesIn/Out`.

`BaseBoxShapeUtil` (`E/lib/editor/shapes/BaseBoxShapeUtil.ts`) тоже не трогает `canEdit`/`onDoubleClick`.

**Вывод:** наш `SchemaContainerShapeUtil extends BaseFrameLikeShapeUtil` сейчас унаследовал `canEdit() => false`, без override. Поэтому при double-click создаётся child text shape (см. §3.3).

### 3.2 Frame-эталон — паттерн override `canEdit`

`T/lib/shapes/frame/FrameShapeUtil.tsx:121-123`:

```ts
override canEdit(shape: TLFrameShape, info: TLEditStartInfo) {
    return info.type === 'click-header' || info.type === 'unknown'
}
```

Frame **специально не возвращает true для всех `info.type`** — только `'click-header'` (фиксированный диспатч из FrameHeading UI; в коде tldraw 5.0.0 не нашёл реального места, где этот type passing-ся — выглядит как future-proof flag) и `'unknown'` (используется когда `canEditShape` вызывается без явного info, см. `E/.../Editor.ts:2699` — `info ?? { type: 'unknown' }`).

`TLEditStartInfo['type']` (`E/lib/editor/shapes/ShapeUtil.ts:1080-1089`):

```ts
type: 'press_enter' | 'click' | 'double-click' | 'double-click-edge'
    | 'double-click-corner' | 'click-header' | 'unknown'
```

Что важно для нашего SchemaContainer:
- При **double-click на shape body** через `SelectTool.Idle.onDoubleClick(info)` (T/`lib/tools/SelectTool/childStates/Idle.ts:444`) tldraw зовёт `canEditShape(shape)` БЕЗ передачи `info` → `info.type === 'unknown'`.
- Frame's фильтр `info.type === 'unknown'` означает «принять любой стандартный double-click». Это **именно то поведение, которое нам нужно** для DRW-186 (любой double-click → редактирование label).

**Рекомендация для SchemaContainerShapeUtil:**

```ts
override canEdit(_shape: SchemaContainerShape, _info: TLEditStartInfo): boolean {
    return true   // принимаем любой trigger — DRW-186 хочет максимально либеральный режим редактирования
}
```

Если в будущем понадобится granular control (например, разрешать редактирование только при клике в label-зону) — можно сузить до Frame-style фильтра. Сейчас YAGNI: возвращаем `true` всегда.

### 3.3 Double-click flow в `SelectTool.Idle.onDoubleClick` (info.target === 'shape')

Источник: T/`lib/tools/SelectTool/childStates/Idle.ts:419-452`:

```ts
case 'shape': {
    const { shape } = info
    const util = this.editor.getShapeUtil(shape)

    // Allow playing videos and embeds
    if (shape.type !== 'video' && shape.type !== 'embed' && this.editor.getIsReadonly()) break

    if (util.onDoubleClick) {
        // Call the shape's double click handler
        const change = util.onDoubleClick?.(shape)
        if (change) {
            this.editor.updateShapes([change])
            return                                  // ← early return: blocks edit-mode
        }
    }

    if (util.canCrop(shape) && !this.editor.isShapeOrAncestorLocked(shape)) {
        this.editor.markHistoryStoppingPoint('select and crop')
        this.editor.select(info.shape?.id)
        this.parent.transition('crop', info)
        return
    }

    // If the shape can edit, then begin editing
    if (this.editor.canEditShape(shape)) {
        this.startEditingShape(shape, info, true /* select all */)
    } else {
        // If the shape's double click handler has not created a change,
        // and if the shape cannot edit, then create a text shape and
        // begin editing the text shape
        this.handleDoubleClickOnCanvas(info)
    }
    break
}
```

Расшифровка по веткам:

1. `onDoubleClick` returns **`TLShapePartial`** (a change) → `updateShapes([change])` → **return**. Editing mode НЕ запускается.
2. `onDoubleClick` returns **`void`** (или метод не определён) → продолжаем.
3. `canCrop` (false для SchemaContainer — `canCrop` default false) → пропускаем.
4. `canEditShape(shape)` — вернёт true если `util.canEdit(shape, {type:'unknown'}) === true` (см. `E/lib/editor/Editor.ts:2692-2704`). → `startEditingShape(shape, info, true)`.
5. Иначе → `handleDoubleClickOnCanvas(info)` создаёт child text shape (T/`...Idle.ts:710-742`):

```ts
handleDoubleClickOnCanvas(info: TLClickEventInfo) {
    if (this.editor.getIsReadonly()) return
    if (!this.editor.options.createTextOnCanvasDoubleClick) return     // default true (E/lib/options.ts:327)
    this.editor.markHistoryStoppingPoint('creating text shape')
    const id = createShapeId()
    const { x, y } = this.editor.inputs.getCurrentPagePoint()
    this.editor.createShapes([{ id, type: 'text', x, y,
        props: { richText: toRichText(''), autoSize: true } }])
    // ... start editing text shape ...
}
```

**Это и есть наш текущий баг**: SchemaContainer наследовал `canEdit() => false`, `onDoubleClick` undefined → tldraw падает в `handleDoubleClickOnCanvas` и создаёт «child» text shape (на самом деле parented to current page, но визуально кажется ребёнком из-за позиции под курсором).

### 3.4 `startEditingShape` — как именно tldraw входит в edit mode

`T/lib/tools/SelectTool/childStates/Idle.ts:689-702`:

```ts
private startEditingShape(
    shape: TLShape,
    info: TLClickEventInfo | (TLKeyboardEventInfo & { target: 'shape'; shape: TLShape }),
    shouldSelectAll?: boolean
) {
    const { editor } = this
    this.editor.markHistoryStoppingPoint('editing shape')
    if (hasRichText(shape)) {
        startEditingShapeWithRichText(editor, shape, { selectAll: shouldSelectAll })
    } else {
        editor.setEditingShape(shape)               // ← наш путь (props.name — string, not richText)
    }
    this.parent.transition('editing_shape', info)
}
```

SchemaContainer has `props.name: T.string` (не richText), поэтому tldraw зайдёт во **второй branch** и просто вызовет `editor.setEditingShape(shape)`. Из `component()` мы детектируем через `editor.getEditingShapeId() === shape.id` (или хук `useIsEditing(id)` — см. ниже).

### 3.5 `useIsEditing` reactive hook (рекомендованный паттерн)

Frame использует именно его (T/`lib/shapes/frame/components/FrameHeading.tsx:49`):

```ts
import { useIsEditing } from 'tldraw'   // → @tldraw/editor
const isEditing = useIsEditing(id)      // reactive boolean
```

Это **лучше** чем тащить `this.editor.getEditingShapeId() === shape.id` напрямую в `component()` — `useIsEditing` сам подписан на reactive store и триггерит re-render когда `editingShapeId` меняется. План Task 10 использует прямой `this.editor.getEditingShapeId()` — переход на `useIsEditing` упрощает код и убирает потенциальные stale-render баги.

### 3.6 `getEditingShapeId` — confirm существует в 5.x

`E/lib/editor/Editor.ts:2669`:

```ts
@computed getEditingShapeId(): TLShapeId | null { ... }
```

Существует, computed (reactive). Можно безопасно дёргать в read-only контексте (out-of-react), но в `component()` лучше `useIsEditing`.

### 3.7 Нужен ли override `onDoubleClick`?

**Нет.** Достаточно `canEdit() => true`. Цепочка такая:

1. tldraw зовёт `util.onDoubleClick?.(shape)` — undefined у нас → пропуск.
2. tldraw зовёт `canEditShape(shape)` → `util.canEdit(shape, {type:'unknown'})` → возвращаем true.
3. tldraw зовёт `startEditingShape(shape, info)` → `editor.setEditingShape(shape)`.
4. `component()` через `useIsEditing(shape.id)` рендерит HTML input overlay (Task 10/11 deliverable).
5. Никаких `editor.markEventAsHandled`, `cancelDoubleClick`, `stopPropagation` НЕ нужно — tldraw сам в `startEditingShape` транзитит SelectTool в `editing_shape`, что блокирует дальнейшую обработку.

**Plan Task 10 предлагает** override `onDoubleClick` с явным `editor.setEditingShape(shape.id)`. Это работает (просто дублирует то, что tldraw сделает сам в `startEditingShape`), но избыточно. **Рекомендация для финальной имплементации Task 10**: оставить override `onDoubleClick` **только если хотим custom-pre-edit-logic** (например, измерить bounding box label-зоны и решить, действительно ли клик попал в label). Если нет — единственный override это `canEdit`.

Минимальный финальный diff для `SchemaContainerShapeUtil.tsx`:

```ts
import type { TLEditStartInfo } from "tldraw";   // type-only, не breaking

export class SchemaContainerShapeUtil extends BaseFrameLikeShapeUtil<SchemaContainerShape> {
    // ... existing static props ...

    override canEdit(_shape: SchemaContainerShape, _info: TLEditStartInfo): boolean {
        return true;
    }

    // НЕ переопределяем onDoubleClick — tldraw сам зайдёт в setEditingShape.

    override component(shape: SchemaContainerShape) {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const isEditing = useIsEditing(shape.id);    // import { useIsEditing } from "tldraw"
        return shape.props.titlePosition === "outside"
            ? renderOutsideTitle(shape, this.editor, isEditing)
            : renderInsideTitle(shape, this.editor, isEditing);
    }
}
```

Render functions принимают `isEditing` и при `true` рендерят HTML `<input>` поверх SVG label (план Task 11 deliverable). При `Esc`/`Enter`/`blur` коммитим через `editor.updateShape({ id, type, props: { name: newValue } })` и `editor.setEditingShape(null)` — как делает `FrameLabelInput` (`T/.../FrameLabelInput.tsx:30-67`).

### 3.8 Дополнительная защита от bubbling input events

В edit-mode HTML `<input>` внутри shape `component()` будет ловить pointer events — tldraw обычно перехватывает их через document-level listeners. Чтобы input нормально принимал клики/фокус, нужно (см. `FrameLabelInput.tsx:23-28`):

```ts
const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
        if (isEditing) editor.markEventAsHandled(e)
    },
    [editor, isEditing]
)
```

`editor.markEventAsHandled(e)` — публичный editor API, не позволяет tldraw обрабатывать событие как canvas-event. Применять на `onPointerDown` input'а. То же для `onKeyDown` Enter/Escape (см. `FrameLabelInput.tsx:31-41`):

```ts
if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
    editor.markEventAsHandled(e)
    e.currentTarget.blur()
    editor.setEditingShape(null)
}
```

Без этого Enter может всплыть до `SelectTool.Idle.onKeyDown` и снова войти в edit mode (бесконечный re-enter). Plan Task 10 импортирует `useEditor` и слушает Enter/Esc, но **не упоминает `markEventAsHandled`** — это пробел; добавить в фактическую реализацию.

### 3.9 Сводка для Task 10

| Override | Нужен? | Что делает |
|---|---|---|
| `canEdit(shape, info): boolean` | **ДА** | `return true` → разблокирует edit-mode на double-click |
| `onDoubleClick(shape)` | нет | unless custom pre-edit logic (отдельная UX) |
| `component()` использует `useIsEditing(shape.id)` | **ДА** | переключает рендер SVG `<text>` ↔ HTML `<input>` |
| HTML input `onPointerDown` → `editor.markEventAsHandled(e)` | **ДА** | блокирует bubble в canvas-handlers |
| HTML input `onKeyDown` Enter/Escape → `editor.markEventAsHandled(e)` + `setEditingShape(null)` | **ДА** | предотвращает re-enter loop |
| HTML input `onBlur` → `updateShape({ props: { name } })` + `setEditingShape(null)` | **ДА** | commit on blur (parity с Frame) |

### 3.10 Альтернатива: keep `onDoubleClick` override без явной нужды

Если plan-author хочет оставить explicit override для readability — оба варианта работают:

```ts
// Option 1 (minimal — recommended):
override canEdit() { return true }
// onDoubleClick не определён, tldraw сам вызовет setEditingShape

// Option 2 (explicit):
override canEdit() { return true }
override onDoubleClick(shape: SchemaContainerShape): TLShapePartial<SchemaContainerShape> | void {
    this.editor.setEditingShape(shape.id)
    // НЕ возвращаем change — tldraw увидит void, перейдёт к canEditShape ветке,
    // canEditShape вернёт false (potem shape УЖЕ editing, id === getEditingShapeId),
    // что предотвратит дублирующий setEditingShape вызов. Но это noisy code.
    return
}
```

`canEditShape` (E/lib/editor/Editor.ts:2693-2695):

```ts
if (id === this.getEditingShapeId()) return false   // already editing this shape
```

Т.е. в Option 2 вторая ветка кода SelectTool **именно вернёт false** (потому что мы уже сделали `setEditingShape` в onDoubleClick), `startEditingShape` НЕ зовётся повторно, но и `handleDoubleClickOnCanvas` не зовётся (мы уже в edit mode). Race-free, но избыточно. **Берём Option 1.**

---

## Сводка для Tasks 4–13

Главные deltas vs план:

1. **Task 5 SchemaContainerTool**: упростить до `extends BaseBoxShapeTool` (5 строк). Удалить `computeShapeBoundsFromDrag` / `buildSchemaContainerShape` pure helpers — не нужны. Если хочется keep tests — оставить как «coverage smoke», но они не на горячем пути.
2. **Task 6 ui-overrides**: всё как в плане; icons на `/icons/*.svg` (Vite раздаёт `public/`), single-color silhouette SVG (CSS mask reads alpha).
3. **Task 10 inline edit**: `canEdit` достаточно; `onDoubleClick` override не нужен. Использовать `useIsEditing(id)` (не прямой `getEditingShapeId() === id`). Добавить `editor.markEventAsHandled(e)` в input's `onPointerDown` + `onKeyDown Enter/Escape`. План пропустил этот шаг.
4. **Task 12 fill fix**: inline `resolveContainerFill` свитч-кейс (Option B); `fill='solid'` → `getColorValue(colors, color, 'semi')`; `fill='semi'` → `colors.solid`; `fill='none'` → `'transparent'`.
5. `getStyleForNextShape`, `getDocumentSettings()`, `Box.FromPoints`, `createShapeId` — все экспортируются из `"tldraw"` (через `@tldraw/editor` re-export). Импорт-paths из плана корректны.


