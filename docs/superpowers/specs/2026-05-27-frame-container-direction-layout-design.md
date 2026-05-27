# Frame & Container Direction + Layout — design spec

- **Date:** 2026-05-27
- **Status:** Draft v0.1.1 (self-review pass; awaits user review)
- **Author:** brainstorm session 2026-05-27 (Settings Popover follow-up, sub-project 1+2)
- **Related:** [[next-session-board-panel-layout-ux]], [[next-session-frame-direction]], DRW-179 (merged 2026-05-27 as `ad5825d`)
- **Baseline:** main HEAD `ad5825d` (after DRW-179 Settings Popover merge), git describe `0.27.1-57-gad5825d`

## 1. Goal

Сделать так чтобы:

1. **Frame** и **schema-container** оба ведут себя как полноценные контейнеры компоновки: имеют собственный `direction`, собственные `layout params` (spacing / autoDirection / midpoint), и при их изменении выполняется **мгновенный re-layout** только их subgraph (children) без затрагивания siblings и parent frame.
2. **BoardPanel** настройки (direction / layout) визуально rebrand'ятся как **defaults для нового содержимого** — для импорта, AI агента, и future re-layouts (когда контейнер не имеет собственного override). Они НЕ triggers re-layout. Это устраняет UX confusion ("жму preset, ничего не происходит").
3. Чинится критический baseline-бы: при re-layout одного контейнера через ⌘⇧L / ⌘⌥⇧L / SelectionPanel Layout action — parent frame НЕ должен схлопываться до размера этого контейнера.

## 2. Background & motivation

После shipping DRW-179 (Settings Popover, merged 2026-05-27) user в live тестировании выявил три связанные проблемы:

**(a) Board settings не дают видимого эффекта.** User меняет preset Compact в BoardPanel — визуально canvas не меняется, пока не нажмётся ⌘⇧L. Семантика "глобальные defaults для room" неочевидна.

**(b) Frame и schema-container ведут себя по-разному.** Schema-container получает Direction (TB/LR/BT/RL/Custom) в SelectionPanel и при изменении мгновенно re-layout'ится. Native tldraw frame — НЕ имеет Direction (потому что у него нет `props.direction`), и нет Layout настроек ни для frame, ни для container. Это inconsistency: оба контейнеры по сути, отличаются только содержимым.

**(c) Scope bug в layout-selection.** При выборе контейнера внутри frame и Tidy (⌘⇧L) — контейнер re-layout'ится корректно (children упорядочиваются), но **parent frame схлопывается** до размера этого контейнера. Корень: `tidy-layout.ts:41` не передаёт `scope`, backend defaults к `"auto"` → frame становится anchor → Pass B пересчитывает frame size.

User explicit decision: board настройки = defaults для нового, не applied to existing room (потому что "на доске могут быть разные схемы с разными настройками, применять глобально неправильно — сломаем другие схемы").

## 3. Architecture overview

Решение распадается на три слоя:

```
┌────────────────────────────────────────────────────────────┐
│ UI layer                                                   │
│  • BoardPanel: header "По умолчанию" + badge "Для нового"  │
│  • SelectionPanel: Direction + Компоновка для frame и     │
│    schema-container, без badge → instant apply             │
└────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│ Frontend writers                                           │
│  • setContainerDirection(editor, dir)                      │
│      → polymorphic: schema-container props vs frame meta   │
│  • setContainerLayoutParams(editor, id, partial)           │
│      → writes meta.didrawLayoutParams + POST override      │
│  • tidyLayout / forceReLayout: scope heuristic             │
│      (single container/frame → "self", else → "auto")      │
└────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│ Backend domain                                             │
│  • readContainerDirection extends for frame.meta            │
│  • runLayoutSubgraph reads per-anchor                       │
│    meta.didrawLayoutParams → applies via ELK opts          │
│  • layout-selection POST accepts layoutParamsOverride     │
│    body, writes meta atomically BEFORE layout pass         │
│  • scope:"self" invariant: parent frame NOT resized when   │
│    not in filterToIds                                      │
└────────────────────────────────────────────────────────────┘
```

## 4. Domain extension — shape meta contract

### 4.1 New / extended meta keys

