# tldraw 5.x cheat-sheet for shemma agents

**Scope:** компактный справочник по API tldraw для тех частей кода и для subagent'ов, которые работают с canvas. Заполняется по мере investigation'ов.

> 📘 **Deep reference:** для полных enum'ов props, hidden required fields (типа `elbowMidPoint`, `snap`), migration mechanism, custom ShapeUtil template — см. **[`tldraw-5x-deep.md`](./tldraw-5x-deep.md)**. Этот файл — quick lookup; deep doc — авторитативный источник по precise типам и breaking changes.

**Правило (memory `feedback-tldraw-docs`):** перед написанием/чтением tldraw-кода — открой этот cheat-sheet и deep doc. Источники: official docs `tldraw.dev/sdk-features/*` + type reference `tldraw.dev/reference/*` + GitHub source при расхождении.

---

## 1. Системы координат (3 пространства)

| Space | Что это |
|---|---|
| **Screen** | пиксели окна браузера от top-left (`event.clientX/Y`) |
| **Viewport** | пиксели контейнера Editor от его top-left |
| **Page** | бесконечный canvas; координаты shapes фиксированы независимо от pan/zoom |

**Конвертация (методы Editor):**
```ts
editor.screenToPage(point)            // mouse → canvas
editor.pageToScreen(point)            // shape → DOM overlay
editor.pageToViewport(point)          // page → container-local
editor.getViewportScreenBounds()      // контейнер в screen-space
editor.getViewportPageBounds()        // видимая область в page-space
editor.inputs.getCurrentPagePoint()   // текущий курсор в page
editor.inputs.getOriginPagePoint()    // origin текущего жеста
```

---

## 2. Камера и viewport

**Конфиг (CameraOptions):** `isLocked`, `wheelBehavior` (`'pan'|'zoom'|'none'`), `panSpeed`, `zoomSpeed`, `zoomSteps`, `constraints { bounds, padding, origin, behavior }`.

`behavior` constraints: `'free'`, `'fixed'`, `'inside'`, `'outside'`.

**Программное управление:**
```ts
editor.setCamera({ x, y, z }, { animation: { duration, easing } })
editor.zoomToFit()                    // fit все shapes на странице
editor.zoomToSelection()              // fit выделение
editor.zoomToBounds(bounds, { inset, animation })  // fit заданный box
editor.centerOnPoint({ x, y }, { animation })
editor.slideCamera({ speed, direction, friction })  // momentum
```

**Гарантия:** при пользовательском взаимодействии анимации автоматически останавливаются — пользовательский ввод приоритетнее программного.

**Применимость к shemma:** [[DRW-075]] (camera not fit). После batch'а domain ops (`define + layout`) frontend обязан вызвать `zoomToFit()` или `zoomToBounds(getBoundsOfShapes())` хотя бы один раз — иначе viewport остаётся в (0,0,1) и контент за пределами.

---

## 3. Editor instance

**Получить:**
```tsx
<Tldraw onMount={(editor) => { /* save editor */ }} />
// или внутри Tldraw children:
const editor = useEditor()
```

**Shape CRUD:**
```ts
editor.createShape({ type, x, y, props })          // returns void; shape добавляется в store
editor.createShapes([{ ... }, { ... }])
editor.getShape(id)                                 // → TLShape | undefined
editor.getCurrentPageShapes()                       // → TLShape[]
editor.updateShape({ id, type, x?, y?, props? })
editor.deleteShapes([id, ...])                      // принимает array ids
editor.getShapesIntersectingPoint({ x, y })
```

**Store-доступ:**
```ts
editor.store.get(id)
editor.store.allRecords()                           // все записи (shapes + bindings + assets)
editor.store.listen(entry => { /* changes */ })
```

**Batching & history:**
```ts
editor.run(() => {
  editor.createShapes(many)
  editor.sendToBack(many)
})
editor.markHistoryStoppingPoint('name')
editor.undo() / editor.redo()
```

---

## 4. Default shapes (13 типов)

Полная таблица props (из `https://tldraw.dev/sdk-features/default-shapes`):

| Тип | Ключевые props |
|---|---|
| `text` | `richText`, `color`, `size`, `font`, `textAlign`, `autoSize`, `w` |
| `note` | `color`, `labelColor`, `richText`, `size`, `font`, `align`, `verticalAlign` |
| `geo` | `geo` (subtype), `w`, `h`, `richText`, `color`, `fill`, `dash`, `size`, `font`, `align`, `verticalAlign` |
| `draw` | `color`, `fill`, `dash`, `size`, `segments`, `isComplete`, `isClosed`, `isPen` |
| `line` | `color`, `dash`, `size`, `spline`, `points` |
| `highlight` | `color`, `size`, `segments`, `isComplete`, `isPen` |
| `image` | `w`, `h`, `assetId`, `crop`, `flipX`, `flipY`, `playing`, `altText` |
| `video` | `w`, `h`, `assetId`, `time`, `playing`, `autoplay`, `altText` |
| `bookmark` | `url`, `assetId`, `w`, `h` |
| `embed` | `url`, `w`, `h` |
| `frame` | `w`, `h`, `name`, `color` |
| `group` | empty props |
| `arrow` | `kind`, `start`, `end`, `bend`, **`elbowMidPoint`** (5.0+, required, default `0.5`), `color`, `arrowheadStart`, `arrowheadEnd`, `richText`, `labelPosition` |

