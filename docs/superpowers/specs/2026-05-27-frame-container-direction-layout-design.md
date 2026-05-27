# Frame & Container Direction + Layout — design spec

- **Date:** 2026-05-27
- **Status:** Draft v0.1 (brainstorm → spec; awaits user review)
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

- `didrawLayoutParams: Partial<LayoutParams>` — храним diff, не full snapshot. Если user сбрасывает → backend deletes key.
- `didrawDirection: "custom"` для frame и schema-container = legitimate state ("user разложил руками"); backend skip автолейаут этого subgraph (как уже работает для schema-container через `isCustomDirection`).
- Schema-container продолжает использовать `props.direction` (не дублируем в meta).
- Frame `meta.didrawDirection` — единственный канал (нет `props.direction` у native frame).

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
   - `Partial<LayoutParams>` → `shape.meta.didrawLayoutParams = partial`.
   - Validation: только если shape is frame or schema-container; иначе skip + warn.
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

В `runLayoutSubgraph` уже работает `containerScope === "self"` (line 856-861: skip Pass B). Дополнительно проверить что Pass C (apply) при `scope === "self"` **не пишет frame props.w/h** для frame'ов, которых нет в `filterToIds`. Если такая утечка есть — fix + регрессионный тест.

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
const containers = selected.filter(
  (s) => s.type === "schema-container" || s.type === "frame"
).length;