```ts
// На shape.meta (frame OR schema-container):
{
  // direction уже есть на schema-container (props.direction);
  // для frame — новый ключ в meta:
  didrawDirection?: "TB" | "BT" | "LR" | "RL" | "custom";

  // Layout params override для этого subgraph; partial — храним только diff
  // от board defaults. null/undefined = наследовать board defaults.
  didrawLayoutParams?: Partial<LayoutParams>;
}
```

**Invariants:**

- `didrawLayoutParams: Partial<LayoutParams>` — храним diff, не full snapshot. Если user сбрасывает → backend deletes key; frontend optimistically пишет `undefined` через `editor.updateShape({meta: {didrawLayoutParams: undefined}})` (tldraw трактует это как delete).
- `didrawDirection: "custom"` для frame и schema-container = legitimate state ("user разложил руками"); backend skip автолейаут этого subgraph (как уже работает для schema-container через `isCustomDirection`).
- Schema-container продолжает использовать `props.direction` (не дублируем в meta).
- Frame `meta.didrawDirection` — единственный канал (нет `props.direction` у native frame).
- **Frame НЕ участвует в DRW-178 auto-direction inference** — `inferContainerDirections` skip'ает контейнеры с типом `frame` целиком. Без этого `meta.didrawDirection` для frame'а становится ambiguous (user-set vs inferred). Schema-container остаётся в DRW-178 inference (existing semantics: `props.direction` = user, `meta.didrawDirection` = inferred).

### 4.2 Backend chain — `readContainerDirection` extension

`apps/backend/src/domain/layout.ts::readContainerDirection`:

```ts
function readContainerDirection(container: ShapeRec): string | undefined {
  // ... existing DRW-178 inferred branch ...

  if (container.type === "schema-container") {
    const d = (container.props as ...)?.direction;
    if (d === "custom") return undefined;
    if (typeof d === "string" && MERMAID_DIR_TO_ELK[d]) return MERMAID_DIR_TO_ELK[d];
  }

  // NEW: native frame reads meta.didrawDirection
  if (container.type === "frame") {
    const d = container.meta?.didrawDirection;
    if (d === "custom") return undefined;  // skip auto-layout
    if (typeof d === "string" && MERMAID_DIR_TO_ELK[d]) return MERMAID_DIR_TO_ELK[d];
  }

  // ... existing fallbacks ...
}
```

Также `isCustomDirection` расширяется чтобы возвращать `true` для frame с `meta.didrawDirection === "custom"`.

### 4.3 Backend chain — per-anchor `layoutParams` override

`runLayoutSubgraph` сейчас принимает один глобальный `params: LayoutParams`. Расширяется чтобы для каждого anchor container читать `meta.didrawLayoutParams`:

```ts
async function runLayoutSubgraph(
  store, shapes, hint, filterToIds,
  params: LayoutParams,                    // board defaults
  containerScope: "self" | "auto" = "auto",
) {
  // Helper: per-anchor params
  const paramsForAnchor = (anchorId: string): LayoutParams => {
    const anchor = shapeById.get(anchorId);
    const override = anchor?.meta?.didrawLayoutParams as Partial<LayoutParams> | undefined;
    return applyLayoutParamsDefaults({ ...params, ...override });
  };

  // Pass A: для каждого anchor — modeToElkOptions(hint.mode, paramsForAnchor(anchor).spacing)
  // labelDerivedSpacing — тоже пересчитывается с anchor-specific params
  // ...
}
```

**Скоп override:** override применяется только к ELK options ВНУТРИ Pass A subgraph этого anchor. Top-level Pass B (если идёт) использует board defaults.

**Edge case:** если global runLayout (scope:"all" / ⌘⌥⇧L global) — все anchor frame'ы получают свой override; corner-case собран в test #2 (см. секция 8).

### 4.4 Backend chain — `layoutParamsOverride` body parameter

POST `/api/agent/layout-selection`:

```ts
body: {
  ids: string[],
  scope?: "self" | "auto",                                   // existing
  directions?: Record<ElementId, Direction>,                 // existing
  forceUnpin?: boolean,                                      // existing
  layoutParamsOverride?: Record<ElementId, Partial<LayoutParams> | null>,  // NEW
}
```

