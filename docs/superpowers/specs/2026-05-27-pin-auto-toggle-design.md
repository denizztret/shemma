# Pin Auto-Toggle — Design Spec

**Version:** v0.1
**Date:** 2026-05-27
**Backlog:** DRW-185
**Status:** Approved (design phase complete)

## Goal

Убрать explicit pin button как обязательный шаг для фиксации position/size. После ручного drag или resize shape — фиксация (`meta.pinned` + `meta.didrawSizePinned` для resize) происходит автоматически, и AI re-layout перестаёт перетирать manually-positioned shapes без extra клика.

Параллельно меняем default mode SettingsPopover'а с floating на pinned — это родственное UX-улучшение про снижение кликов на закрепление состояния.

## Scope

**In:**
- Авто-фиксация shape после ручного drag end (`select.translating` → `select.idle`).
- Авто-фиксация shape после ручного resize end (`select.resizing` → `select.idle`).
- Все shape types кроме `arrow` — `geo`, `text`, `note`, `draw`, `frame`, `group`, `schema-container`, `image`, `video`.
- Multi-select: все shapes в selection с measurable delta (≥1px по любой оси).
- Backend поддержка `meta.didrawSizePinned`: preserve в compile, respect в layout (игнор growY override), forceUnpin clears.
- SettingsPopover default = pinned mode (single-line change в `useSettingsTrigger.ts`).

**Out (текущая итерация):**
- Arrows — отдельная семантика (binding/anchor model, см. DRW-172). Manual pin к стороне-якорю — отдельный followup.
- Keyboard arrow-key nudge — не triggers `select.translating` state; отдельный followup при необходимости.
- Programmatic moves (AI apply, WS push, restore) — не triggers state machine, естественно out.
- Persistence SettingsPopover pinned выбора между сессиями.
- Глобальный toggle "auto-pin on/off".
- Rename popover internal state `pinned` → `popoverPinned` для disambiguation с `shape.meta.pinned`.

## Architecture

**Один frontend модуль** `apps/frontend/src/canvas/pin-auto-toggle.ts` экспортирует `registerPinAutoToggle(editor)` → `() => void` (disposer). Регистрация в `App.tsx` `onMount` рядом с `registerStyleDefaultsSync` (DRW-181) и `registerSchemaAutoFlip` (DRW-150). Disposer хранится в ref'е (`pinSyncDisposerRef`), вызывается при unmount/room switch.

**Минимальное изменение** `apps/frontend/src/settings/useSettingsTrigger.ts:89` — `useState(false)` → `useState(true)`. Нет нового state, нет нового storage.

**Backend changes** — три точки в существующих файлах:
- `apps/backend/src/domain/compile.ts` — meta whitelist расширяется на `didrawSizePinned`.
- `apps/backend/src/domain/layout.ts` — helper `isSizePinned(shape)` + ветка в `runLayout` shapeBounds которая игнорирует `growY` для size-pinned geo/note.
- `apps/backend/src/routes/layout-selection.ts` — `forceUnpin` теперь чистит обе flags (`pinned` + `didrawSizePinned`) в одной meta-patch.

## Detection mechanics (sub-feature A)

### State machine listener

tldraw 5.x содержит state machine с активными состояниями `editor.root` → tool path. Внутри `select` tool: `idle`, `pointing_shape`, `pointing_canvas`, `translating`, `resizing`, `brushing`, `scribble_brushing`, `editing_shape` и др.

`registerPinAutoToggle` подписывается на изменения активного state path через listener API. Концептуально:

```ts
const dispose = editor.store.listen(
  () => onStateMaybeChanged(editor.getPath()),
  { scope: "session", source: "user" }
);
```

Если public listener для state machine ограничен, fallback — `editor.on('change')` + сравнение `editor.getPath()` с previous value. Каждый `prev → next` переход фильтруется по правилам ниже.

**Внимание:** конкретное API подписки выясняется через probe в Task 1 плана (см. `feedback-tldraw-docs` — читаем доки перед написанием).

### Session lifecycle

Модуль держит `currentSession: { kind: "translating" | "resizing", snapshot: Map<TLShapeId, BBox> } | null` (module-private).