**Геометрические subtypes для `geo`:** rectangle, ellipse, triangle, star, polygons, cloud, heart, directional arrows (полный enum уточнить — docs не enumerates все 20). Примеры подтипов: `'rectangle' | 'ellipse' | 'cylinder' | 'diamond' | 'hexagon' | 'star' | 'cloud'`.

### Критичная gotcha (memory `tldraw-richtext-shape-props`)

`text`, `note`, `geo` хранят надпись в **`richText`** (ProseMirror doc), НЕ в `text`. Простой `{ text: 'Hello' }` будет проигнорирован/упадёт на validate. Нужен helper типа `toRichText(plainString)` или `richTextHelpers.fromText(...)` (точное имя — уточнить в editor exports).

---

## 5. Arrows + Bindings (критично для DRW-076)

Arrow в tldraw 5.x — **shape `type='arrow'` + опциональные `binding` records**. Без bindings arrow существует с фиксированными terminal points; с bindings — terminals автоматически приклеиваются к source/target shapes и edge-routing работает.

### Структура TLBaseBinding
```ts
interface TLBaseBinding<Type, Props> {
  id: TLBindingId
  typeName: 'binding'
  type: Type                      // для arrows — 'arrow'
  fromId: TLShapeId               // обычно — arrowShape.id
  toId: TLShapeId                 // обычно — source или target node shape
  props: Props                    // зависит от type; для arrow: { normalizedAnchor, isPrecise, ... }
  meta: JsonObject
}
```

### Editor API
```ts
// CREATE
editor.createBinding({ type, fromId, toId, props })
editor.createBindings([{ ... }, { ... }])

// READ
editor.getBinding(bindingId)
editor.getBindingsFromShape(shapeId, bindingType?)     // исходящие
editor.getBindingsToShape(shapeId, bindingType?)       // входящие
editor.getBindingsInvolvingShape(shapeId, bindingType?)

// UPDATE
editor.updateBinding({ id, props: { ... } })

// DELETE
editor.deleteBinding(bindingId, { isolateShapes: true })
```

### Минимальный recipe: arrow со startBinding/endBinding

```ts
const rectId = createShapeId()
const circleId = createShapeId()
const arrowId = createShapeId()

editor.run(() => {
  editor.createShape({ id: rectId, type: 'geo', x: 100, y: 100, props: { geo: 'rectangle', w: 100, h: 60 } })
  editor.createShape({ id: circleId, type: 'geo', x: 400, y: 100, props: { geo: 'ellipse', w: 100, h: 60 } })
  editor.createShape({ id: arrowId, type: 'arrow' })

  editor.createBindings([
    { type: 'arrow', fromId: arrowId, toId: rectId,
      props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false } },
    { type: 'arrow', fromId: arrowId, toId: circleId,
      props: { terminal: 'end',   normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false } },
  ])
})
```

**Подтверждено (по investigation DRW-076, 2026-05-18):** структура binding props для arrow — `{ terminal: 'start' | 'end', normalizedAnchor: {x,y}, isPrecise: boolean, isExact: boolean, snap: ElbowArrowSnap }`. Bindings создаются отдельными записями `typeName: 'binding'`, `fromId = arrowId`, `toId = nodeId`.

