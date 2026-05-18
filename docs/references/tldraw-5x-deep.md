# tldraw 5.x — глубокий технический справочник

> **Источник:** параллельное research-расследование пользователя (2026-05-18), собранное из официальной docs `tldraw.dev`, type reference, GitHub source `tldraw/packages/tlschema/`.
>
> Этот документ — **deep reference**, используется в дополнение к `tldraw-cheatsheet.md` (там — компактный быстрый справочник). Если в основном cheat-sheet'е что-то расходится с этим документом — **доверяй этому**, потому что здесь источники прямо из type-defs и GitHub source.

---

## 1. `TLArrowShape.props` — полный enum (v5.x)

Из `getDefaultProps()` в `ArrowShapeUtil`:

```ts
{
  // --- REQUIRED ---
  kind:          'arc' | 'elbow'    // только два значения! 'straight' НЕТ — straight = arc с bend:0
  start:         VecModel           // { x, y } в local shape space
  end:           VecModel           // { x, y }
  bend:          number             // 0 = прямая, >0 = по часовой, <0 = против (только для arc)
  elbowMidPoint: number             // 0.5 — положение midpoint elbow segment (0..1)
  arrowheadStart: TLArrowheadType   // 'none'|'arrow'|'bar'|'dot'|'diamond'|'inverted'|'pipe'|'square'|'triangle'
  arrowheadEnd:   TLArrowheadType
  richText:       TLRichText        // метка стрелки (ProseMirror doc)
  labelPosition:  number            // 0..1, default 0.5
  font:   'draw'|'sans'|'serif'|'mono'
  size:   's'|'m'|'l'|'xl'
  color:  TLDefaultColorStyle
  labelColor: TLDefaultColorStyle
  fill:   TLDefaultFillStyle
  dash:   TLDefaultDashStyle
  scale:  number                    // default 1
}
```

**Критично:**
- `kind: 'straight'` **не существует** — в v5 только `'arc' | 'elbow'`. Прямая = `kind: 'arc'` с `bend: 0`.
- `elbowMidPoint` присутствует в props **всегда** (включая arc-стрелки), просто игнорируется если `kind !== 'elbow'`. **Скрытый required-field** — при ручном создании arrow через `store.put()` нужно явно передавать `elbowMidPoint: 0.5`.

**В shemma:** [[DRW-076]] — точная причина: `apps/backend/src/domain/compile.ts:makeArrowShape` не выставлял `elbowMidPoint`, валидатор отвергал shape.

---

## 2. Start/End terminals — структура

В v5 `start`/`end` в props стрелки — **только** `VecModel` (`{ x, y }`), координаты в local shape space. Структуры `{ type: 'binding', boundShapeId, ... }` в props стрелки **нет** (это v4-схема).

**Binding вынесен в отдельный record `TLArrowBinding`:**

```ts
{
  typeName: 'binding',
  type: 'arrow',
  fromId: TLShapeId,         // id стрелки
  toId: TLShapeId,           // id целевого shape
  props: TLArrowBindingProps
}
```

`start`/`end` в props стрелки хранят **последнее известное положение** endpoint'а (fallback при удалении bound shape). Binding имеет приоритет: если binding существует — координаты вычисляются из него, значения в `start`/`end` игнорируются для отображения, но обновляются при движении.

---

## 3. `TLArrowBindingProps` — точная схема

```ts
interface TLArrowBindingProps {
  terminal:          'start' | 'end'    // к какому концу стрелки
  normalizedAnchor:  VecModel           // { x: 0..1, y: 0..1 } — якорь в пространстве bound shape
  isPrecise:         boolean            // true = точный якорь; false = середина shape
  isExact:           boolean            // true = arrow "входит" в shape к точке якоря (Alt при drag)
  snap:              ElbowArrowSnap     // ⚠️ НОВОЕ в v5! специфично для elbow-стрелок
}
```

