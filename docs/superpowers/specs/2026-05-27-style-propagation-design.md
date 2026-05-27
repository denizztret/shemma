# Style Propagation Design

**Status:** Draft v0.2 (self-review applied)
**Date:** 2026-05-27
**Subproject of:** DRW-180 Frame+Container Direction/Layout (sub-project 3)
**Backlog task:** TBA (will be created as DRW-NNN before writing-plans)

## Goal

Дать пользователю централизованный контроль над **стилем линии, шрифтом и размером** для shapes на доске:

1. **BoardPanel** — defaults для нового содержимого на всей доске (sticky в `room.meta`).
2. **SelectionPanel** (при выделении frame/schema-container) — переключатель, который **зеркалит текущее состояние children** и одним кликом меняет всех descendants + sticky на parent.

Решает проблемы:
- tldraw native style-панель **не показывает font для `schema-container`** и **не показывает line/font для `frame`** — нет UI входа.
- Native style-панель при выборе container/frame **не достигает children** — настройки применяются только к самому контейнеру визуально (а иногда и вовсе игнорируются renderer'ом schema-container'а).
- Multi-select разнородных фигур native иногда не даёт unified panel — наш блок закрывает gap.

## Background

DRW-180 завершил Direction/Layout пайплайн (sub-projects 1 и 2). Sub-project 3 — стили (line / font / size). DRW-178 уже зафиксировал концепцию sticky meta на frame'ах (`meta.didrawDirection`, `meta.didrawLayoutParams`); этот документ расширяет паттерн на стили.

Существующая инфраструктура которая используется:
- `room.meta.layoutParams` + `POST /api/board/layout-params` — паттерн для `room.meta.styleDefaults`.
- `LayoutSettingsValue` с null-state для mixed selection (`apps/frontend/src/settings/sections/LayoutSettingsSection.tsx`) — паттерн для derived unified state.
- `setContainerLayoutParams` writer (`apps/frontend/src/shapes/container-layout-params.ts`) — паттерн для polymorphic writer'а.
- `editor.run()` + WS broadcast — atomic local update + propagation.

## Scope

### Controls

| Контрол | Опции | tldraw style prop | Tooltip |
|---|---|---|---|
| **Линия** | `Draw`, `Solid` | `dash` ∈ {"draw", "solid"} | «применяется только к непрерывным линиям» |
| **Шрифт** | `Draw`, `Sans`, `Mono` | `font` ∈ {"draw", "sans", "mono"} | — |
| **Размер** | `S`, `M`, `L`, `XL` | `size` ∈ {"s", "m", "l", "xl"} | — |

**Никаких парных связей** между контролами — любая комбинация валидна.

### Per-shape applicability

Sweep пишет prop только если shape его имеет:

| Shape type | dash | font | size | Notes |
|---|---|---|---|---|
| `geo` | ✓ | ✓ | ✓ | — |
| `note` | — | ✓ | ✓ | — |
| `text` | — | ✓ | ✓ | — |
| `arrow` | ✓ | ✓ | ✓ | font для arrow label |
| `schema-container` | ✓ | **skip** | — | label всегда `sans`; size не применим |
| `frame` (native) | — | **skip** | — | label остаётся `sans` |

Sticky `meta.didrawStyleDefaults` на frame/container хранит **все три** ключа (font тоже); они наследуются children при создании, но в самих frame/container НЕ пишутся в props.

### Dashed/dotted preservation

Если у shape текущее `props.dash ∈ {"dashed", "dotted"}` — sweep **пропускает** этот shape для контрола Линия (не пишет dash). Font и size применяются обычно. Эта точечная стилизация остаётся в управлении нативной панели.

### UI visibility

- **BoardPanel** «Стили» — видна всегда; defaults для всей доски.
- **SelectionPanel** «Стили» — видна **только** если selection содержит хотя бы один `frame` или `schema-container`. При plain multi-select shapes без frame/container — наш блок скрыт, работает native panel.

### Non-goals

