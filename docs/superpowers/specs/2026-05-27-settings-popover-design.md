# Settings Popover — Design Spec

**Дата:** 2026-05-27
**Статус:** v0.1 — proposal
**Связано:** DRW-178 follow-ups (DRW-179/180/181/182), Phase 3 LayoutParams (`packages/shemma-domain/src/layout-params.ts`)

---

## 1. Goal

Дать пользователю unified, opt-in UI для управления настройками, специфичными для shemma, которых нет в default tldraw style panel: per-shape (Direction для schema-container, Pin size/position, Role), per-selection (Tidy, Force re-layout, групповой Direction, bulk Pin) и per-board (LayoutParams с presets + Advanced drill-down).

UI не появляется автоматически при выделении — открывается только по явному gesture'у (Option + click), не конкурирует с tldraw'овской style panel.

## 2. Non-goals (out of scope v1)

- BoardPanel · `Styles` секция — пустой stub в v1; реальные default style controls — следующая итерация.
- Per-container `layoutParamsOverride` (drill-down "Tune layout params →" из ContainerPanel) — отложен; v1 только board-level + per-container Direction (уже работает).
- Mobile / touch — desktop-only.
- Анимация popover'а (slide-in, fade) — instant show/hide.
- Drag-handle для перемещения popover'а — anchor'нут к target, без free move.
- Замена существующих hotkey'ев (⌘⇧L, ⌘M, ⌘K) и ContextMenu — popover дополняет, не заменяет.

## 3. Architecture

Один новый React-компонент `<SettingsPopover />` регистрируется через tldraw `components.InFrontOfTheCanvas` slot — overlay поверх canvas, не двигается с камерой. Внутри живут изолированные Panel'и + sections + thin API wrapper.

```
apps/frontend/src/settings/
├─ SettingsPopover.tsx       ← root: slot + selects panel by target.kind
├─ useSettingsTrigger.ts     ← hook: gesture, target, anchor, dismiss
├─ panels/
│   ├─ SelectionPanel.tsx    ← single Frame / multi-selection / single container
│   ├─ NodePanel.tsx         ← non-container shape with meta.didrawId
│   └─ BoardPanel.tsx        ← LayoutParams + presets + Advanced drill-down
├─ sections/
│   ├─ DirectionSection.tsx
│   ├─ LayoutSection.tsx
│   ├─ PinSection.tsx
│   ├─ RoleSection.tsx
│   └─ StylesSection.tsx     ← stub в v1
└─ api.ts                    ← typed HTTP wrappers
```

### Boundaries

- **`SettingsPopover`** — не знает содержимое панелей. Выбирает Panel по `target.kind`, передаёт `target` вниз.
- **`useSettingsTrigger`** — единственное место с gesture detection / dismiss logic. Возвращает `{ open, target, anchor, openAt, close }`.
- **Panel'и** — composition из sections; делают `useValue` для live state.
- **Section'ы** — атомарные, изолированы от popover'а; принимают только props и колбэки.
- **`api.ts`** — fetch-обёртки, тестируемо без UI.

### Что НЕ меняем

- `apps/frontend/src/chrome/TldrawComponents.tsx` (ContextMenu / Toolbar / SharePanel) — остаётся как есть. Direction submenu в ContextMenu продолжает работать параллельно popover'у.
- Все hotkey'и (⌘⇧L / ⌘M / ⌘K / Esc) — без изменений.
- `apps/frontend/src/shapes/schema-container/SchemaContainerAutoFlip.ts` — без изменений.

## 4. Trigger & positioning

### Gesture detection

`useSettingsTrigger` подписывается на DOM `pointerdown` в capture phase на корневом `.tl-container`. Алгоритм:

```text
on pointerdown (capture):
  if not e.altKey: return                  ← не наш жест
  e.preventDefault()                       ← гасим tldraw Alt-drag-clone
  e.stopPropagation()
  const screenPt = { x: e.clientX, y: e.clientY }
  const pagePt   = editor.screenToPage(screenPt)
  const hit      = editor.getShapeAtPoint(pagePt)
  const selected = editor.getSelectedShapeIds()

  // Resolve target
  if hit && selected.includes(hit.id) && selected.length > 1:
    open({ kind: "selection", anchor: bbox(selected) })
  else if hit:
    if hit.type === "schema-container":
      open({ kind: "selection", anchor: bbox([hit.id]) })   ← single Frame = selection
    else if hit.meta?.didrawId:
      open({ kind: "node", subjectId: hit.id, anchor: bbox(hit) })
    else:
      ← no extras → no popover (fall through to tldraw default behavior)
  else if selected.length >= 1:
    open({ kind: "selection", anchor: bbox(selected) })
  else:
    open({ kind: "board", anchor: screenPt })
```

**Note 1:** одиночный schema-container (Frame) — это особый случай: рассматриваем его как `selection of size 1` → открываем SelectionPanel. Это даёт единообразие Direction/Layout для одного Frame и для multi-selection с containers.

**Note 2:** для shapes без `meta.didrawId` (default tldraw shapes без semantic meta) popover НЕ открывается; Alt-click работает по tldraw default behavior (e.g. Alt-drag clone).

### Closing conditions