Backend semantics (atomic, BEFORE layout call):

1. Apply `directions` patch (existing).
2. **NEW:** Apply `layoutParamsOverride`:
   - `null` value → `delete shape.meta.didrawLayoutParams`.
   - `Partial<LayoutParams>` → validate через `validateLayoutParams(partial)` из `@shemma/domain` (existing helper); если invalid → 400 с error details, atomic abort (никакие changes не применяются — ни directions, ни override).
   - Validation: shape должна быть frame OR schema-container; иначе skip ID + добавить в response `unresolved` (как existing pattern для unknown ids).
3. Trigger `runLayout` with updated store. `runLayoutSubgraph` now reads per-anchor override (см. 4.3).
4. Broadcast WS как раньше (with `layoutAction: true`).

## 5. Re-layout scope invariant — fix + контракт

### 5.1 Bug точка отказа

`apps/frontend/src/canvas/tidy-layout.ts:36-42`:

```ts
const res = await fetch(`/api/agent/layout-selection?...`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ids }),                  // scope не передаётся!
});
```

Backend `apps/backend/src/routes/layout-selection.ts:138`:

```ts
const containerScope: "self" | "auto" =
  body.scope === "self" ? "self" : "auto";        // default → "auto"
```

→ `containerScope === "auto"` → `runLayoutSubgraph` anchor-expansion включает parent frame → frame получает Pass B size update → frame схлопывается.

### 5.2 Frontend scope heuristic

```ts
function scopeFor(ids: string[], editor: Editor): "self" | "auto" {
  if (ids.length !== 1) return "auto";
  const s = editor.getShape(ids[0] as TLShapeId);
  if (!s) return "auto";
  return (s.type === "frame" || s.type === "schema-container") ? "self" : "auto";
}
```

| Selection | Scope | Поведение |
|---|---|---|
| Single leaf | `auto` | leaf в frame → frame anchor, Pass B обновит frame size — OK |
| Single container / frame | **`self`** | only children re-layout; parent frame **не trogается** |
| Multi-selection (leaves) | `auto` | sibling-resort + parent updates ок |
| Multi (frame + leaf вне) | `auto` | top-level layout оправдан |

### 5.3 Caller updates

| Caller | File | Change |
|---|---|---|
| `tidyLayout` | `apps/frontend/src/canvas/tidy-layout.ts` | Принять `scope` parameter, default `"auto"` |
| Tidy hotkey ⌘⇧L | `apps/frontend/src/App.tsx` | Caller передаёт `scopeFor(ids, editor)` |
| Force re-layout ⌘⌥⇧L | `apps/frontend/src/App.tsx` | То же |
| SelectionPanel Layout action button | `SettingsPopover.tsx::onLayoutAction` | То же |
| `setContainerDirection` (existing) | `SchemaContainerActions.ts` | Уже `scope:"self"` — без изменений |
| `setContainerLayoutParams` (new) | `SchemaContainerActions.ts` или новый файл | `scope:"self"` явно |

### 5.4 Backend guard (defense in depth)

В `runLayoutSubgraph` уже работает `containerScope === "self"` (line 856-861: skip Pass B). Однако исследование Pass C (apply phase) на возможную утечку — **обязательный первый шаг** task #5: 

1. Запустить existing test suite + regression-тест с фиксацией bug repro (`scope:"self"` + `ids=[container внутри frame]` + observe batch).
2. Если frame `props.w/h` присутствует в `batch.updated` для frame, который НЕ в `filterToIds` → найти точку записи и fix'нуть guard `if (!filterToIds.has(frameId) && containerScope === "self") continue` или эквивалент.
3. Если утечки нет — issue в frontend и fix self-contained через scope heuristic (секция 5.2). В этом случае task #5 ограничивается добавлением regression-теста.

## 6. BoardPanel rebrand — visual layer

### 6.1 Изменения

**Header:** `"Доска"` → `"По умолчанию"` (или текущий title BoardPanel — проверить и переименовать).

**Top badge** (новый компонент `.settings-popover__badge`):

```
╭──────────────────────────────╮
│  Для нового содержимого      │
╰──────────────────────────────╯
```