- **`color`** — отдельный sub-project (DRW-180 OverlayEntry хранит color на узлах).
- **`fill`** — отдельная тема (SchemaContainer UX backlog).
- Изменение/скрытие native tldraw style-панели — только bidirectional state sync.
- Special undo/redo handling — `editor.run()` обеспечивает atomic undo за каждый click.
- Auto-restyle shape при перемещении между frame'ами — стиль не меняется при drag-between-containers.

## Architecture

### Data model

**Board-level defaults** в `room.meta.styleDefaults`:
```typescript
type StyleDefaults = {
  dash?: "draw" | "solid";
  font?: "draw" | "sans" | "mono";
  size?: "s" | "m" | "l" | "xl";
};
```
Все поля optional. Отсутствие поля = fallback на tldraw native default (Draw / Draw / M).

**Container-level sticky** в `frame.meta.didrawStyleDefaults` и `schema-container.meta.didrawStyleDefaults` — тот же тип `StyleDefaults`.

### Resolution chain при создании новой shape

Когда shape создаётся внутри parent контейнера (frame или schema-container):

1. Поднимаемся по цепочке parent'ов (`shape.parentId`).
2. На каждом уровне `frame` или `schema-container` проверяем `meta.didrawStyleDefaults.<key>` — если defined, берём.
3. Дойдя до root → берём `room.meta.styleDefaults.<key>`.
4. Если и там undefined → tldraw native default.

Resolution per-key (independent для dash/font/size). Это значит можно frame с `{font: "mono"}` — родит children с mono шрифтом, но линиями/размером board-defaults.

#### Hook point

Resolution выполняется в **`editor.sideEffects.registerBeforeCreateHandler('shape', resolver)`** (tldraw 5.x SideEffectManager API). Handler получает `next` shape и возвращает модифицированную копию с заполненными `props.dash`/`props.font`/`props.size` где applicable.

```typescript
editor.sideEffects.registerBeforeCreateHandler("shape", (shape) => {
  const styles = resolveStyleDefaults(editor, shape);
  return applyStylesToShape(shape, styles);
});
```

**Важно:** resolution применяется **только для shapes созданных локально** (user через native tools, или local code). Shapes пришедшие через WS broadcast от другого клиента — resolution **не применяется**, потому что они уже имеют finalised style props от автора (двойное применение исказит).

Различие — через WS adapter контекст: WS-applied changes идут через `editor.store.mergeRemoteChanges()`, который не триггерит `beforeCreate` handlers (это документированное поведение tldraw store). Локальный editor.createShape проходит через handler — это ровно то что нам нужно.

### Click semantics

**Click на кнопку в SelectionPanel** для конкретного style key (например font=sans):

Atomic operation:
1. Перезаписать `props.<key>` на самих selected shapes (с учётом applicability таблицы и dashed/dotted preservation для dash).
2. Recursively обойти всех descendants выбранных frame/container — перезаписать `props.<key>` где applicable.
3. Записать `meta.didrawStyleDefaults.<key>` на selected frame и schema-container (для будущих children).

User-owned пометка (`meta.styleOwnedBy === "user"`) **не блокирует** sweep из SelectionPanel — это explicit user action в нашей панели, user явно знает что делает. Frontend pass'ит `respectUserOwned: false` в endpoint. AI/CLI/MCP вызовы того же endpoint'а **обязаны** pass'ить `respectUserOwned: true` (это default — см. API endpoints).

**Click в BoardPanel** для style key:
1. PATCH `room.meta.styleDefaults.<key>` через backend.
2. Frontend echo: вызвать `editor.setStyleForNextShape(<StyleProp>, value)` чтобы native tldraw панель показала тот же выбор.

### Bidirectional sync с native tldraw panel (board level)

Двусторонний:
- **Server → editor**: при WS broadcast'е `room.meta.styleDefaults` или при первоначальной загрузке room — frontend вызывает `editor.setStyleForNextShape(DefaultDashStyle, raw.dash)` и аналогично для font/size.
- **Editor → server**: подписываемся на `editor.store` change events на `instance.stylesForNextShape`; при изменении (которое не от нас) — PATCH room.meta.styleDefaults.