**Open session.** При переходе `prev != translating/resizing → next == translating || next == resizing`:
1. `kind = next`.
2. `snapshot = new Map()`.
3. Итерируем `editor.getSelectedShapes()`. Для каждого `shape.type !== "arrow"`:
   - `snapshot.set(shape.id, { x: shape.x, y: shape.y, w: getShapeWidth(shape), h: getShapeHeight(shape), type: shape.type })`.
   - `getShapeWidth/Height` — helpers reading `props.w/h` для geo/frame/note; `editor.getShapeGeometry(shape).bounds` как fallback для shapes без явных props.

**Close session.** При переходе `prev == translating || prev == resizing → next == idle`:
1. Захватываем `closing = currentSession`. Сбрасываем `currentSession = null`.
2. Если `closing == null` — noop (sanity).
3. Считаем `updates: TLShapePartial[] = []`. Для каждой entry в `closing.snapshot`:
   - `current = editor.getShape(id)`. Если нет — пропуск.
   - `dx = current.x - snap.x`, `dy = current.y - snap.y`.
   - `dw = currentW - snap.w`, `dh = currentH - snap.h`.
   - `moved = abs(dx) + abs(dy) >= 1`.
   - `resized = abs(dw) + abs(dh) >= 1`.
   - Если `!moved && !resized` — пропуск.
   - `meta` = `{ pinned: true }` если `moved || closing.kind == "resizing"`. Добавляем `didrawSizePinned: true` если `closing.kind == "resizing" && resized`.
   - Push `{ id, type: current.type, meta: { ...current.meta, ...metaPatch } }`.
4. Если `updates.length === 0` — return.
5. Атомарная запись с history mark:

```ts
editor.markHistoryStoppingPoint("auto-pin");
editor.run(() => editor.updateShapes(updates));
```

`editor.run` без options → source = "user" → попадает в `transport/ws.ts:265` user-source listener → broadcast'ится на backend как обычный user update. Backend хранит meta как при explicit pin button.

### Filters

- **Snapshot пустой** → close ничего не делает (selection в момент open был пуст или только arrows). Это natural noop.
- **Cancel/ESC.** tldraw возвращает shape positions на initial values и переводит state в `idle`. Snapshot diff = 0 на всех осях → no pin write.
- **Source filter.** Никаких отдельных фильтров не нужно — мы реагируем только на state-machine переходы, которые случаются только в ответ на pointer input от user'а. Programmatic move'ы (AI, WS apply, restore) не двигают state-machine.
- **Same-tick double session.** Если новый translate начнётся в том же tick, что и close предыдущего — currentSession уже сброшен на null до open нового; open перепишет snapshot. Корректно.

### Multi-shape semantics

`editor.getSelectedShapes()` в момент open даёт точный список. Drag/resize в tldraw apply'ит делту равномерно. Soit snapshot содержит N entries, все будут проверены на diff в close. Те у кого movement — pin'ятся; те у кого нет (edge-case при selection с пинами разной природы) — не трогаем.

`updateShapes(updates)` идёт как **один** batched call → один WS frame (50ms debounce в `transport/ws.ts:213` встроен).

### Arrows

Фильтруем по `shape.type === "arrow"` при snapshot population. Если selection целиком из arrows — snapshot пуст → close = noop. Если в selection mix shapes + arrows — pin'ятся только non-arrow.

## Backend changes (didrawSizePinned support)

### compile.ts — preserve в define upsert

В точке где compile.define merge'ит existing meta с new shape data (DRW-003 pattern), whitelist user-owned meta keys расширяется:

```ts
// preserve user-owned meta (pinned/position/styleOwnedBy/didrawSizePinned)
const preserved = {
  pinned: existing.meta?.pinned,
  position: existing.meta?.position,
  styleOwnedBy: existing.meta?.styleOwnedBy,
  didrawSizePinned: existing.meta?.didrawSizePinned,
};
```

Без этого AI define-replay (e.g. shemma_define тех же IDs) перетирал бы user size-pin. Test extension в `compile-meta-preservation.test.ts`.

### layout.ts — isSizePinned + growY override skip

Новая helper:

```ts
export function isSizePinned(shape: TLShape): boolean {
  return shape.meta?.didrawSizePinned === true;
}
```

В точке где `runLayout` (или его helper `shapeBounds`) вычисляет effective bounds для geo/note с `props.growY` (DRW-174 pattern):

```ts
const grown = shape.props.growY ?? 0;
const effectiveH = isSizePinned(shape)
  ? shape.props.h                          // strict shape height, ignore grow
  : shape.props.h + grown;
```

Аналогичный паттерн для `growX` если он есть в codebase (probe в Task 3).

