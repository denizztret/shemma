# DRW-149 — Autolayout внутри schema-frame с bottom-up иерархией

**Версия:** v0.2 (2026-05-24 — discovery о существующем `runLayoutSubgraph`, переписан Algorithm + Implementation order)
**Дата:** 2026-05-24
**Источник:** brainstorm-сессия 2026-05-24 с user; заменяет cancelled DRW-142..146.
**Связано:** DRW-147 (storage paths), DRW-148 (legacy v1 cleanup), DRW-150 (custom shape follow-up), DRW-151 (research native mermaid), DRW-152 (per-subgraph direction), DRW-153 (mermaid style directives).
**Branch:** `feature/drw-149-autolayout-in-frame`.

## TL;DR

`Cmd+Shift+L` должен корректно работать на schema-frame и его содержимом: рекурсивно (bottom-up) выравнивать все вложенные frame/shape-container'ы и их детей, не затрагивая внешний мир и наоборот. Frame ведёт себя как envelope — resize'ится под bbox детей. При выделении `frame + external` — frame участвует во внешнем layout как монолит **после** того, как его внутренний layout уже выполнен.

## Goals

- **G1.** Cmd+Shift+L на schema-frame → рекурсивно layout всех его детей (включая вложенные shape-container'ы и nested frames bottom-up). На каждом уровне родитель resize'ится под bbox + padding.
- **G2.** Cmd+Shift+L на детях schema-frame (без самого frame) → тот же визуальный результат что для (G1).
- **G3.** Cmd+Shift+L на schema-frame + external — два прохода за одно нажатие: сначала внутренний (layout детей + resize frame), потом внешний (frame как монолитный блок + external peers).
- **G4.** Снять short-circuit `< 2 noop` (frontend и backend) — single shape возвращает `ok` без изменений и без error.
- **G5.** Внешние arrow-связи (binding от child внутри frame к external shape) **не влияют** на внутренний layout — фильтруются на inner pass.
- **G6.** Сохранить инварианты:
  - У обычных шейпов (services) меняется только `position` (x, y).
  - У envelope-шейпов (schema-frame, shape-container) можно менять размер (`x/y/w/h`) — через PatchOp, минуя `Editor.resizeShapes` (чтобы не каскадить resize детей).
  - Z-порядок не трогаем.
  - `meta.pinned: true` и `meta.styleOwnedBy: "user"` уважаются (см. AC-7).
- **G7.** Autolayout — **атомарная undo-able операция**. После `Cmd+Shift+L` пользователь одним `Cmd+Z` возвращает все шейпы и envelope'ы в исходное состояние; `Cmd+Shift+Z` восстанавливает post-layout. Один autolayout = одна запись в undo stack.

## Non-goals

- Custom tldraw shape `schema-container` (отдельный ticket DRW-150).
- Cleanup legacy v1 модели (subgraph = frame с didrawIsGroup) — отдельный ticket DRW-148.
- Storage path resolver fix для dev daemon — отдельный ticket DRW-147.
- ELK compound layout single-pass — рассматриваем как upgrade path в будущем (см. §Open questions).
- Migration существующих rooms с дубликатами обёрток (как dev default — там по 3 копии каждого subgraph). Чистка вручную или пересоздание — user уже подтвердил что важного содержимого нет.
- Per-subgraph direction в mermaid (DRW-152) и mermaid style directives (DRW-153) — отдельные тикеты, не зависят от DRW-149.
- Pin/style ownership расширение для новых cases — текущие правила сохраняются как есть.

## Background

### Состояние main на момент brainstorm'а

- HEAD = `cbaf7bb` (pre-DRW-142 baseline). Все попытки 142..145 откачены.
- Frontend short-circuit в `apps/frontend/src/canvas/tidy-layout.ts:26-34` — `if (ids.length < 2) return noop`. До backend запрос не уходит.
- Backend short-circuit двойной: `apps/backend/src/routes/layout-selection.ts:84-91` (rawIds.length) и `:132-140` (resolved affectedIds.size). Те же `< 2 noop`.
- Backend `runLayout` в `apps/backend/src/domain/layout.ts` (964 строки) — single-pass ELK с `scope="affected"`, никакой frame-expansion и hierarchy логики не имеет.
- Frame-expansion (был в DRW-142 как `expandFramesInvolvedInSelection`) — откачен.

### Две модели subgraph в проде сейчас

| | Legacy v1 (release default room) | v2 (DRW-134, dev default room) |
|---|---|---|
| Как создаётся | `shemma_import_mermaid mode=legacy` | `shemma_import_mermaid mode=browser` через `POST /api/schema/create` |
| schema-frame общий? | нет, subgraph-frame'ы прямо на странице | да, один frame оборачивает всю схему |
| subgraph = | tldraw `frame` с `meta.didrawIsGroup: true` | `geo` с `meta.didrawSubgraph: true, role: "boundary"` |
| Поведение | стандартное frame (drag/orphan/select-as-whole) | `geo` с детьми parented (drag двигает детей; resize **каскадирует** на детей через `Editor.resizeShapes`) |

DRW-149 фокусируется на **v2 модели** (где shape-container = `geo`). Legacy v1 cleanup — DRW-148.

### Уже существующее — `runLayoutSubgraph` (DRW-099)

В `apps/backend/src/domain/layout.ts:498-754` уже есть **256 строк** функции `runLayoutSubgraph` с трёхпроходным hierarchical layout (наследие DRW-099):

- **Pass A** (`runPassA`, lines 376-487) — per-compound layout: для каждого anchor container и каждого selected container, у которого есть selected children, запускает локальный ELK layout его children + вычисляет `newW`/`newH` под bbox.
- **Pass B** (lines 601-714) — top-level ELK layout на selected top-level shapes (selected frames присутствуют как leaf-nodes с size из Pass A). Cross-compound edges remap'аются на container-to-container.
- **Pass C** (lines 718-752) — assembly финальных позиций: top-level из Pass B, parent-relative из Pass A для children, anchor containers сохраняют свой `x/y` но получают новый `w/h`.
- **Anchor frame detection** (lines 518-547) — frame НЕ в selection, но содержит selected descendant → marked as anchor; propagation вверх по parent chain.
- **Cross-compound edges** — remap через `liftToTopLevel` (lines 662-680) + dedup.
- **Single-node Pass B short-circuit** (lines 683-700) — для случая когда top-level node всего один (например selected frame один), Pass B skip'ает ELK и просто merge'ит Pass A child positions.

**Что это значит для DRW-149:** большая часть bottom-up алгоритма уже работает. Реальный gap — это, в основном, **доступ** (frontend/backend short-circuit'ы не дают вызвать `runLayoutSubgraph` для single-frame selection) + **undo support** (новая работа) + точечные fix'ы по тому что вскроет probe.

### Что user видел в dev default комнате

- 88 шейпов: 1 `frame` (schema-frame, без `props.name`, 2565×2543), 54 `geo`, 33 `arrow`.
- 18 шейпов с `meta.role: "boundary"` (shape-container'ы), `didrawLabel`: "Оркестрация", "Потребители", "Результат маршрутизации"…
- **Дубликаты** — каждый subgraph встречается по 3 копии (следы тройного импорта без очистки). Пользователь почистит вручную перед E2E.
- Часть shape-container'ов внутри schema-frame, часть снаружи (`parentId: "page:page"`). Это побочный артефакт текущего mermaid-import flow, не часть DRW-149 scope (мы предполагаем что после fix импорта все shape-container'ы будут consistently внутри schema-frame).

## Terminology

- **schema-frame** — внешняя обёртка всей схемы. Тип шейпа: tldraw `frame`. Содержит сервисы и shape-container'ы как children.
- **shape-container** — обёртка subgraph внутри schema-frame. Тип шейпа: tldraw `geo` rectangle с `meta.role: "boundary"`, `meta.didrawSubgraph: true`, `meta.didrawSubgraphName`, `meta.didrawLabel`. Сервисы parent'ятся в него через `parentId`.
- **service** — обычный шейп (`geo`, `arrow` и др.), который представляет узел схемы. Не envelope.
- **envelope** — общее название для shape'ов, которые могут менять размер под bbox детей: schema-frame и shape-container.
- **involved container** — envelope, который попадает в текущий layout pass (либо был выделен, либо содержит выделенный shape).
- **container tree** — дерево envelope'ов, построенное по `parentId`, с листьями внизу и schema-frame наверху.

## Architecture

### Resize strategy (Approach X) — PatchOp без onResize

Tldraw's `Editor.resizeShapes` запускает `ShapeUtil.onResize` hook, который для родительских шейпов **каскадирует** resize на детей (пропорциональное масштабирование local coords). Это убивает наш layout: после inner pass дети уже стоят на правильных позициях; resize обёртки через high-level API двигает их повторно.

**Решение:** backend пишет `x`, `y`, `w`, `h` envelope'а напрямую как `PatchOp` в `r.store`. WS-sync доставляет patch на frontend, frontend применяет его через `store.put({...})` — это **raw record update**, без вызова shape utility hooks. Дети остаются на новых позициях, заданных layout'ом.

В коде это означает: вместо `editor.resizeShapes([id], scale)` мы делаем `batch.updated[id] = { ...prev, x, y, w, h }` и публикуем через bus.

### Undo support (G7)

Tldraw native undo stack оперирует на client-side. Server-originated patches (WS-sync) **по дефолту не попадают в undo** автоматически — это считается external change, не пользовательской операцией.

Чтобы Cmd+Shift+L был одной undo-step, нужен явный wrap. Два подхода (выбор окончательно — в Plan stage после probe):

- **(α) Server hint + frontend wrap.** Backend в response/patch добавляет `undoLabel: "autolayout"`. Frontend WS-handler оборачивает apply этого patch'а в `editor.markHistoryStoppingPoint("autolayout") + editor.batch(...)`. Pros: backend остаётся SSOT, всё проходит через привычный WS-sync. Cons: дополнительный hook в WS-handler для распознавания "transactional" patch'ей.
- **(β) Client-driven apply.** Backend в response возвращает explicit positions (`affected: [{id, x, y, w?, h?}, ...]`). Frontend применяет через `editor.updateShapes([...])` — это native tldraw операция, автоматически попадает в undo. WS-broadcast другим клиентам идёт как обычно; originating клиент игнорирует свой echo через существующий `echo-guard` (см. memory). Pros: чистая native undo семантика, нет специальной WS-логики. Cons: дублирует apply (client + WS round-trip), нужна точная echo-detection.

**Предлагаю (β)** — более чистая семантика, использует native tldraw flow и существующий echo-guard. Финальный выбор — на plan stage после 30-минутного probe текущего WS-sync apply pipeline (`apps/frontend/src/transport/ws.ts`) и проверки tldraw 5.x `editor.batch`/`markHistoryStoppingPoint` API (memory `feedback-tldraw-docs` — читать docs перед утверждениями).

### Algorithm — gap-fill в `runLayoutSubgraph` (Approach 1)

Existing `runLayoutSubgraph` уже реализует Pass A / Pass B / Pass C, anchor detection, cross-compound edge remap, single-node short-circuit. **Не** переписываем алгоритм с нуля. DRW-149 фокусируется на:

1. **Открыть путь к нему** для single-frame selection — снять `< 2 noop` short-circuits в `tidy-layout.ts` и `layout-selection.ts`.
2. **Гарантировать** что resize envelope под bbox **попадает в `batch.updated`** как изменение `props.w` / `props.h` (для frame и для geo). Сейчас `runLayoutSubgraph` возвращает `positions[id].w/h`, но конверсия в PatchOp выполняется в `runLayout` после Pass C — нужно verify через probe что для **обоих** типов envelope (frame и geo) поля пишутся правильно (frame: `props.w/h`; geo: `props.w/h` — оба через `props`). Если найдём gap для shape-container'а (`geo`) — точечный fix.
3. **Не использовать `Editor.resizeShapes` на frontend** при apply. Применение `batch.updated` уже идёт через `applyStoreChanges` + WS-sync + `store.put` на фронте, минуя shape hooks — `onResize` не вызывается, дети не каскадируются (Approach X). Probe verify.
4. **External arrow filtering для inner pass** — Pass A передаёт `filterToIds` в `buildEdges`, который фильтрует edges по `includedIds` (only selected children). Probe verify что cross-boundary arrows реально не тянут inner children. Если найдём gap — точечный fix.
5. **Pinned envelope behaviour** — текущий код в `runLayout:828-832` восстанавливает pinned coords после layout. Probe verify что pinned envelope (`meta.pinned: true`) остаётся на месте при bottom-up flow.
6. **Undo support (G7)** — новая работа: client-side oborachivanie apply в `editor.markHistoryStoppingPoint("Autolayout") + editor.batch(...)`. См. §Undo support.

### Probe-задача (Phase 1)

Перед написанием fix'ов нужно через integration-тесты на текущем коде задокументировать **точное** поведение `runLayoutSubgraph` для следующих случаев (с снятыми `< 2 noop` short-circuits):

| Case | Что проверяем |
|---|---|
| `filterToIds = {schema-frame}` (один frame) | Дети layout'нуты Pass A? Frame resized под bbox? Frame x/y остался прежним (top-level single-node Pass B short-circuit)? |
| `filterToIds = {schema-frame, external_shape}` | Pass A на дети frame + Pass B на 2 elkChildren (frame as leaf + external)? Cross-compound edges правильно remap'нуты? |
| `filterToIds = {childA, childB, ...}` (только дети frame, без frame) | Anchor detection: frame должен стать anchor; Pass A на детях. Результат как для frame-selected? |
| `filterToIds = {shape-container внутри schema-frame}` | Inner Pass A на детях shape-container'а; Pass B trivially short-circuited. shape-container resized? schema-frame не двигается? |
| External arrow от child внутри frame к external | Inner Pass A фильтрует cross-boundary edge; external arrow не тянет inner child наружу. |
| Pinned envelope (frame с `meta.pinned: true`) | Frame x/y восстановлен после layout. |

**Gap analysis** документируется как часть Phase 1 — реальные изменения Phase 3+ зависят от того что найдено.

### Undo support (G7) — реализация на plan stage

Spec предложил подход β (client-driven apply). Финальный выбор — после краткой probe в Phase 1 текущего WS-sync pipeline (`apps/frontend/src/transport/ws.ts`) и tldraw 5.x history API. Подход реализуется одним из:

- **β client-driven:** frontend получает response с explicit positions, вызывает `editor.updateShapes([...])` внутри `editor.markHistoryStoppingPoint("Autolayout")`. WS-broadcast другим клиентам идёт через bus; originating клиент скипает свой echo через existing echo-guard.
- **α server-hint+wrap:** backend в response добавляет `undoLabel: "Autolayout"`. Frontend WS-handler оборачивает apply этого patch'а в `markHistoryStoppingPoint + editor.batch`.

### Edge cases

- **Container с 0 children** (например, схема-frame пуст) — skip inner pass, не trogат envelope size.
- **Container с 1 ребёнком** — inner pass тривиален (1 node, no edges) → ребёнок остаётся на месте. Envelope resize'ится под bbox этого ребёнка + padding.
- **Envelope без bbox изменений** — не emit'им PatchOp для envelope (idempotency).
- **Pinned shapes (`meta.pinned: true`)** внутри inner pass — **исключаем из nodes**, но учитываем их в bbox calculation (envelope resize'ится с учётом pinned children). Edges, ведущие в/из pinned — учитываются для других shapes (как anchor).
- **Style-owned shapes (`meta.styleOwnedBy: "user"`)** — не трогаются на уровне style; layout меняет только position.
- **External arrows** (binding inner→outer): фильтруем в inner pass. В outer pass — учитываются (envelope как монолит связан стрелкой с external peer).
- **Cross-container arrows** (binding между двумя shape-container'ами на одном уровне) — учитываются в outer pass этого уровня (где container'ы — peer nodes).
- **Cycles в parent chain** — невозможны (tldraw enforces tree). Защита через `Set<visited>` для безопасности.
- **Empty selection (rawIds.length === 0)** — return `{ok: true, count: 0, hint: "..."}`.
- **All ids unresolved** — return `400` как сейчас (legitimate error).

### Файлы изменений

| Файл | Что меняем |
|---|---|
| `apps/frontend/src/canvas/tidy-layout.ts:26-34` | Удалить `< 2 noop` short-circuit. Передавать любое количество ids. |
| `apps/backend/src/routes/layout-selection.ts:84-91, 132-140` | Удалить оба `< 2 noop` branch. Single id → ok с count=0, не error. Передавать ids дальше в `runLayout` (с `scope: "affected"`). |
| `apps/backend/src/domain/layout.ts` | Probe-based точечные fix'ы. Возможные изменения (по findings Phase 1): корректная запись `props.w/h` для shape-container resize в `runLayout` после Pass C; уточнение `buildEdges` filtering если cross-boundary edges пробиваются; корректировка single-frame Pass B short-circuit поведения если оно пропускает resize. **НЕ переписываем алгоритм с нуля.** |
| `apps/frontend/src/transport/ws.ts` или связанный (для Undo G7) | По выбранному undo-подходу (Phase 5): либо apply через `editor.updateShapes(...)` внутри `editor.markHistoryStoppingPoint` с echo-guard (β), либо WS-handler hook для `undoLabel: "Autolayout"` patch wrapping (α). |
| Tests: `apps/backend/tests/domain/layout.test.ts` | Probe integration-тесты (Phase 1), затем fix-related unit-тесты после Phase 3. |
| Tests: `apps/backend/tests/routes-layout-selection.test.ts` | Обновить existing тесты (removal of `< 2 noop` ожидаемого поведения, single id → 200 ok). Новые тесты на frame-selection, frame+external. |
| Tests: `apps/frontend/src/canvas/tidy-layout.test.ts` | Removal `< 2 noop` тестов, добавление тестов на single-id передачу. |
| Tests: frontend undo (Playwright или manual checklist) | Snapshot → autolayout → Cmd+Z → сравнить с snapshot (AC-12). |

## API contract

### Frontend — `tidyLayout(ids, space, room)`

**Было:**
```ts
if (ids.length < 2) {
  return { kind: "noop", reason: "need 2+ shapes to tidy" };
}
```

**Будет:** удалить блок целиком, всегда отправлять fetch с `ids`. Backend сам решает.

Дополнительно: добавить опциональный параметр `selectionMode` если нужен для frontend hints в будущем. В текущем DRW-149 — не нужно.

### Backend — `POST /api/agent/layout-selection`

**Request body** (без изменений):
```json
{ "ids": ["shape:xxx", "shape:yyy", "service-name"] }
```

**Response** (без изменений в shape, новые семантики):
```json
{
  "ok": true,
  "version": 42,
  "count": 17,
  "affected": ["shape:a", "shape:b", ...],
  "unresolved": ["non-existent-name"]
}
```

**Новые ответы:**
- `ids: []` или resolved `[]` → `{ok: true, count: 0, hint: "no shapes selected"}`.
- `resolved.length === 1` → `{ok: true, count: 0, hint: "single shape — no layout needed"}`.

### Backend — `runLayout` сигнатура

**Было** (упрощённо):
```ts
runLayout(store, hint: { mode, scope: "affected", spacing, affectedIds }, didrawIndex): Promise<LayoutResult>
```

**Будет** — та же сигнатура, новая внутренняя логика:
1. Если `hint.scope === "affected"` и `hint.affectedIds` содержит envelopes — переход на bottom-up алгоритм.
2. Иначе — fallback на текущий single-pass (для backward compat).

## Tests

### Unit tests

(Конкретный список — после Phase 1 probe; зависит от какие gap'ы найдены и какие fix-ы нужны. Базовые ожидаемые покрытия:)

- Existing `runLayoutSubgraph` behavior для new use cases (через probe-thin integration тесты в `apps/backend/tests/domain/layout.test.ts`):
  - `filterToIds = {single frame}` — children laid out + frame resized.
  - `filterToIds = {single shape-container}` — inner Pass A on его children + container resized.
  - `filterToIds = {frame, external}` — Pass B на двух top-level + frame inner Pass A.
  - `filterToIds = {child only, без parent envelope}` — anchor detection.
  - External arrow (binding inner→outer) — не двигает inner shape.
- Любые fix-related unit-тесты (по Phase 3 findings) — пишутся при импleментации fix'а.

### Integration tests

- Backend route `/api/agent/layout-selection`:
  - Empty ids → 200 ok count=0.
  - Single id → 200 ok count=0.
  - Frame-only selection → expand to children → layout + resize.
  - Frame children only (без frame) → same result.
  - Frame + external → 2 passes.
  - All unresolved → 400.
  - Pinned shape in selection → не двигается.

### E2E

- На user'овой dev default комнате (после cleanup дубликатов): Cmd+Shift+L на schema-frame → проверить что services aligned, shape-container'ы resized, schema-frame resized.
- Manual test plan в `docs/manual-tests/drw-149-autolayout-in-frame.md` (создать в процессе implementation).

## Phasing

**Phase 1 — Probe & gap analysis (1 task).**
- Снять `< 2 noop` short-circuits локально (revert'аемо).
- Запустить integration тесты на existing `runLayoutSubgraph` через все 6 cases из probe-таблицы.
- Задокументировать gap'ы в `docs/superpowers/specs/2026-05-24-drw-149-probe-findings.md`.
- Probe WS-sync pipeline и tldraw 5.x history API → финальный выбор undo-подхода (α или β).

**Phase 2 — Short-circuit removal (1 task).**
- Удалить `< 2 noop` в frontend (`tidy-layout.ts:26-34`).
- Удалить `< 2 noop` в backend (`layout-selection.ts:84-91, 132-140`); single id → 200 ok count=0.
- Обновить existing тесты (frontend `tidy-layout.test.ts`, backend `routes-layout-selection.test.ts`).

**Phase 3 — Gap fixes (0-N tasks, по results Phase 1).**
- Точечные fix'ы в `runLayoutSubgraph` / `runLayout` / `buildEdges` по findings.
- Unit tests для каждого fix.

**Phase 4 — Integration tests (1 task).**
- Полное покрытие route-level: frame-only, frame+external, nested, pinned envelope, external arrow filtering.

**Phase 5 — Undo support (G7) (1-2 task).**
- Реализация выбранного подхода (α или β из Phase 1 probe).
- Tests: snapshot → autolayout → Cmd+Z → диф с snapshot.

**Phase 6 — Manual E2E + dogfooding (1 task).**
- Manual test plan markdown `docs/manual-tests/drw-149-autolayout-in-frame.md`.
- E2E на user'овой dev default комнате (после user cleanup дубликатов).

**Phase 7 — Release (1 task).**
- `bun run test` — all packages green.
- CHANGELOG entry.
- Release commit + tag `0.25.0`.
- Merge feature branch в main через `--no-ff`.

## Open questions

- **OQ-1.** `padding` для envelope resize — фиксированное число (16px)? Или конфигурируемое через `body.spacing`? Предлагаю: `PADDING = 16` константа в первой версии, конфигурируемое — отложить до feedback.
- **OQ-2.** В каком порядке делать top-level pass для случая `frame + external`: после всех envelope passes (как описано) или **параллельно** с самым нижним envelope pass (нет, не имеет смысла — top-level зависит от bbox top-level envelope'ов). **Предлагаю:** после всех envelope passes — точно как в спецификации.
- **OQ-3.** Pinned envelope (`schema-frame` с `meta.pinned: true`) — двигаем ли в outer pass? **Предлагаю:** нет — pinned envelope остаётся на месте, его inner pass запускается как обычно (только дети двигаются), bbox bumpается под детей но position сохраняется. Если bbox увеличивается — envelope растёт от того же top-left угла.
- **OQ-4.** Что если selection содержит shape, у которого предок-envelope **не** в selection? Пример: юзер выделил один service внутри shape-container, но не сам контейнер. **Предлагаю:** обработать как single-shape (нет layout to do), вернуть `{ok: true, count: 0, hint: "select container or 2+ shapes"}`. Альтернатива — auto-expand до родителя; сложнее и менее предсказуемо.
- **OQ-5.** Mermaid edge labels — сохраняются ли после layout? Сейчас при ELK pass arrow recreate'ятся с new path; label position у нас (memory) — fractional index along arrow. **Предлагаю:** на DRW-149 scope — label позиция остаётся как есть (fractional index не трогаем). Если label виден неправильно — отдельная задача.
- **OQ-6.** Undo-стратегия (α server-hint+wrap или β client-driven apply) — финальный выбор на plan stage после 30-минутного probe текущего WS-sync pipeline (`apps/frontend/src/transport/ws.ts`) и tldraw 5.x history API. Предложение в spec — β (client-driven), но окончательное — после probe.

## Risks

- **R-1.** ELK на маленьких графах (1-3 nodes) даёт странные результаты или throws — mitigation: pre-check size перед invocation, тривиальный layout (1 node = на месте; 2 nodes = горизонтально/вертикально по direction).
- **R-2.** Resize envelope через PatchOp не подхватится корректно на frontend — mitigation: тесты на WS-sync round-trip; уже работает для существующих PatchOps на envelope через `applyStoreChanges`.
- **R-3.** Existing tests (805+ backend) могут поломаться при removal `< 2 noop` — mitigation: пересматривать каждый тест в Phase 2, либо адаптировать к новому контракту, либо удалять obsolete.
- **R-4.** N passes на больших схемах могут быть медленными — mitigation: на наших размерах (5-10 envelopes, 20-50 nodes) ELK работает за <50ms на pass; total <500ms — acceptable. Optimisation (ELK compound single-pass) — отдельный optimization ticket после ship'а DRW-149, если на реальных схемах увидим bottleneck.
- **R-5.** Bug в hierarchy expansion может пропустить envelope или не зарегистрировать parent — mitigation: focused unit tests + integration test на реальной dev default комнате (структурно правильное representation).

## Acceptance criteria

- **AC-1.** Cmd+Shift+L на schema-frame: все его дети (включая nested shape-container'ы) layout'нуты bottom-up; schema-frame resized под их bbox + padding.
- **AC-2.** Cmd+Shift+L на детях schema-frame (без самого frame) — same visual result что для AC-1.
- **AC-3.** Cmd+Shift+L на schema-frame + external: 2 passes выполнены; ни один ребёнок schema-frame не оказался вне его границ; external peers и schema-frame укладываются как peers в общем layout.
- **AC-4.** Single shape selected → `{ok: true, count: 0}`, no error, no visual change.
- **AC-5.** Empty selection → `{ok: true, count: 0, hint: ...}`, no error.
- **AC-6.** Nested shape-container'ы (≥2 уровня вложенности) — bottom-up recursion работает корректно.
- **AC-7.** External arrow от child внутри schema-frame к external shape — НЕ тянет child наружу в inner pass.
- **AC-8.** Pinned shapes (`meta.pinned: true`) — не двигаются в любом pass.
- **AC-9.** Все existing backend tests проходят (с обновлением тех, что зависят от `< 2 noop` контракта).
- **AC-10.** Новые tests покрывают: hierarchy expansion (5+ cases), bottom-up order, PatchOp-based envelope resize, route integration (frame-only, frame+external, nested).
- **AC-11.** Manual E2E на user'овой default комнате — Cmd+Shift+L даёт визуально читаемый layout (subgraph'ы выровнены, services внутри aligned, schema-frame обнимает всю схему).
- **AC-12.** **Undo:** после Cmd+Shift+L (любой из случаев AC-1..AC-3) — `Cmd+Z` одной операцией возвращает все позиции, размеры envelope'ов и состояние в pre-layout snapshot; `Cmd+Shift+Z` восстанавливает post-layout. Тест: snapshot → autolayout → undo → сравнить с snapshot (должны совпадать).

## Implementation order (для plan)

1. **Task 1 (Phase 1).** Probe — снять `< 2 noop` локально + integration тесты на existing runLayoutSubgraph через все 6 cases + probe WS-sync/history API. Output: `2026-05-24-drw-149-probe-findings.md` + чёткий список gap'ов и undo-подход.
2. **Task 2 (Phase 2).** Удалить `< 2 noop` в frontend и backend + обновить existing тесты.
3. **Task 3..K (Phase 3).** Точечные gap fixes (количество и содержание определяет Task 1). Каждый gap → отдельный subagent.
4. **Task K+1 (Phase 4).** Integration tests на route covering все AC cases.
5. **Task K+2 (Phase 5a).** Undo support — implementation выбранного подхода.
6. **Task K+3 (Phase 5b).** Undo tests (snapshot/diff round-trip).
7. **Task K+4 (Phase 6).** Manual test plan markdown + dogfooding на user'овой dev default комнате (после её cleanup от дубликатов).
8. **Task K+5 (Phase 7).** CHANGELOG entry, release commit `0.25.0`, merge feature branch `--no-ff` в main.

Каждый task — в отдельном subagent через `superpowers:subagent-driven-development` skill. Review policy: phase-end (после Phase 3 и после Phase 7), не per-task.

## Связано

- `feature-gitflow-strict` memory — branch обязательна; финальный `--no-ff` merge.
- `feedback-plan-approval-gate` — после spec approval → writing-plans skill для implementation plan.
- `feedback-subagent-coordinator` — Opus координатор, Sonnet impl, Opus review.
- `feedback-batched-reviews` — phase-end review.
- `feedback-tldraw-docs` — перед написанием tldraw кода читать docs/references/tldraw-cheatsheet.md.
- DRW-134 spec (`docs/superpowers/specs/2026-05-23-drw-134-canvas-ai-protocol-design.md`) — v2 protocol foundation.