**`snap: ElbowArrowSnap`** — добавлено в v5 вместе с elbow arrows. **Не документировано в narrative arrow docs**, но присутствует в type reference. Значения — enum для snap-поведения elbow endpoint (центр/край/directional point shape).

**В shemma — потенциальная проблема:** `makeArrowBindings` в `apps/backend/src/domain/compile.ts:85-99` не выставляет `snap`. Если поле required в validator'е — это второй DRW-076-класса баг (см. [[DRW-079]] кандидат на backlog).

---

## 4. Schema migrations — built-in механизм

tldraw имеет полноценный built-in migration механизм. Ручной `backfillStoreRecords` (как в shemma frontend) — workaround.

**Для custom shapes:**
```ts
import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from 'tldraw'

const versions = createShapePropsMigrationIds('my-shape', { AddElbowMidPoint: 1 })

const migrations = createShapePropsMigrationSequence({
  sequence: [{
    id: versions.AddElbowMidPoint,
    up(props)   { props.elbowMidPoint ??= 0.5 },
    down(props) { delete props.elbowMidPoint },
  }],
})

class MyShapeUtil extends ShapeUtil<MyShape> {
  static override migrations = migrations
}
```

**Для meta/store-level** — `createMigrationIds` + `createMigrationSequence` со `scope: 'record'` или `'store'`.

**Legacy snapshots без новых полей:** при `loadSnapshot` store автоматически прогоняет миграции в порядке версий, `up`-мигратор добавляет default. Никаких `ValidationError` при правильно написанных миграциях.

**В shemma:** сейчас используется ручной `backfillStoreRecords` (`apps/frontend/src/canvas/schema-placeholder.ts`). Кандидат на улучшение — перевести на нативный migration mechanism (отдельный issue в backlog).

---

## 5. `loadSnapshot` — поведение при ValidationError

- Выполняется **транзакционно через `store.atomic()`**. При validation error вся транзакция откатывается, **partial-apply не бывает**.
- В `mergeRemoteChanges` (multiplayer WS path) ошибки валидации **логируются в console, не пробрасываются** — намеренная resilience.
- В `loadSnapshot` ошибка пробрасывается как exception.

**Подписка на validation errors встроенно отсутствует.** Паттерн:
```ts
try {
  loadSnapshot(editor.store, snapshot)
} catch (e) {
  console.error('Snapshot validation failed:', e)
}
```

Или через `store.listen` + diff. Кастомный validator — через `createTLSchema({ validator })`.

---

## 6. Программный `zoomToFit` — правильный паттерн ([[DRW-075]])

```tsx
<Tldraw
  snapshot={snapshot}
  onMount={(editor) => {
    // snapshot уже загружен к этому моменту
    editor.zoomToFit({ animation: { duration: 0 } })           // без анимации для initial
    // или с анимацией:
    // editor.zoomToFit({ animation: { duration: 300, easing: EASINGS.easeInOutCubic } })
  }}
/>
```

**Race condition:** camera animations автоматически прерываются при user input (pan/zoom). Дополнительно защищаться не нужно.

В multiplayer: проверить `editor.getInstanceState().followingUserId` перед вызовом если нужно избежать конфликта.

---

## 7. `zoomToBounds` — точные параметры

```ts
editor.zoomToBounds(bounds, {
  inset: 100,          // padding в screen pixels (НЕ page pixels)
  targetZoom: 1,       // максимальный zoom
  animation: { duration: 500, easing: EASINGS.easeInOutCubic },
})
```

**Bounds всех shapes текущей страницы:**
```ts
const bounds = editor.getCurrentPageBounds()   // Box | undefined
if (bounds) editor.zoomToBounds(bounds, { inset: 50 })
```

`editor.getCurrentPageBounds()` → `Box2d` с `.x, .y, .w, .h`.

---

## 8. `CameraOptions` constraints для auto-fit

```ts
editor.setCameraOptions({
  constraints: {
    bounds: editor.getCurrentPageBounds() ?? { x: 0, y: 0, w: 1920, h: 1080 },
    padding: { x: 50, y: 50 },
    origin: { x: 0.5, y: 0.5 },
    initialZoom: 'fit-min',     // подбирает zoom чтобы всё влезло
    baseZoom: 'default',
    behavior: 'inside',         // user не может выйти за пределы контента
  },
})
```