Test: `layout-size-pin-discipline.test.ts` (new) с двумя scenarios — size-pinned игнорирует growY; position-pinned + size-flexible перепозиционируется но не resize'ится.

### layout-selection.ts — forceUnpin clears both

В точке где `forceUnpin: true` chuyển meta перед runLayout (DRW-180 pattern), расширяем сброс:

```ts
if (forceUnpin) {
  metaPatch.pinned = undefined;            // delete via key absence
  metaPatch.didrawSizePinned = undefined;  // delete via key absence
}
```

Конкретный mechanism удаления зависит от существующего pattern (delete via undefined в JSON serializer или explicit removeMeta call). Test: existing `layout-selection.test.ts` extension с case "forceUnpin clears didrawSizePinned along with pinned".

## SettingsPopover default-pinned (sub-feature B)

**Single change.** `apps/frontend/src/settings/useSettingsTrigger.ts:89`:

```ts
// before
const [pinned, setPinnedState] = useState(false);
// after
const [pinned, setPinnedState] = useState(true);
```

### Effects

- При первом invocation popover (Alt+RightClick по shape или selection change при `pinned===true` state) — popover рендерится в pinned mode сразу. Button показывает `✕` (close).
- Outside-click listener (SettingsPopover.tsx:54-62) уже фильтруется по `if (!target || pinned) return` — в pinned mode не triggers close. Behaviour без изменений.
- `setUserPos(pos)` остаётся обязательной при transition pinned→floating через button — но button в default pinned состоянии работает как close (`if (pinned) close()`), эта ветка уже корректна.
- Selection change в pinned mode → resolveAmbientTarget переключает контент popover'а (existing).

### No persistence

Per YAGNI — каждая session начинается в pinned. Если user в течение session закрыл popover, следующий invocation снова в pinned. Если user в session toggle'нул на floating через какой-то альтернативный flow — после reload пустой start = pinned. Это приемлемо для текущей задачи. Persistence — followup.

### Tests

`useSettingsTrigger.test.ts` дополнить:
1. `starts in pinned mode by default` — assert `result.current.pinned === true` после render.
2. `close button on first click switches and closes` — assert clicking pin-btn в pinned state вызывает `close()` (а не toggle to floating). Это уже текущая логика (`if (pinned) { close(); } else { ... setPinned(true); }`).

## Edge cases

| Сценарий | Поведение |
|---|---|
| ESC во время drag/resize | tldraw возвращает initial positions, переход в idle. Snapshot diff = 0 → no pin. ✅ |
| Programmatic moves (AI/WS apply) | Не triggers translating/resizing state. Session не открывается. ✅ |
| Clone via Alt+drag | Cloned shapes попадают в `select.translating` selection после копирования — snapshot их подхватит на open, pin'ятся на close. Приемлемо. |
| Frame/Group drag целиком | Selection = container, snapshot = container, pin = container. Children's local x/y не меняются → не pin'ятся. Корректно. |
| Undo после auto-pin | `markHistoryStoppingPoint("auto-pin")` создаёт separate entry. Undo #1 → unpin. Undo #2 → reverse drag. Симметрично. |
| AI re-layout pinned shape | Existing `isPinned()` (`layout.ts:212`) уже respect'ит. Без изменений. |
| forceUnpin: true (context-menu direction, DRW-180) | Расширяем: clears both `pinned` + `didrawSizePinned`. |
| Resize с delta < 1px | abs(dw)+abs(dh) < 1 → no pin. Защита от noise. |
| Brush selection | State `select.brushing` ≠ translating/resizing — session не открывается. ✅ |
| Editing text (TLDraw `editing_shape`) | Не translating/resizing — out of scope. ✅ |
| Room switch / unmount | Disposer chiamato → listener detached. Currentsession сбрасывается через `useEffect` cleanup. |

## Testing strategy

### Frontend (`apps/frontend/src/canvas/pin-auto-toggle.test.ts`, новый)

Тесты используют real `Editor` через `tldraw` test harness (по образцу `style-defaults-sync.test.ts` из DRW-181).