Popover закрывается на любое из:
- `Escape` key
- pointerdown outside `.settings-popover` (внутри popover'а — клики не закрывают)
- camera move (programmatic `setCamera` ИЛИ user pan/zoom; detection через `editor.store.listen({ scope: "session" })`)
- subject shape deleted (для `kind: "node"` / `kind: "selection"` — Panel ловит `useValue(... → undefined)` и зовёт `close()`)
- selection changes на kind="selection" — простая модель: close (можно re-open Option-click'ом)

### Positioning

Popover — absolute-positioned div в screen-space, внутри `InFrontOfTheCanvas` слота. Pseudocode:

```text
anchorPage  = target.anchor          // page coords for shape/selection; screen coords for board
anchorScreen = (target.kind === "board")
  ? target.anchor                    // pointer position pre-resolved
  : editor.pageToScreen(anchorPage)  // pageToScreen recomputed on camera changes

// Side preference: under anchor +8px; flip to above if not enough vertical space
position = clampToViewport(anchorScreen + offset, popoverSize, viewport, margin: 16)
```

`pointer-events: auto` на корне popover'а — необходимо, т.к. `InFrontOfTheCanvas` слот обычно `pointer-events: none`. Внутри popover'а — нормальная DOM-интерактивность.

## 5. Panel composition

Унифицированный порядок секций: **Direction → Layout → Size & Position → Role → Styles → Advanced**.
Секция пропускается, если не применима к target.

### SelectionPanel

Используется для: одиночный schema-container, multi-selection (с containers или без), single Frame.

Footer-counter: `"1 container"`, `"2 containers, 5 nodes"`, `"7 shapes"`.

| Секция         | Видна когда                              | Контролы                                                      |
|----------------|------------------------------------------|---------------------------------------------------------------|
| Direction      | ≥1 schema-container в выборке             | 5 button-toggle: `TB / LR / BT / RL / custom` (применяется ко всем containers) |
| Layout         | всегда                                    | `Tidy ⌘⇧L`, `Force re-layout ⌘⇧⌥L`                            |
| Size & Position| всегда                                    | toggle: 📌 size · 📌 position (label "all" появляется когда selection ≥ 2) |

### NodePanel

Используется для: одна shape с `meta.didrawId`, type ≠ "schema-container".

| Секция         | Контролы                                          |
|----------------|---------------------------------------------------|
| Size & Position| 📌 size (`meta.didrawSizePinned`) · 📌 position (`meta.pinned`) |
| Role           | текущий role + inline role-picker (reuses existing role-picker logic) |

### BoardPanel

Используется для: target.kind === "board" (Option на пустоту).

| Секция     | Контролы                                                                                              |
|------------|-------------------------------------------------------------------------------------------------------|
| Direction  | default direction toggle: `TB / LR / BT / RL` → `roomMeta.layoutParams.defaultDirection`              |
| Layout     | spacing preset: `Compact / Normal / Roomy` (см. таблицу 5.1) + `auto-direction` on/off + midpoint mode `even / center` |
| Styles     | пустой stub: подпись "Style defaults — coming soon"                                                   |
| Advanced   | ссылка `All 16 params →` — drill-down в тот же popover (см. 5.2) + `Reset to defaults`                |

#### 5.1 Spacing presets

Маппинг preset → 4 LayoutParams (остальные 12 — без изменений).

| Preset  | nodePadding | containerPadding | edgeSpacing | edgeNodeSpacing |
|---------|-------------|------------------|-------------|-----------------|
| Compact | 8           | 16               | 12          | 12              |
| Normal  | 16          | 24               | 16          | 20              |
| Roomy   | 24          | 32               | 24          | 32              |

`Normal` == текущий `DEFAULT_LAYOUT_PARAMS` (из `packages/shemma-domain/src/layout-params.ts`). Active preset определяется reverse-mapping'ом: если все 4 поля совпадают со строкой таблицы → подсвечен этот preset; иначе ни один не подсвечен и рядом показан label `Custom` (read-only indicator, не кликабельный — user возвращается к preset кликом по нему).

#### 5.2 Advanced drill-down

Не отдельный modal — тот же popover container увеличивает высоту, content замещается на расширенную форму:

- Все 16 числовых полей из `LayoutParams` как `<input type="number">` (с валидацией ≥0).
- `← Back` сверху — возврат к основному BoardPanel.
- `Reset to defaults` — записывает `null` в `room.meta.layoutParams` (effectively unsets override).

## 6. Data flow & state persistence

### Storage locations

| Что                           | Где                                                | API endpoint                                                |
|-------------------------------|----------------------------------------------------|-------------------------------------------------------------|
| Direction (per container)     | `shape.props.direction` + `shape.meta.didrawDirectionInherited` | existing `POST /api/agent/layout-selection` with `direction` |
| Pin position (per shape)      | `shape.meta.pinned: boolean`                       | new `POST /api/shape/:id/pin` `{ position: bool }`         |
| Pin size (per shape)          | `shape.meta.didrawSizePinned: boolean`             | new `POST /api/shape/:id/pin` `{ size: bool }`             |
| Role (per shape)              | `shape.meta.didrawRole: string`                    | existing role-picker write path                            |
| LayoutParams (board)          | `room.meta.layoutParams: Partial<LayoutParams>`    | new `POST /api/board/layout-params`                        |

### New endpoints

#### `POST /api/shape/:id/pin`

```ts
// Request
{
  size?: boolean,
  position?: boolean,
  space?: string,
  room?: string,
}

// Response
{ ok: true }
```

Idempotent. Если оба поля `undefined` → 400. Записывает соответствующие `meta.*` поля атомарно; broadcast через WS как layoutAction-free meta update.

#### `GET /api/board/layout-params`

```ts
// Query
?space=<space>&room=<room>

// Response
{
  raw: Partial<LayoutParams> | null,   // что сохранено в room.meta.layoutParams (null если не задано)
  effective: LayoutParams,              // raw after applyLayoutParamsDefaults
}
```

#### `POST /api/board/layout-params`

```ts
// Request
{
  params: Partial<LayoutParams> | null,   // null = unset overrides → revert to defaults
  space?: string,
  room?: string,
}

// Response
{ ok: true, effective: LayoutParams }     // effective после применения applyLayoutParamsDefaults
```

Валидация — `validateLayoutParams(params)` (уже существует). Эффективно: `applyLayoutParamsDefaults(room.meta.layoutParams ?? {})` используется на каждом call'е `runLayout` в `apps/backend/src/routes/schema.ts`.

#### Расширение `POST /api/agent/layout-selection`

Добавить optional `forceUnpin: boolean` в body. Когда `true`:
- backend временно игнорирует `meta.pinned` и `meta.didrawSizePinned` на shapes в выборке во время этого вызова `runLayout`;
- НЕ снимает pin-флаги (user pin сохраняется, был "проигнорирован один раз").

### Read path

Frontend читает live state:

```ts
// shape meta / props — реактивно через tldraw store
const direction = useValue("dir", () => editor.getShape(id)?.props.direction, [id])

// room meta — на v1 fetch on popover open, ref-update on success; signal-based реактивность — v2
const [layoutParams, setLayoutParams] = useState<LayoutParams | null>(null)
useEffect(() => {
  if (!open) return
  fetch(`/api/board/layout-params?space=${space}&room=${room}`).then(...)
}, [open])
```

### Write path (optimistic + server-confirmed)

```text
1. user click button (e.g. "LR")
2. optimistic: editor.updateShape({ props: { direction: "LR" } })   ← локально мгновенно
3. fetch POST /api/agent/layout-selection { direction: "LR", ids }
4a. on success: backend WS broadcast → frontend применяет authoritative state (вкл. positions от runLayout)
4b. on error: rollback editor.updateShape({ props: { direction: prevDirection } }) + toast
```

Для board params — optimistic на local Panel state (`useState`), async fetch; на 4xx/5xx → revert local + toast.

### Concurrency

LWW по timestamp. Параллельные mutation'ы из двух вкладок — последний выигрывает. Совпадает с моделью DRW-149/166.

## 7. Error handling

- 4xx / 5xx из mutation endpoint → toast (используем существующий `ErrorBanner` или inline toast в popover'е, выбор реализации — на implementation phase).
- Network timeout > 5s → "Saving…" inline-overlay над затронутой секцией; не rollback'аем до получения ответа/ошибки.
- API contract validation: thin type guards в `apps/frontend/src/settings/api.ts`. Zod опционален.
- Backend validation: `applyLayoutParamsDefaults` + `validateLayoutParams` уже существуют; reuse.

### Edge cases

| Случай                                | Поведение                                                                      |
|---------------------------------------|--------------------------------------------------------------------------------|
| Subject shape удалён                  | `useValue → undefined` в Panel'е → autoclose                                  |
| Camera move (any source)              | autoclose                                                                      |
| WS-update от другой вкладки/AI        | popover показывает свежие values (через `useValue`); confirm prompt'ов нет     |
| Selection change при открытом popover | autoclose (user может re-open Option-click'ом)                                  |
| Backend down                          | optimistic write + rollback + toast "Settings unavailable"                     |

## 8. Accessibility (v1 minimum)

- Focus trap при mount popover'а; первая интерактивная кнопка получает focus.
- `Escape` → close. `Tab` / `Shift+Tab` навигация по интерактивным элементам.
- Root: `role="dialog"`, `aria-label="Container settings" | "Selection settings" | "Node settings" | "Board layout"`.
- Direction button-toggle: `role="radiogroup"` + `aria-checked` на каждой кнопке.
- Pin button-toggle: `role="switch"` + `aria-checked`.
- Spacing preset: `role="radiogroup"`; presets имеют `aria-describedby` со sub-label ("Compact: ~50% tighter spacing", "Roomy: ~50% more breathing room").

## 9. Testing strategy

| Слой                    | Что тестируем                                                | Локация                                                            |
|-------------------------|--------------------------------------------------------------|--------------------------------------------------------------------|
| `useSettingsTrigger`    | gesture detection, target resolution, anchor calc, dismiss   | `apps/frontend/src/settings/useSettingsTrigger.test.ts` (RTL)      |
| Sections (Direction / Layout / Pin / Role) | render given props, click → callback fires      | `apps/frontend/src/settings/sections/*.test.tsx`                   |
| Panels                  | composition: правильные sections shown for given target       | `apps/frontend/src/settings/panels/*.test.tsx`                     |
| `api.ts`                | request shape, response decoding, error path                  | `apps/frontend/src/settings/api.test.ts` (fetch mock)              |
| Backend `pin`           | input validation, persistence, idempotency                    | `apps/backend/tests/routes-shape-pin.test.ts`                      |
| Backend `layout-params` | validation, defaults application, broadcast                   | `apps/backend/tests/routes-board-layout-params.test.ts`            |
| Backend `forceUnpin`    | layout-selection respects flag                                | `apps/backend/tests/routes-layout-selection-force-unpin.test.ts`   |
| Integration (manual)    | open popover → click button → state updates → backend sync   | chrome-devtools MCP, один happy-path per Panel kind                |

Не тестируем pixel-perfect visuals — это manual visual gate (per [[feedback-no-subagent-screenshot-trust]]).

## 10. Open questions (to resolve before plan)

Закрыты в ходе brainstorm'а; для protocol'а — оставляю явный лог:

| Вопрос                                     | Решение                                          |
|--------------------------------------------|--------------------------------------------------|
| Trigger для popover                        | Option + click (Alt+pointerdown в capture phase) |
| Контейнер popover'а                        | Floating, через `InFrontOfTheCanvas` slot         |
| Объёмы (shape / selection / board)         | Все три в v1                                     |
| Порядок секций                             | Direction → Layout → Size & Position → Role → Styles → Advanced |
| Одиночный Frame                            | Использует SelectionPanel (унификация с multi-selection) |
| Default styles в BoardPanel                | Stub в v1, реальные controls — следующая итерация |
| Drill-down "Advanced"                      | Inline replacement в том же popover'е, не modal  |
| Force re-layout — сбрасывает pin?          | Нет; pin сохраняется, был "проигнорирован один раз" |

## 10a. Cross-dependencies

- **`Force re-layout` hotkey ⌘⇧⌥L** — формально часть DRW-180 (user-pinned dimensions). Popover-кнопка не блокируется наличием hotkey'я: она зовёт ту же backend-функцию (`POST /api/agent/layout-selection` с `forceUnpin: true`). Если эта спецификация реализуется раньше DRW-180 — кнопка работает, hotkey может появиться позже без изменений UI.
- **`room.meta.layoutParams`** — новое room-scoped поле. Backend должен:
  - Прочитать его в каждом месте вызова `runLayout` в `apps/backend/src/routes/schema.ts` (~3 точки по DRW-178 notes: lines 843, 1009, 1357 — числа могут сдвинуться, искать по `runLayout(`).
  - Применить `applyLayoutParamsDefaults(roomMeta.layoutParams ?? {})` перед передачей в helpers.
  - Хранить и broadcast'ить через существующий roomMeta-механизм (тот же, что используется для других room-level meta).
- **Tldraw `InFrontOfTheCanvas` слот** — в shemma пока не использован. Убедиться, что DRW-134 (canvas-AI protocol overlay) не претендует на тот же слот; они должны coexist (наш popover открывается по требованию, overlay DRW-134 — постоянный canvas-aware overlay в другой плоскости).

## 11. Risks / open angles

- **Alt + pointerdown** может конфликтовать с tldraw'овским Alt-drag-clone (duplicate gesture). Mitigation: `e.preventDefault() + e.stopPropagation()` в capture phase. Требует verify в implementation phase: ловит ли наш handler гарантированно раньше tldraw'овского.
- **`pageToScreen` на каждый animation frame** при открытом popover'е во время user-pan — потенциальный perf hit. Не критично (popover закрывается на pan), но если в будущем popover будет persistent — нужен throttle.
- **`InFrontOfTheCanvas` слот** — текущее использование в shemma его не задействует; убедиться, что нет планируемых конфликтов с DRW-134 overlay (canvas-AI protocol). Скорее всего нет — overlay живёт в другой плоскости.
- **Reverse-mapping preset → numeric** в BoardPanel должен быть exact match, иначе подсвечивается `Custom`. Нужно решить: если user руками выставил `Compact` через Advanced + +1 → это `Custom` или всё ещё `Compact`? v1: exact match → `Custom`.

## 12. Implementation phasing (предложение для плана)

Высокий уровень для будущего plan'а:

1. **Foundation** — `useSettingsTrigger` + skeleton `SettingsPopover` + `InFrontOfTheCanvas` slot wiring. Демо: Option+click открывает пустой popover, Esc закрывает.
2. **Sections** — `DirectionSection`, `LayoutSection`, `PinSection`, `RoleSection`, `StylesSection` (stub). Все atomic, с tests.
3. **Panels** — `SelectionPanel`, `NodePanel`, `BoardPanel` composition.
4. **Backend new endpoints** — `pin`, `board/layout-params`, расширение `layout-selection` с `forceUnpin`.
5. **Wiring** — `api.ts` + optimistic/rollback + WS sync.
6. **A11y polish** — focus trap, roles, keyboard nav.
7. **Manual visual gate** — Option+click on container/node/selection/board → verify per phase.

Конкретное разбиение на tasks — в plan-документе (writing-plans skill).