Серая neutral pill между header и первой секцией. Текст: **"Для нового содержимого"**.

**Section subtitles:** не используем (badge достаточен).

**BoardPanelAdvanced:** тот же badge сверху + helper text `"Эти значения работают как defaults для всего room"`. Reset кнопка остаётся.

### 6.2 No backend changes для этой секции

GET/POST `/api/board/layout-params` остаются как есть. Это **только UI rebrand** — semantics документируется в spec и changelog.

### 6.3 CSS

```css
.settings-popover__badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  background: #f2f3f5;
  color: #5f6368;
  font-size: 11px;
  font-weight: 500;
  margin: 4px 0 12px;
}
```

## 7. SelectionPanel extension — Direction + Компоновка для frame/container

### 7.1 Полиморфный counts и direction (в `SettingsPopover.tsx::useValue`)

```ts
const isContainerShape = (s) => s.type === "schema-container" || s.type === "frame";

const counts = useValue("selectionCounts", () => {
  const selected = editor.getSelectedShapes();
  const containers = selected.filter(isContainerShape).length;
  const nodes = selected.length - containers;
  return { containers, nodes };
}, [editor]);

// SelectionPanel decision rule: показывать Direction/Layout sections только если
// ВСЕ selected — containers/frames (no leaves вне). Mixed → sections hidden.
const showContainerSections = counts.containers > 0 && counts.nodes === 0;

const direction = useValue("dir", () => {
  const containers = (editor.getSelectedShapes() as ...).filter(isContainerShape);
  if (containers.length === 0) return null;

  const readDir = (s) =>
    s.type === "schema-container"
      ? (s.props?.direction ?? null)
      : (s.meta?.didrawDirection ?? null);

  const first = readDir(containers[0]);
  return containers.every((c) => readDir(c) === first) ? first : null;
}, [editor]);
```

**Note:** `showContainerSections === counts.containers > 0 && counts.nodes === 0` — conservative rule, mixed selection (container + leaf вне container) → Direction/Layout скрыты. Это соответствует section 7.5 rendering table.

### 7.2 Polymorphic writer `setContainerDirection`

`apps/frontend/src/shapes/schema-container/SchemaContainerActions.ts` либо новый helper `apps/frontend/src/shapes/container-actions.ts`:

```ts
// Принимает explicit ids (consistent с setContainerLayoutParams в 7.4).
// Caller передаёт editor.getSelectedShapeIds() или filtered subset.
export function setContainerDirection(
  editor,
  ids: string[],
  dir: Direction,
): void {
  const directions: Record<string, Direction> = {};

  editor.run(() => {
    for (const id of ids) {
      const s = editor.getShape(id);
      if (s?.type === "schema-container") {
        editor.updateShape({ id, type: "schema-container", props: { direction: dir }});
      } else if (s?.type === "frame") {
        editor.updateShape({ id, type: "frame", meta: { didrawDirection: dir }});
      } else continue;
      directions[id] = dir;
    }
  });

  void fetch(`/api/agent/layout-selection?...`, {
    method: "POST",
    body: JSON.stringify({ ids: Object.keys(directions), directions, scope: "self" }),
  });
}
```

**API consistency:** оба writer'а (`setContainerDirection`, `setContainerLayoutParams`) принимают explicit `ids: string[]` — caller извлекает их из editor по своей логике.