1. **pins shape on translate A→B** — программно: создать shape, select, simulate translating state, переместить x на 10px, simulate idle. Assert `shape.meta.pinned === true` после транзитa.
2. **does not pin on translate aborted by ESC** — same setup, но не двигать (delta = 0). Assert `shape.meta.pinned !== true`.
3. **pins all shapes in multi-select** — два shapes, select обоих, simulate drag на 10px. Assert обоих pinned.
4. **ignores arrow shapes in selection** — geo + arrow, drag всех. Assert geo pinned, arrow meta unchanged.
5. **resize sets both pinned and didrawSizePinned** — resize shape на dh=20. Assert обе flags true.
6. **drag does not set didrawSizePinned** — assert sanity.
7. **no-op when selection empty** — translating event с пустым selection (theoretical) → no updates.
8. **no-op for programmatic editor.updateShape** — вызвать `editor.updateShape({...})` без state-machine transition → no auto-pin.

### Frontend (`apps/frontend/src/settings/useSettingsTrigger.test.ts`, дополнить)

9. **starts in pinned mode by default** — render hook, assert `pinned === true`.
10. **close button on first click closes popover** — simulate click pin-btn, assert `close` called.

### Backend

11. **`compile-meta-preservation.test.ts` extension** — `define preserves didrawSizePinned` — existing meta `{ didrawSizePinned: true }` сохраняется после `compile.define` upsert.
12. **`layout-size-pin-discipline.test.ts` (new)** — три scenarios:
    - size-pinned geo с growY=20 → `runLayout` использует только `props.h`, игнорирует growth.
    - size-pinned (size-only, position не pinned) → shape repositioned but size unchanged.
    - `forceUnpin: true` clears didrawSizePinned along with pinned.

### Total
~12 new tests. Baseline 2061 → expected ≥2073 pass after implementation.

## Implementation file list

**New files:**
- `apps/frontend/src/canvas/pin-auto-toggle.ts` — main module.
- `apps/frontend/src/canvas/pin-auto-toggle.test.ts` — frontend tests.
- `apps/backend/src/domain/layout-size-pin-discipline.test.ts` — backend test.

**Modified files:**
- `apps/frontend/src/App.tsx` — wire `registerPinAutoToggle` in onMount, store disposer в `pinSyncDisposerRef`.
- `apps/frontend/src/settings/useSettingsTrigger.ts` — line 89, default = true.
- `apps/frontend/src/settings/useSettingsTrigger.test.ts` — добавить 2 теста.
- `apps/backend/src/domain/compile.ts` — preserve didrawSizePinned в meta whitelist.
- `apps/backend/src/domain/compile-meta-preservation.test.ts` — extend.
- `apps/backend/src/domain/layout.ts` — `isSizePinned` helper + growY guard.
- `apps/backend/src/routes/layout-selection.ts` — forceUnpin clears both flags.
- `apps/backend/src/routes/layout-selection.test.ts` — extend.
- `CHANGELOG.md` — entry под Unreleased.

Файлов под изменения: 3 new + 9 modified = 12. Все локализованы. Domain types в `@shemma/domain` не трогаем (`didrawSizePinned` уже существует в frontend meta модели).

## Followups (после shipping)

- **Arrow manual pin к стороне-якорю.** При explicit user-action "закрепить arrow на стороне X" — сохранять `meta.didrawAnchorPinned: { side, offset }`. Layout (DRW-172 cardinal-snap) respects pinned anchor side. Отдельная feature, отдельный DRW.
- **Persistence SettingsPopover pinned state** — `localStorage` или `room.meta.uiPopoverPinned`.
- **Rename `pinned` → `popoverPinned`** в `useSettingsTrigger` для disambiguation от `shape.meta.pinned`.
- **Global toggle "auto-pin on/off"** в BoardPanel — только если feature будет мешать в реальном использовании.
- **Keyboard nudge (arrow keys) auto-pin** — отдельная ветка детекции через `editor.on('keyboard')`.

## Self-review (writing-spec checklist)

- [x] **Placeholder scan** — нет TBD/TODO/unspecified. Все ветви logic explicit.
- [x] **Internal consistency** — backend changes для didrawSizePinned согласованы с frontend behavior (close session pишет meta, backend preserve'ит + respect'ит); forceUnpin clears обе flags в единой точке.
- [x] **Scope check** — одна single phase (frontend module + minimal backend + single-line popover change). Декомпозиция не нужна.
- [x] **Ambiguity** — Approach 1 (state-machine listener) явно зафиксирован vs alternatives; trigger threshold (≥1px) explicit; arrows out of scope явно зафиксированы; persistence явно "no".
- [x] **Test coverage** — 12 тестов покрывают все AC из DRW-185 task.

Self-review pass. Ready for plan phase.