**Рекомендация для [[DRW-075]]:** не `'inside'`, а **`onMount + zoomToFit`** + свободная навигация. Constraints — только когда нужно жёстко ограничить viewport (read-only embedded viewer и т.п.).

`behavior` варианты: `'free'`, `'fixed'`, `'inside'`, `'outside'`, `'contain'`.

---

## 9. `autoSize` на default shapes ([[DRW-077]])

| Shape type | `autoSize: true` | Поведение |
|---|---|---|
| `text` | ✅ да, в props | Растёт по содержимому, нет фиксированного w/h |
| `geo` | ❌ нет в props | Фиксированный размер, richText clipped/wrapped |
| `note` | ✅ де-факто | Авторазмер по тексту |

**Для `geo` + richText auto-resize:** реализуется через `ShapeUtil.onBeforeUpdate` или side effects (см. §11, 16). Нативного `autoSize` у geo НЕТ.

---

## 10. `richText` measurement

Прямого `editor.textMeasure.measureText(richText, opts)` для richText в публичном API нет.

Паттерны:
```ts
// (1) Через ShapeUtil — DOM-based measurement (пример "dom-based shape size" в tldraw docs)
// В component() рендерить в hidden div, измерять getBoundingClientRect()

// (2) editor.textMeasure для plain text:
const { w, h } = editor.textMeasure.measureText('text', {
  fontFamily: 'sans',
  fontSize: 16,
  lineHeight: 1.4,
  maxWidth: 200,
  padding: '0px',
})
```

Для richText (TipTap/ProseMirror) — нет готового API. Рекомендация: создать shape с `autoSize`-логикой через `afterCreate` side effect и пересчитать `w/h` после первого рендера.

---

## 11. `ShapeUtil` hooks для auto-resize

`onBeforeCreate` / `onBeforeUpdate` — правильное место:

```ts
class MyShapeUtil extends ShapeUtil<MyShape> {
  override onBeforeCreate(shape: MyShape): MyShape {
    const measured = this.measureContent(shape.props.richText)
    return { ...shape, props: { ...shape.props, w: measured.w, h: measured.h } }
  }

  override onBeforeUpdate(prev: MyShape, next: MyShape): MyShape {
    if (prev.props.richText !== next.props.richText) {
      const measured = this.measureContent(next.props.richText)
      return { ...next, props: { ...next.props, w: measured.w, h: measured.h } }
    }
    return next
  }
}
```

**Через side effects (если нужно реагировать на изменения вне ShapeUtil):**
```ts
editor.sideEffects.registerAfterChangeHandler('shape', (prev, next, source) => {
  if (next.type === 'my-shape' && prev.props.richText !== next.props.richText) {
    const newSize = computeSize(next.props.richText)
    editor.updateShape({ id: next.id, type: next.type, props: newSize })
  }
})
```

`getMinDimensionsForContent` как отдельного hook'а в ShapeUtil API **нет** — реализуется через `onBeforeCreate/onBeforeUpdate`.

---

## 12. Text wrapping в geo + richText

- **Wrap:** текст переносится если не влезает по ширине — дефолт.
- **Overflow:** clip'ируется по `h` shape, **нет ellipsis нативно**.
- **`align`:** `'start'|'middle'|'end'|'justify'`
- **`verticalAlign`:** `'start'|'middle'|'end'`
- **`size`:** `'s'|'m'|'l'|'xl'` — enum шага из `DefaultSizeStyle` (~12/16/21/28px при scale=1).

Для overflow:ellipsis — нужен кастомный `component()` в ShapeUtil.

---

## 13. `Geometry2d` API