> ⚠️ **`snap: ElbowArrowSnap`** добавлено в v5 (см. [tldraw-5x-deep.md §3](./tldraw-5x-deep.md#3-tlarrowbindingprops--точная-схема)). В narrative docs не упомянуто, в type reference присутствует. Если ваш код создаёт arrow bindings вручную — выставляйте `snap` явно или ловите тот же ValidationError, что DRW-076. В shemma: `apps/backend/src/domain/compile.ts:makeArrowBindings` сейчас НЕ выставляет — кандидат на DRW-079.

### Gotcha 5.0+: обязательное `elbowMidPoint` в arrow props

Начиная с tldraw 5.0.0 `TLArrowShapeProps` содержит обязательное поле `elbowMidPoint: number` (default `0.5`). Если создаёшь arrow shape для последующего `editor.loadSnapshot()` — поле **должно** быть в `props`, иначе `ValidationError: At shape(type = arrow).props.elbowMidPoint: Expected number, got undefined`. Ошибка молча подавляется в `mergeRemoteChanges` (try/catch внутри tldraw), и shape не попадает в store — снаружи выглядит как "стрелки не отрисовываются".

Источник: `node_modules/.bun/@tldraw+tlschema@5.0.0/.../index.d.ts` line ~3305.

См. [[DRW-076]] — root cause в `apps/backend/src/domain/compile.ts:56` (`makeArrowShape`) — поле не выставляется.

### Что проверять при отладке "arrow не виден" (DRW-076 checklist)

1. `editor.store.allRecords().filter(r => r.typeName === 'shape' && r.type === 'arrow')` — есть ли вообще arrow shapes?
2. Если нет — sync-слой не создаёт shape. Искать в коде где applyOp обрабатывает `type='connection'`.
3. Если есть, но визуально нет — посмотреть `arrow.x / y / props.start / props.end`: terminal'ы могут быть за viewport или совпадать в одной точке.
4. `editor.getBindingsToShape(arrowId)` — есть ли bindings? Без bindings arrow живёт по `props.start / props.end` как absolute coords (если они в виде `{ type: 'point', x, y }`). Если код пытается передать `{ type: 'binding', boundShapeId }` без отдельного TLArrowBinding record — arrow висит как orphan.
5. `editor.zoomToFit()` — если стрелки появляются после zoomToFit, проблема в viewport (DRW-075), не в sync.

---

## 6. Shape transforms / layout helpers

```ts
editor.groupShapes(ids) / editor.ungroupShapes(ids)
editor.alignShapes(ids, 'left'|'right'|'top'|'bottom'|'center-horizontal'|'center-vertical')
editor.distributeShapes(ids, 'horizontal'|'vertical')
editor.stackShapes(ids, 'horizontal'|'vertical', gap)
editor.packShapes(ids, gap)
editor.flipShapes(ids, 'horizontal'|'vertical')
editor.rotateShapesBy(ids, angleRadians)
```

> Эти helpers — built-in layout, БЕЗ ELK. Shemma uses dagre/elk поверх (см. `packages/domain/layout`). Стоит понять, что нативные `stackShapes/packShapes` могут заменить часть сценариев dagre, если они достаточны.

---

## 7. Auto-resize / auto-grow shape под label

Документация **не описывает** built-in auto-grow для произвольных shapes. Подход:

1. На каждое изменение label измерять text bounding box (через canvas measureText / DOM).
2. `editor.updateShape({ id, props: { w: newW, h: newH } })`.
3. Пересчитывать geometry в `ShapeUtil.getGeometry(shape)` — `Rectangle2d({ width: shape.props.w, height: shape.props.h })`.

**Применимость к shemma:** [[DRW-077]] (label overflow). Shemma'овский ShapeUtil для domain-нод должен либо `autoSize: true` (как у text shape), либо ручной resize в side-effect на label change. Сейчас — ни то, ни другое.

---

## 8. URLs — известные рабочие vs 404

**Working (проверено 2026-05-18):**
- `https://tldraw.dev/sdk-features/coordinates`
- `https://tldraw.dev/sdk-features/camera`
- `https://tldraw.dev/sdk-features/bindings`
- `https://tldraw.dev/sdk-features/editor`
- `https://tldraw.dev/sdk-features/shape-transforms`
- `https://tldraw.dev/sdk-features/default-shapes`
- `https://tldraw.dev/llms.txt` (карта всех topics, only structure не content)

**404 на момент сборки (искать альтернативу):**
- `https://tldraw.dev/sdk-features/arrows` ← **критично для DRW-076**, найти через `/llms-medium.txt` или `/llms-small.txt`, либо смотреть `@tldraw/tldraw` repo examples
- `https://tldraw.dev/docs/<anything>` — корень `/docs/` не существует, всё под `/sdk-features/`

**Не проверено (вероятно есть):**
- `https://tldraw.dev/sdk-features/geometry`
- `https://tldraw.dev/sdk-features/shape-clipping`
- `https://tldraw.dev/sdk-features/shape-indexing`
- `https://tldraw.dev/sdk-features/handles`
- `https://tldraw.dev/sdk-features/persistence`
- `https://tldraw.dev/sdk-features/store`
- `https://tldraw.dev/sdk-features/signals`

---

## 9. Связки с shemma-кодом (заполнить по investigation)

| Тема tldraw | Где в shemma | Backlog |
|---|---|---|
| richText vs text | `apps/backend/src/domain/compile.ts` (makeArrowShape — уже использует richText) | — |
| arrow + bindings | `apps/backend/src/domain/compile.ts` (`makeArrowShape` строки 40–77; `makeArrowBindings` 80–100; `case "connect"` 189–210) | [[DRW-076]] |
| schema backfill для legacy rooms | `apps/frontend/src/canvas/schema-placeholder.ts` (`backfillStoreRecords` — backfill `kind:"arc"`, нужно добавить `elbowMidPoint`) | [[DRW-076]] |
| Snapshot load + WS apply | `apps/backend/src/transport/ws.ts` (store-change broadcast); `apps/frontend/src/App.tsx:146-148` (`loadSnapshot`) | — |
| zoomToFit / camera | `apps/frontend/src/App.tsx` — `hydrateAndSync` блок camera restore + `scheduleAiZoom` (debounced post-AI fit с guard inProgrammaticCameraOp); listener `editor.store.listen({source:'user', scope:'session'})` для detection user pan | [[DRW-075]] ✅ 0.14.2 |
| autoSize / shape resize | role-preset.ts defaults bump (220×80) + `triggerGrowY` (no-op due to identity-equal props в tldraw 5.x — research DRW-081); долгосрочно — Mermaid pivot | [[DRW-077]] ✅ 0.14.2 part A; [[DRW-081]] research closed |
| frame children parent-relative | `apps/backend/src/domain/layout.ts` runLayout — для shape с parentId in frameIds subtract parent's abs position перед записью | [[DRW-082]] ✅ 0.14.4 |
| frame.props.color required | `compile.ts:226` (makeFrameShape) + backfill `schema-placeholder.ts` | [[DRW-080]] ✅ 0.14.3 |
| ELK spacing для dense graphs | `packages/shemma-domain/src/layout-modes.ts` SPACING_PRESETS + layered between-layers + edge-label spacing | [[DRW-079]] ✅ 0.14.3 |
| Mermaid import + hybrid workflow | `apps/frontend/src/canvas/mermaid-import.ts` (importMermaid через `@tldraw/mermaid.createMermaidDiagram` + slugify didrawName); ⌘M hotkey + `window.shemmaImportMermaid(source)` console fallback | [[DRW-053]] ✅; [[DRW-067]] docs ✅ 0.14.4 |

**TODO:** subagent DRW-076 после investigation должен дополнить эту таблицу конкретными `file:line`.

---

## 10. Mermaid-first / hybrid workflow

Для сложных диаграмм (≥10 нод, длинные multi-line labels, type signatures) manual `shemma_define → shemma_connect → shemma_layout` даёт **tight/cramped output**:
- `geo` labels не shrink-to-fit программно (нет public auto-resize API в tldraw 5.x — [[DRW-081]]).
- ELK layered routing crowds parallel edges в dense graphs.

**Solution: Mermaid import + incremental shemma_define для tweaks.**

### Path

1. **UI**: ⌘M / Ctrl+M открывает modal — paste mermaid source.
2. **Programmatic**: `window.shemmaImportMermaid("flowchart LR\n  A --> B")` в DevTools console.
3. `@tldraw/mermaid.createMermaidDiagram(editor, source)` парсит + лэйаут'ит mermaid'овским engine'ом, пишет shapes через `editor.createShape` — это **триггерит `onBeforeCreate`** → `calculateGrowY` отрабатывает (label overflow не возникает; manual path этот hook ловит мимо store.put).
4. Каждый imported node получает `meta.didrawName` (slugified label) → **domain-aware**; `shemma_define`/`connect`/`layout` находят shapes по этому имени.
5. WS sync шлёт shapes в backend автоматически (без manual `sendPatch`).

### Post-import interactivity

| Действие | Команда | Поведение |
|---|---|---|
| Добавить ноду | `shemma_define { name: "x", role: "service" }` | Append поверх imported шейпов |
| Соединить с imported | `shemma_connect { from: "<imported_slug>", to: "x", connectionKind: "sync" }` | Резолвится по didrawName |
| Обернуть в group | `shemma_group { name, as: "boundary", ids: [...] }` | Создаёт frame container с children |
| Ungroup imported | `editor.ungroupShapes([rootId])` в console | Bindings сохраняются (id-based), edges + labels OK |
| Re-layout всё | `shemma_layout { mode, scope: "all" }` | Mixed imported+manual работает uniformly |

### Когда что использовать

- **Mermaid-first**: ≥10 нод, длинные labels, AI знает mermaid representation цели.
- **Manual shemma_define**: iterative (≤5 нод), additive design, нет mermaid в контексте.
- **Hybrid** (recommended): mermaid для bulk → shemma_define для incremental → один `shemma_layout` в конце.

Source: `apps/frontend/src/canvas/mermaid-import.ts` (`importMermaid`) + ADR `docs/decisions/0001-mermaid-import-location.md`.

---

## 11. Расширение этого документа

- Любая новая investigation → одна-две строки сюда (что нашёл + URL источника).
- При расхождении type-defs vs docs — **docs primary** (см. `feedback-tldraw-docs`); type defs точнее для precise schemas (новые required fields).
- Не дублировать tldraw docs целиком — фиксировать только то, что неочевидно из типов или укусило в shemma.