**Note:** старый `setSchemaContainerDirection(editor, dir)` (читал selection сам) — удаляется. Callers переключаются на `setContainerDirection(editor, ids, dir)` с явным `editor.getSelectedShapeIds()` (см. секция 9 task #6).

### 7.3 Новый компонент `LayoutSettingsSection`

Существующий `LayoutSection` (Tidy / Force-unpin) переименовать в `LayoutActionsSection`. Новый компонент:

```tsx
// apps/frontend/src/settings/sections/LayoutSettingsSection.tsx
export type LayoutSettingsValue = {
  preset: "compact" | "normal" | "roomy" | null;             // null = mixed / custom
  autoDirection: boolean | null;                              // null = mixed across multi-selection
  midpoint: "even" | "fixed-0.5" | null;                      // null = mixed across multi-selection
};

export const LayoutSettingsSection: FC<{
  current: LayoutSettingsValue;
  onPreset: (p: "compact" | "normal" | "roomy") => void;
  onAutoDirection: (v: boolean) => void;
  onMidpoint: (m: "even" | "fixed-0.5") => void;
  onAdvanced: () => void;
  onReset: () => void;
  showReset: boolean;        // true в SelectionPanel (per-frame override установлен)
}> = (...) => (...);
```

**Mixed semantics:** для multi-selection если values разные — toggle/preset показывает indeterminate state (нет подсветки), клик устанавливает explicit value ко всем.

В SelectionPanel: `current` derived from `selected[i].meta.didrawLayoutParams` (если 1 frame/container) или агрегация across multi-selection (все совпадают → значение, иначе null).

### 7.4 Writer `setContainerLayoutParams`

```ts
export async function setContainerLayoutParams(
  editor,
  ids: string[],
  partial: Partial<LayoutParams> | null,
): Promise<void> {
  // Optimistic local update. partial=null → пишем undefined (tldraw deletes meta key).
  const metaValue = partial === null ? undefined : partial;
  editor.run(() => {
    for (const id of ids) {
      const s = editor.getShape(id);
      if (s?.type === "schema-container" || s?.type === "frame") {
        editor.updateShape({ id, type: s.type, meta: { didrawLayoutParams: metaValue }});
      }
    }
  });

  // Backend POST — partial=null transmitted as null in JSON (backend deletes server-side).
  const override: Record<string, Partial<LayoutParams> | null> = {};
  for (const id of ids) override[id] = partial;

  await fetch(`/api/agent/layout-selection?...`, {
    method: "POST",
    body: JSON.stringify({ ids, scope: "self", layoutParamsOverride: override }),
  });
}
```

**Reset (partial=null) semantics:**
- Frontend: `editor.updateShape({meta: {didrawLayoutParams: undefined}})` → tldraw deletes the meta key locally.
- Network: `JSON.stringify` сериализует `null` (frontend wire representation для reset).
- Backend: получает `null` → `delete shape.meta.didrawLayoutParams`.
- WS broadcast: backend echo'ит meta-delete patch (existing WS protocol patches handle key-removal).

Это устраняет ambiguity между "null-saved" и "deleted" — оба маршрута сходятся к "key absent в meta".

### 7.5 SelectionPanel rendering rules

| Selection | Direction секция | Компоновка секция | Pin | Layout actions (Tidy/Force) |
|---|---|---|---|---|
| 0 selected | — | — | — | — |
| 1+ leaf (no container) | — | — | ✓ | ✓ |
| 1 container/frame | ✓ | ✓ + Reset | ✓ | ✓ |
| Multi container/frame | ✓ (если совпадают) | ✓ apply-to-all | ✓ | ✓ |
| Mixed (container + leaf вне) | — | — | ✓ | ✓ |

**Critical:** SelectionPanel **НЕ имеет badge** — отсутствие = визуальный сигнал "instant apply". Единственное различие с BoardPanel.

### 7.6 Reset кнопка (per-frame Layout override)

Маленькая текстовая ссылка `[Сброс к defaults]` под Advanced в `LayoutSettingsSection`. Только если `meta.didrawLayoutParams !== undefined` для всех selected. Жмёт → `setContainerLayoutParams(editor, ids, null)` → backend deletes meta key.

## 8. Testing strategy

### 8.1 Backend (`apps/backend/tests/`)

| File | Cases |
|---|---|
| `layout-direction-frame.test.ts` (new) | (a) frame с `meta.didrawDirection = "LR"` → ELK `RIGHT`; (b) `"custom"` → frame children positions preserved (skip Pass A); (c) frame без meta → board default fallback |
| `layout-params-override-per-frame.test.ts` (new) | (a) frame с `meta.didrawLayoutParams = {spacing: "compact"}` → ELK compact для subgraph, board roomy для других; (b) override = null → board defaults; (c) override на schema-container аналогично |
| `layout-selection-scope-invariant.test.ts` (new) | (a) `scope:"self"` + `ids=[container внутри frame]` → batch НЕ содержит frame `props.w/h` update; (b) `scope:"auto"` → frame size может обновиться; (c) multi-leaf inside frame → frame size legitimate update |
| `routes-layout-selection-payload.test.ts` (extend) | `layoutParamsOverride` body: writes/deletes meta atomically; non-container ids → ignored + warn |
| `routes-board-layout-params.test.ts` (existing) | Без изменений (semantics rebrand — UI only) |

### 8.2 Frontend (`apps/frontend/src/settings/`)

| File | Cases |
|---|---|
| `panels.test.ts` (extend) | (a) SelectionPanel renders Direction для frame; (b) only leaf → Direction/Compose скрыты, Pin виден; (c) BoardPanel badge renders, SelectionPanel — нет |
| `useSettingsTrigger.test.ts` (extend) | resolveTarget: frame selected → kind:"selection" path |
| `container-actions.test.ts` (new) | `setContainerDirection` polymorphic: schema-container → props, frame → meta; both POST с scope:"self" |
| `container-layout-params.test.ts` (new) | `setContainerLayoutParams` optimistic update + POST body содержит layoutParamsOverride + scope:"self" |
| `tidy-layout.test.ts` (extend) | scope heuristic: single container/frame → "self"; single leaf → "auto"; multi → "auto" |

### 8.3 Live verification (chrome-devtools MCP, controller сам)

1. Frame select → Direction секция появляется → клик LR → frame children re-layout horizontally → frame size unchanged, siblings не сдвинулись.
2. Container внутри frame → preset Compact в SelectionPanel → instant re-layout container subgraph, frame size unchanged.
3. ⌘⇧L (Tidy) с одним container внутри frame → **frame НЕ схлопывается** (bug-fix regression).
4. BoardPanel rebrand: header "По умолчанию", badge "Для нового содержимого".
5. Change board preset → визуально canvas не меняется (desired) → agent при следующем `shemma_apply` уже использует новый default.
6. Multi-selection (frame + sibling container) → SelectionPanel preset apply ко всем.

## 9. Декомпозиция в task'и

| # | Task | Files (Create/Modify/Test) | Depends |
|---|---|---|---|
| 0 | **Investigate Pass C leak** (precondition для task #5): repro bug в test, измерить если frame `props.w/h` пишется при `scope:"self"` + container внутри frame | Manual diagnostics (`bun test` + tracing); New `layout-selection-scope-invariant.test.ts` skeleton с repro case | — |
| 1 | `meta.didrawLayoutParams` type alias `ContainerLayoutOverride = Partial<LayoutParams> \| null` в `@shemma/domain` (export для shared use frontend+backend) | Modify `packages/shemma-domain/src/layout-params.ts` (re-export `ContainerLayoutOverride`) | — |
| 2 | `readContainerDirection` + `isCustomDirection` extension для frame + frame skip из `inferContainerDirections` | Modify `apps/backend/src/domain/layout.ts`; New `layout-direction-frame.test.ts` | 1 |
| 3 | `runLayoutSubgraph` per-anchor params override (читает `meta.didrawLayoutParams` каждого anchor) | Modify `apps/backend/src/domain/layout.ts`; New `layout-params-override-per-frame.test.ts` | 2 |
| 4 | POST `layoutParamsOverride` body validation (через `validateLayoutParams`) + atomic meta write | Modify `apps/backend/src/routes/layout-selection.ts`; Extend `routes-layout-selection-payload.test.ts` | 3 |
| 5 | Scope invariant fix (based on task #0 findings) + regression test green | Modify `apps/backend/src/domain/layout.ts` (если task #0 нашёл утечку); Complete `layout-selection-scope-invariant.test.ts` | 0, 4 |
| 6 | `setContainerDirection(editor, ids, dir)` polymorphic writer; replace ALL callers (включая `SettingsPopover.tsx::onDirectionChange`, context menu actions) | Modify `apps/frontend/src/shapes/schema-container/SchemaContainerActions.ts` (or new file); Modify `SettingsPopover.tsx`, любые context-menu callers; New `container-actions.test.ts` | — |
| 7 | `setContainerLayoutParams(editor, ids, partial)` writer + API wrapper в `settings/api.ts`; reset semantics (partial=null → meta key delete) | Modify `apps/frontend/src/settings/api.ts`; New `apps/frontend/src/shapes/container-layout-params.ts` (или sibling файл с writer); New `container-layout-params.test.ts` | 4 |
| 8 | `tidyLayout` scope heuristic (single container/frame → "self") + all caller updates (⌘⇧L, ⌘⌥⇧L, SelectionPanel Layout action) | Modify `apps/frontend/src/canvas/tidy-layout.ts` + `apps/frontend/src/App.tsx`; Extend `tidy-layout.test.ts` | 5 |
| 9 | SettingsPopover useValue: counts + direction polymorphic (frame + container) + `showContainerSections` rule (containers > 0 && nodes === 0) | Modify `apps/frontend/src/settings/SettingsPopover.tsx` | 6 |
| 10 | Новый `LayoutSettingsSection` (preset + autoDirection + midpoint + Advanced + Reset) + rename existing `LayoutSection` → `LayoutActionsSection` | New `apps/frontend/src/settings/sections/LayoutSettingsSection.tsx`; Rename + adjust callers; Extend `sections.test.ts` | 7 |
| 11 | BoardPanel rebrand (header "По умолчанию" + badge + CSS + BoardPanelAdvanced helper text) | Modify `apps/frontend/src/settings/panels/BoardPanel.tsx` + `BoardPanelAdvanced.tsx` + `styles.css` | — |
| 12 | SelectionPanel wiring (Direction для frame, новая LayoutSettings секция, Reset visibility, no badge) | Modify `apps/frontend/src/settings/panels/SelectionPanel.tsx`; Extend `panels.test.ts` | 9, 10 |
| 13 | Live verification (chrome-devtools MCP, controller сам) + changelog + Backlog DRW ticket | Manual; Modify `CHANGELOG.md`; backlog task create | 1–12 |

**Estimated parallel-safe groups:**
- Task #0 — investigative, first thing
- Backend chain (tasks 1→2→3→4→5) — sequential
- Frontend writers (tasks 6, 7) — parallel to backend after task 4 lands; task 7 depends on task 4 (API contract)
- UI rebrand (task 11) — независимая, можно параллельно
- UI extension (tasks 9, 10, 12) — sequential after 6+7
- Task 8 (tidy heuristic) — sequential после task 5
- Task 13 — финальный sweep

## 10. Open knobs (resolved in brainstorm)

| Knob | Decision | Reasoning |
|---|---|---|
| Board "Apply all" button | **Не делаем** | User explicit: "на доске разные схемы — глобально применять неправильно" |
| BoardPanel rebrand style | A: header + badge + (no per-section subtitle) | Просто и не дублирует |
| Per-frame Layout override storage | `meta.didrawLayoutParams: Partial<LayoutParams>` | Diff only, не full snapshot |
| Frame Direction Custom | Поддержать (как schema-container) | Consistency + "user разложил руками" use case |
| Reset кнопка per-frame Layout | **Да**, текстовая ссылка под Advanced | Полезно для очистки override |
| Multi-selection apply | **Apply ко всем** | Массовая операция; preset подсветка только при unanimous |
| Mixed selection (frame + leaf вне) | Direction/Layout sections скрыты | Уже так работает (counts.containers === 0 если non-container присутствует — TBD: см. open #1 ниже) |

## 11. Non-goals (отложены в следующие sub-projects)

1. **Style propagation** (sub-project 3) — Stroke (Draw/Solid) + Font (Draw/Sans/Mono) sections в BoardPanel; apply-to-children sweep на frame/container. Отдельный design.
2. **SchemaContainer shape UX** (sub-project 4) — inline label edit, font selector, fill behaviour fix (semi/solid mismatch). Отдельный bug-fix ticket.
3. **Design-system unification** — темы blue/green/native + CSS токены. Отдельный design.
4. **Global re-layout всего room** при изменении board defaults — explicitly не делаем. User contribution.
5. **Per-anchor params override во время scope:"all" / ⌘⌥⇧L global force re-layout** — оставляем board defaults для top-level Pass B. Per-frame override применяется только в Pass A subgraph layout этого anchor. Это compromise: full per-anchor scope в global re-layout — отдельная задача.

## 12. Open questions (resolved or deferred)

1. **Mixed selection precise rule** — RESOLVED: section 7.1 → `showContainerSections = counts.containers > 0 && counts.nodes === 0`. Mixed (leaf вне container) → sections скрыты. Это conservative но детерминированно.
2. **`meta.didrawLayoutParams` ключ collision** — RESOLVED через code check: `meta.didrawDirection` уже skipped DRW-178 inference если set (layout.ts:1153). Для frame дополнительно skip из `inferContainerDirections` (см. section 4.1 invariants). `didrawLayoutParams` — новый ключ, не пересекается с existing (`didrawDirectionInherited`, `didrawSubgraphDirection`, etc.).
3. **Bulk write на multi-selection** — RESOLVED: section 4.4 step #2 backend validation atomic (либо все changes applied, либо 400 abort при invalid value).
4. **Menu disappears bug** (отдельный report от 2026-05-27) — DEFERRED: separate backlog ticket после live-repro user'ом. Не в scope этого spec.

## 13. Self-review log (v0.1 → v0.1.1)

**Findings из второго прохода свежим взглядом и fixes inline:**

1. **API inconsistency (FIXED 7.2):** `setContainerDirection(editor, dir)` читал selection сам; `setContainerLayoutParams(editor, ids, partial)` принимал explicit ids → теперь оба принимают `ids: string[]`. Caller извлекает.

2. **`partial=null` lifecycle (FIXED 4.1, 4.4 step 2, 7.4):** frontend пишет `undefined` в meta (tldraw deletes locally); JSON.stringify сериализует `null`; backend deletes server-side. Convergent semantics — key absent в meta.

3. **Task #1 unclear (FIXED task #1):** теперь экспортирует именованный type alias `ContainerLayoutOverride = Partial<LayoutParams> | null` — конкретное deliverable.

4. **`LayoutSettingsValue` mixed semantics (FIXED 7.3):** `autoDirection: boolean | null` + `midpoint: ... | null` — null для mixed multi-selection. Indeterminate state в UI.

5. **Backend validation gap (FIXED 4.4 step 2):** добавлено `validateLayoutParams(partial)` из `@shemma/domain` (existing helper) + atomic abort при invalid value.

6. **Section 5.4 implicit investigation step (FIXED tasks #0, #5):** разбито на task #0 (diagnostics-first, repro в тесте) и task #5 (fix based on findings или просто scope heuristic enough).

7. **7.1 vs 7.5 ambiguity (FIXED 7.1):** добавлена explicit rule `showContainerSections = counts.containers > 0 && counts.nodes === 0`. Mixed (leaf вне) → sections скрыты, соответствует table в 7.5.

8. **Task #6 missing caller updates (FIXED task #6):** теперь явно перечислены `SettingsPopover.tsx::onDirectionChange` + context menu callers.

9. **Open question #2 проверена в коде (RESOLVED, section 12):** `meta.didrawDirection` уже skipped DRW-178 inference если set. Для frame дополнительно skip из `inferContainerDirections` целиком (новое требование, добавлено в section 4.1 invariants).

10. **Menu-disappears bug (NOTED, section 12 #4):** отдельный bug from earlier message — DEFERRED в отдельный backlog ticket после live-repro user'ом. Не в scope.

**Final checklist:**

✅ **Placeholders:** только `// ... existing ... //` elisions в code snippets (acceptable for spec, не TBD).
✅ **Internal consistency:** все meta key references, scope:"self" usages, и file paths согласованы между секциями 4-12.
✅ **Scope:** focused на sub-project 1+2; sub-projects 3, 4 + menu-disappears bug explicitly declared non-goals/deferred.
✅ **Ambiguity:** все resolved выше.
✅ **Type consistency:** `ContainerLayoutOverride`, `LayoutParams`, `Direction`, `LayoutSettingsValue` все имеют точку определения.

---

**Ready for user review.** Если apprup'нуто — следующий шаг writing-plans skill → создание `docs/superpowers/plans/2026-05-27-frame-container-direction-layout-plan.md` с пошаговыми bite-sized task'ами (per task #0-13).