```ts
import { Rectangle2d, Polygon2d, Ellipse2d } from 'tldraw'

const rect = new Rectangle2d({ x: 0, y: 0, width: 100, height: 50, isFilled: true })

rect.bounds                                  // Box { x, y, w, h, minX, maxX, ... }
rect.center                                  // Vec
rect.getVertices()                           // Vec[]
rect.nearestPoint(point)                     // Vec
rect.hitTestPoint(p, margin, hitInside)      // boolean
rect.hitTestLineSegment(a, b, margin)        // boolean
rect.intersectLineSegment(a, b)              // Vec[]
```

---

## 14. Persistence — snapshot format

```ts
interface TLStoreSnapshot {
  store: Record<string, TLRecord>     // все records по id
  schema: SerializedSchema            // версии всех типов
}

// TLEditorSnapshot = { document: TLStoreSnapshot, session: TLSessionStateSnapshot }
```

`SerializedSchema`: `{ schemaVersion: number, sequences: Record<string, number> }`. При `loadSnapshot` сравниваются versions, запускаются нужные up-миграции.

---

## 15. Store API: `put` vs `editor.createShapes`

| Операция | `editor.store.put()` | `editor.createShapes()` |
|---|---|---|
| Валидация | да | да + ShapeUtil.onBeforeCreate |
| Side effects | нет | да (sideEffects handlers) |
| History/undo | зависит от контекста | да |
| Когда использовать | низкоуровневые данные, migrations, custom records | создание/обновление shapes |

`store.put()` байпасит ShapeUtil hooks и side effects — осторожно. Для shapes предпочтительно `editor.createShapes()` / `editor.updateShape()`.

---

## 16. Side effects для auto-grow (рецепт для [[DRW-077]])

```ts
// В onMount:
editor.sideEffects.registerAfterChangeHandler('shape', (prev, next, source) => {
  if (next.type !== 'my-domain-node') return
  if (prev.props.richText === next.props.richText) return

  const { w, h } = measureRichText(next.props.richText, next.props)
  if (w !== next.props.w || h !== next.props.h) {
    editor.updateShape({
      id: next.id, type: next.type,
      props: { ...next.props, w, h }
    })
  }
})
```

`registerOperationCompleteHandler` — для батч-обновлений (один вызов на транзакцию, не на каждый record).

---

## 17. Handles API

```ts
class MyShapeUtil extends ShapeUtil<MyShape> {
  override getHandles(shape: MyShape): TLHandle[] {
    return [{
      id: 'custom-handle',
      type: 'vertex',       // 'vertex' | 'virtual' | 'create'
      x: shape.props.w / 2,
      y: 0,
      canSnap: true,
    }]
  }

  override onHandleDrag(shape: MyShape, info: TLHandleDragInfo): Partial<MyShape> {
    return { props: { ...shape.props, customProp: info.handle.x } }
  }
}
```

---

## 18. Custom ShapeUtil — минимальный template с auto-resize

```ts
import { ShapeUtil, Rectangle2d, T, HTMLContainer, TLBaseShape } from 'tldraw'

type DomainNodeProps = { w: number; h: number; label: string }
type DomainNodeShape = TLBaseShape<'domain-node', DomainNodeProps>

export class DomainNodeUtil extends ShapeUtil<DomainNodeShape> {
  static override type = 'domain-node' as const
  static override props = { w: T.number, h: T.number, label: T.string }

  getDefaultProps(): DomainNodeProps {
    return { w: 160, h: 64, label: '' }
  }

  getGeometry(shape: DomainNodeShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  override onBeforeUpdate(prev: DomainNodeShape, next: DomainNodeShape) {
    if (prev.props.label === next.props.label) return next
    const measured = measureLabel(next.props.label)
    return { ...next, props: { ...next.props, ...measured } }
  }

  component(shape: DomainNodeShape) {
    return (
      <HTMLContainer style={{
        width: shape.props.w, height: shape.props.h,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'white', border: '1px solid black', borderRadius: 8
      }}>
        {shape.props.label}
      </HTMLContainer>
    )
  }

  indicator(shape: DomainNodeShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />
  }
}
```

---

## 19. Validation — переопределение