const direction = useValue("dir", () => {
  const containers = selected.filter(
    (s) => s.type === "schema-container" || s.type === "frame"
  );
  if (containers.length === 0) return null;

  const readDir = (s) =>
    s.type === "schema-container"
      ? (s.props?.direction ?? null)
      : (s.meta?.didrawDirection ?? null);

  const first = readDir(containers[0]);
  return containers.every((c) => readDir(c) === first) ? first : null;
}, [editor]);
```

### 7.2 Polymorphic writer `setContainerDirection`

`apps/frontend/src/shapes/schema-container/SchemaContainerActions.ts` либо новый helper `apps/frontend/src/shapes/container-actions.ts`:

```ts
export function setContainerDirection(editor, dir: Direction): void {
  const ids = editor.getSelectedShapeIds();
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

**Note:** старый `setSchemaContainerDirection` помечается deprecated или сразу удаляется (см. секция 9 task #6). Callers переключаются на `setContainerDirection`.

### 7.3 Новый компонент `LayoutSettingsSection`

Существующий `LayoutSection` (Tidy / Force-unpin) переименовать в `LayoutActionsSection`. Новый компонент:

```tsx
// apps/frontend/src/settings/sections/LayoutSettingsSection.tsx
export type LayoutSettingsValue = {
  preset: "compact" | "normal" | "roomy" | null;     // null = mixed / custom
  autoDirection: boolean;
  midpoint: "even" | "fixed-0.5";
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

В SelectionPanel: `current` derived from `selected[i].meta.didrawLayoutParams` (если 1 frame/container) или first.

### 7.4 Writer `setContainerLayoutParams`

```ts
export async function setContainerLayoutParams(
  editor,
  ids: string[],
  partial: Partial<LayoutParams> | null,
): Promise<void> {
  // Optimistic local update
  editor.run(() => {
    for (const id of ids) {
      const s = editor.getShape(id);
      if (s?.type === "schema-container" || s?.type === "frame") {
        editor.updateShape({ id, type: s.type, meta: { didrawLayoutParams: partial }});
      }
    }
  });

  // Backend POST
  const override: Record<string, Partial<LayoutParams> | null> = {};
  for (const id of ids) override[id] = partial;

  await fetch(`/api/agent/layout-selection?...`, {
    method: "POST",
    body: JSON.stringify({ ids, scope: "self", layoutParamsOverride: override }),
  });
}
```

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
| 1 | `meta.didrawLayoutParams` type alias в `@shemma/domain` (для shared use) | Modify `packages/shemma-domain/src/layout-params.ts` | — |
| 2 | `readContainerDirection` + `isCustomDirection` extension для frame | Modify `apps/backend/src/domain/layout.ts`; New `layout-direction-frame.test.ts` | 1 |
| 3 | `runLayoutSubgraph` per-anchor params override (читает meta) | Modify `apps/backend/src/domain/layout.ts`; New `layout-params-override-per-frame.test.ts` | 2 |
| 4 | POST `layoutParamsOverride` body validation + atomic meta write | Modify `apps/backend/src/routes/layout-selection.ts`; Extend `routes-layout-selection-payload.test.ts` | 3 |
| 5 | Scope invariant fix + regression | Modify `apps/backend/src/domain/layout.ts` (если найдём утечку в Pass C); New `layout-selection-scope-invariant.test.ts` | 4 |
| 6 | `setContainerDirection` polymorphic writer (заменяет `setSchemaContainerDirection`) | Modify `apps/frontend/src/shapes/schema-container/SchemaContainerActions.ts` или new; New `container-actions.test.ts` | — |
| 7 | `setContainerLayoutParams` writer + API wrapper | New `apps/frontend/src/settings/api.ts` extension; New `container-layout-params.test.ts` | 4 |
| 8 | `tidyLayout` scope heuristic + caller updates | Modify `apps/frontend/src/canvas/tidy-layout.ts` + `apps/frontend/src/App.tsx`; Extend `tidy-layout.test.ts` | 5 |
| 9 | SettingsPopover useValue: counts + direction polymorphic (frame + container) | Modify `apps/frontend/src/settings/SettingsPopover.tsx` | 6 |
| 10 | Новый `LayoutSettingsSection` + rename existing → `LayoutActionsSection` | New `apps/frontend/src/settings/sections/LayoutSettingsSection.tsx`; Rename + adjust callers; Extend `sections.test.ts` | 7 |
| 11 | BoardPanel rebrand (header + badge + CSS) | Modify `apps/frontend/src/settings/panels/BoardPanel.tsx` + `styles.css` | — |
| 12 | SelectionPanel wiring (Direction для frame, новая LayoutSettings секция, Reset, no badge) | Modify `apps/frontend/src/settings/panels/SelectionPanel.tsx`; Extend `panels.test.ts` | 9, 10 |
| 13 | Live verification + changelog + Backlog DRW ticket | Manual; Modify `CHANGELOG.md` | 1–12 |

**Estimated parallel-safe groups:**
- Backend chain (tasks 1→5)
- Frontend writers (tasks 6→8) — parallel to backend after task 4 lands
- UI rebrand (task 11) — independent, can go in parallel
- UI extension (tasks 9, 10, 12) — sequential after 6+7

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

## 12. Open questions (not blocking, future-facing)

1. **Mixed selection precise rule** — сейчас `counts.containers` считается через filter; если selection = [container, leaf_inside_container] → containers=1, nodes=1 (leaf is child) → SelectionPanel показывает Direction секцию? Уточнить во время impl.
2. **`meta.didrawLayoutParams` для schema-container** — backend всегда читает `meta`; frontend writer тоже. Но `meta` на schema-container сейчас уже used для `didrawDirectionInherited` etc. — нужно убедиться что не пересекается.
3. **Bulk write на multi-selection** — POST с `layoutParamsOverride: {id1: p, id2: p, id3: p}` всё в одном запросе. Backend atomic — либо все, либо никто (validation). Это уже design contract.

## 13. Self-review (inline)

✅ **Placeholders:** прошёлся — нет TBD кроме section 12 "open questions" которые marked as not blocking.

✅ **Internal consistency:**
- Section 4.3 + 7.4 oба ссылаются на `meta.didrawLayoutParams` chain — согласовано.
- Section 5 scope heuristic + section 7 SelectionPanel rules — `scope:"self"` для container/frame везде согласовано.
- Section 9 decomposition покрывает все компоненты из секций 4-8.

✅ **Scope:** focused — это объединённый sub-project 1+2 (frame+container direction/layout + board rebrand). Sub-projects 3 (style) и 4 (container shape UX) явно declared non-goals.

✅ **Ambiguity:**
- "Apply ко всем" (multi-selection) уточнено: backend atomic, frontend optimistic для каждого.
- `meta.didrawLayoutParams = null` → backend delete (явно прописано).
- Frame Custom direction → skip Pass A (явно прописано).

✅ **No vague requirements:** все API contracts с типами, все file paths указаны.

Минор замечание — section 12 "Open questions" есть, но они помечены как not-blocking + future-facing. Impl сможет принять решение на месте.

---

**Ready for user review.** Если apprup'нуто — следующий шаг writing-plans skill → создание `docs/superpowers/plans/2026-05-27-frame-container-direction-layout-plan.md` с пошаговыми bite-sized task'ами (per task #1-13).