**Echo-guard**: per-key snapshot. При write-direction (server → editor) для каждого touched StyleProp пишем в `Map<StyleProp, { value, expiresAt }>` с TTL ~200ms. Editor change event для конкретного StyleProp сверяется с этой Map'ой — если value совпадает и не истёк TTL, skip PATCH (это echo). Per-key snapshot нужен потому что concurrent server PATCH разных ключей (dash + font одновременно) иначе затирает один другим в общем snapshot'е.

### Derived state computation (SelectionPanel)

Функция `deriveUnifiedStyleState(selectedIds, editor)`:
1. Раскрутить selection → собрать target set: selected shapes + recursive descendants для каждого frame/schema-container в selection.
2. Per style key:
   - Filter target shapes по applicability таблице (skip frame/schema-container/note для dash; skip frame/schema-container для font/size).
   - Для dash: дополнительно skip shapes с current `dash ∈ {dashed, dotted}`.
   - Collect unique values.
   - Если 1 уникальное → подсветить эту кнопку.
   - Если >1 (mixed) → indeterminate (никакая кнопка не подсвечена).
   - Если 0 applicable shapes (selection чисто из frame'ов без children) → null, но кнопки активны (click создаст sticky meta).

### API endpoints

**`GET /api/board/style-defaults?space=X&room=Y`** → `{ raw: StyleDefaults | null, effective: { dash, font, size } }` (mirror `board-layout-params`).

**`POST /api/board/style-defaults?space=X&room=Y`** body `Partial<StyleDefaults> | null` → пишет `room.meta.styleDefaults`, broadcast room meta. Null = удалить override полностью.

**`POST /api/agent/style-apply?space=X&room=Y`** атомарный sweep:
```typescript
{
  selectedIds: string[];               // выбранные shapes (для sticky meta и direct apply)
  styles: Partial<StyleDefaults>;      // что менять (один или несколько ключей)
  respectUserOwned?: boolean;          // default true — AI safety
}
```
Backend:
1. Resolves `selectedIds` → находит frame/schema-container среди них → для каждого пишет `meta.didrawStyleDefaults.<key>` для каждого ключа в `styles`.
2. Для **всех** `selectedIds` + всех recursive descendants: применяет applicability таблицу и dashed/dotted preservation, пишет `props.<key>`. Если `respectUserOwned === true` (default) — shapes с `meta.styleOwnedBy === "user"` пропускаются для props-апдейта (sticky meta на frame/container всё равно пишется).
3. Atomic — либо все updates, либо 400 с указанием ошибки.
4. Broadcast обновлённые shapes.

**Callers contract:**
- Frontend SelectionPanel — pass'ит `respectUserOwned: false` (explicit user action в UI).
- AI/CLI/MCP — НЕ передаёт поле (получает default `true`, DRW-150 invariant сохранён).

### Domain layer

Новый файл `packages/shemma-domain/src/style-defaults.ts`:
- Type `StyleDefaults`.
- Validators `isValidDash`, `isValidFont`, `isValidSize`.
- `validateStyleDefaults(input)` — partial с валидацией каждого defined field.
- Re-export через `packages/shemma-domain/src/index.ts`.

## File structure (план изменений)

### Domain
- **Create** `packages/shemma-domain/src/style-defaults.ts` — типы + валидаторы.
- **Modify** `packages/shemma-domain/src/index.ts` — re-export.

### Backend
- **Create** `apps/backend/src/routes/board-style-defaults.ts` — GET/POST.
- **Create** `apps/backend/src/routes/style-apply.ts` — atomic sweep.
- **Modify** `apps/backend/src/index.ts` — wire routes.
- **Reuse** broadcast helper из `room-meta-broadcast.ts`.

### Frontend
- **Modify** `apps/frontend/src/settings/sections/StylesSection.tsx` — заменить stub на full implementation.
- **Create** `apps/frontend/src/shapes/style-apply.ts` — `applyStyleToSelection(editor, ids, styles)` writer (mirror `setContainerLayoutParams`).
- **Modify** `apps/frontend/src/settings/api.ts` — `getStyleDefaults`, `setStyleDefaults`, `applyStyleSweep`.
- **Modify** `apps/frontend/src/settings/panels/BoardPanel.tsx` — wire StylesSection.
- **Modify** `apps/frontend/src/settings/panels/SelectionPanel.tsx` — conditional StylesSection (видна когда selection содержит frame/container).
- **Create** `apps/frontend/src/canvas/style-defaults-sync.ts` — bidirectional sync с tldraw editor (setStyleForNextShape + listener с echo-guard).
- **Modify** `apps/frontend/src/canvas/Editor.tsx` (или где init editor) — wire sync.
- **Modify** `apps/frontend/src/settings/styles.css` — стили для трёх рядов переключателей (если визуальная разница от существующих секций).

### Tests
- **Create** `packages/shemma-domain/test/style-defaults.test.ts`.
- **Create** `apps/backend/test/routes/board-style-defaults.test.ts`.
- **Create** `apps/backend/test/routes/style-apply.test.ts` — sweep на nested, dashed/dotted preserved, label-shapes skipped.
- **Create** `apps/frontend/test/derive-unified-style-state.test.ts`.
- **Create** `apps/frontend/test/style-apply.test.ts`.

## Implementation decomposition

| Task | Что | Бл. |
|---|---|---|
| 1 | Domain types + validators | — |
| 2 | Backend `/api/board/style-defaults` GET+POST | Task 1 |
| 3 | Backend `/api/agent/style-apply` (atomic sweep) | Task 1 |
| 4 | Frontend API client + writers (`getStyleDefaults`, `setStyleDefaults`, `applyStyleToSelection`) | Task 2, 3 |
| 5 | `StylesSection` component (3 переключателя + derived state + indeterminate) | Task 4 |
| 6 | Wire BoardPanel — заменить stub | Task 5 |
| 7 | Wire SelectionPanel — visibility condition | Task 5, 6 |
| 8 | Bidirectional sync с tldraw `setStyleForNextShape` + echo-guard | Task 6 |
| 9 | Live verify + screenshots на Vite :5173 (выполняется controller-агентом с chrome-devtools MCP, не subagent'ом — см. [[feedback-no-subagent-screenshot-trust]]) | Task 8 |

## Testing strategy

**Domain**: pure type validators, isolated unit tests.

**Backend**:
- `style-apply.test.ts` — fixture room с nested structure (frame > schema-container > note + arrow); verify recursive sweep пишет props корректно, label-shapes пропущены, dashed shapes сохраняют dash, sticky meta записан.
- `board-style-defaults.test.ts` — happy path GET/POST, null persistence (deletes), validation errors.

**Frontend**:
- `derive-unified-style-state.test.ts` — все случаи: single shape, multi-select без mixing, multi-select с mixing, container без children, container со смешанными children, dashed shapes excluded.
- `style-apply.test.ts` — `applyStyleToSelection` правильно вычисляет target set и пропускает inapplicable props.

**Live (Vite :5173)**:
- Сценарий A: BoardPanel — клик Solid → новый rectangle создаётся с `dash="solid"`. Click Sans → новый rectangle с font sans. **Assert:** существующие shapes на доске остаются с прежним стилем (BoardPanel не сметает существующие).
- Сценарий B: SelectionPanel — select frame с 3 children разных типов → переключатели подсвечены unified state → click Mono → все children font=mono + frame.meta.didrawStyleDefaults.font="mono".
- Сценарий C: mixed initial state (children разные) → indeterminate → click resolves к unified.
- Сценарий D: nested (frame > container > note) → sweep проходит до глубины 2.
- Сценарий E: dashed line внутри frame → sweep Line=Solid не трогает её dash (font/size применяются).
- Сценарий F: bidirectional sync — клик в BoardPanel → native panel подсвечивает same → click в native → BoardPanel обновляется.

## Open questions

(пусто — все знаемые вопросы решены через user clarification в брейнштормe)

## Related

- DRW-180 sub-projects 1 (Frame direction) + 2 (Container layout) — `2026-05-27-frame-container-direction-layout-design.md`.
- DRW-150 `styleOwnedBy === "user"` invariant — sweep explicitly overrides этот guard.
- DRW-166 WS debounce race pattern — atomic backend apply устраняет race.
- DRW-178 sticky meta concept — расширяется на стили.