```ts
import { createTLSchema, T, defaultShapeSchemas } from 'tldraw'

const schema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    // кастомные shape'ы с собственным validator'ом
  },
})
```

Для built-in shapes публичный API переопределения validator'а **отсутствует** — только через fork. Альтернатива — migrations для forward-совместимости.

---

## 20. Changelog 5.x — arrow-relevant breaking changes

1. **`kind: 'straight'` удалён** — только `'arc' | 'elbow'`. Прямая = arc + `bend: 0`.
2. **Terminal structure изменилась:** v4 имел `{ type: 'binding', ... }` в `props.start/end` → v5 вынес в отдельный binding record.
3. **`elbowMidPoint` добавлен** как required prop вместе с `kind: 'elbow'`.
4. **`snap: ElbowArrowSnap`** добавлен в `TLArrowBindingProps`.
5. **`richText` вместо `text`** для arrow-метки — поле метки изменило тип.

**Стратегия миграции legacy snapshots:**
```ts
{
  id: versions.MigrateArrowKind,
  up(props) {
    if (props.kind === 'straight') props.kind = 'arc'
    props.elbowMidPoint ??= 0.5
  }
}
```

---

## 21. Type defs vs docs — где истина

**Правило (уточняет `feedback-tldraw-docs`):**
- В большинстве случаев **docs primary** (концептуальные контракты, рекомендуемые паттерны).
- НО при расхождении в **типах/precise схеме** — **type defs точнее**, потому что генерируются из реального исходника.
- При сомнении — проверять GitHub source `tldraw/packages/tlschema/src/shapes/TLArrowShape.ts` (и подобные для других shapes/bindings).

Пример: `TLArrowBindingProps.snap` присутствует в type reference, но отсутствует в narrative arrow docs. Здесь types актуальнее.

---

## Sources

- [ArrowShapeUtil — Mintlify mirror](https://mintlify.wiki/tldraw/tldraw/api/shapes/arrow)
- [TLArrowBindingProps — tldraw Docs](https://tldraw.dev/reference/tlschema/TLArrowBindingProps)
- [TldrawBaseProps — tldraw Docs](https://tldraw.dev/reference/tldraw/TldrawBaseProps)
- [GitHub: TLArrowShape.ts source](https://github.com/tldraw/tldraw/blob/main/packages/tlschema/src/shapes/TLArrowShape.ts)
- [ArrowShapeOptions — tldraw Docs](https://tldraw.dev/reference/tldraw/ArrowShapeOptions)
- [Save and load snapshots — example](https://tldraw.dev/examples/snapshots)
- [Persistence — tldraw Docs](https://tldraw.dev/docs/persistence)
- [Schema and types — Mintlify](https://tldraw-tldraw.mintlify.app/api/schema)
- [Community: tldraw reference for coding agents (gist)](https://gist.github.com/buwilliams/31d5f4f7849753e7b299a76e6667daaf)

---

## Связки с shemma backlog (по этому документу)

| Тема | Файл shemma | Tickets |
|---|---|---|
| arrow.props.elbowMidPoint (§1) | `apps/backend/src/domain/compile.ts:makeArrowShape` | [[DRW-076]] ✅ fixed |
| arrow binding.props.snap (§3) | `apps/backend/src/domain/compile.ts:makeArrowBindings` | DRW-079 candidate (см. §3 выше) |
| migration mechanism (§4) | `apps/frontend/src/canvas/schema-placeholder.ts:backfillStoreRecords` | Improvement candidate — заменить ручной backfill на нативный |
| onMount + zoomToFit (§6) | frontend bootstrap (поиск нужен) | [[DRW-075]] |
| onBeforeUpdate / side effects (§11, 16) | ShapeUtil для shemma node (поиск нужен) | [[DRW-077]] |
| createShapes vs store.put (§15) | sync-слой (применение batch) | — |
| `kind: 'straight'` устарел (§20) | makeArrowShape — уже использует `kind: 'arc'` | — (уже корректно) |
