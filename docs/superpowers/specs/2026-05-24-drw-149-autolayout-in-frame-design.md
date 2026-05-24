# DRW-149 — Autolayout внутри schema-frame с bottom-up иерархией

**Версия:** v0.1
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

### Algorithm (Approach 1) — backend bottom-up ELK passes

#### Шаг 1: resolve селекшна в shape records

Входной параметр — `rawIds: string[]` (приходит из frontend). Backend:

1. Resolve каждый id: если `shape:XXX` — берём прямо из `r.store.store`; если didrawName — лукап через `r.didrawIndex`.
2. Unresolved → собираем в массив для warning'а (404 не возвращаем — продолжаем с резолвенными).
3. **Снимаем `< 2 noop`** — пропускаем дальше любое количество (включая 0 и 1).
4. Если resolved.length === 0 — возвращаем `{ok: true, count: 0}` (no-op без error).
5. Если resolved.length === 1 — возвращаем `{ok: true, count: 0}` (1 шейп тривиально на своём месте).

#### Шаг 2: построение container tree

Функция `expandSelectionToHierarchy(resolvedIds, store) → ContainerTree`:

1. Для каждого id в selection: walk-up parentId chain, собираем все envelope'ы (frame или geo с `meta.role: "boundary"`), которые попали по пути.
2. Также: для каждого envelope в selection (frame/shape-container) — добавляем **всех** его транзитивных детей (envelope'ов и не-envelope) в "scope".
3. Для каждого envelope в scope строим запись `{ id, parentEnvelopeId, depth, children, directChildShapes }`:
   - `parentEnvelopeId` — ближайший envelope-предок (или `null` для top-level).
   - `depth` — расстояние от root (top-level envelope'ы имеют depth=0).
   - `children` — envelope-дети (для recursion).
   - `directChildShapes` — non-envelope direct children (services).
4. Top-level peers: shapes из selection, у которых нет envelope-предков в scope.
5. Возвращаем `{ envelopes: Envelope[], topLevelPeers: ShapeId[] }`.

#### Шаг 3: bottom-up iteration

Sort envelopes by `depth` descending (leaf-containers first). Для каждого envelope:

1. Собираем входы для ELK:
   - **Nodes:** `envelope.directChildShapes` (services) + `envelope.children` envelopes-как-блоки (с их **текущим** bbox; они уже layout'нуты на предыдущем уровне).
   - **Edges:** все bindings из store, у которых **и** source **и** target ∈ nodes. Фильтруем cross-boundary edges (G5).
2. Detect ELK direction:
   - В DRW-149 scope — top-level mermaidSource direction через существующий `detectMermaidMode` (см. layout-selection.ts:30-55).
   - Per-envelope direction (mermaid `direction LR` внутри subgraph) — DRW-152, не в текущем scope. На уровне DRW-149 используем единое direction для всех passes.
3. Run ELK pass. Получаем new positions для nodes.
4. Emit PatchOps: для каждого node — обновить `x`, `y` (если node — envelope-блок, его дети **уже** на правильных relative positions внутри блока; нужно дополнительно сдвинуть всех его транзитивных детей на `delta = newPos - oldPos`).
5. Compute new bbox envelope'а: `min/max` по `x, y, x+w, y+h` всех nodes + padding (`PADDING = 16`).
6. Emit PatchOp: envelope.{x, y, w, h} = new bbox (с adjustment для smooth positioning — envelope сдвигается так, чтобы children remained at их absolute positions).

После завершения всех envelope passes — переходим к top-level pass.

#### Шаг 4: top-level pass

1. Nodes: `topLevelPeers` (external shapes) + root-envelopes (schema-frame и любые top-level shape-container'ы) как блоки с их текущим bbox.
2. Edges: bindings между этими nodes (filtered).
3. Если nodes.length === 0 — skip (всё уже сделано в envelope passes).
4. Если nodes.length === 1 — skip (тривиально).
5. Run ELK pass. Emit PatchOps как в шаге 3.

#### Шаг 5: возврат batch

Собрать все PatchOps в `batch.updated[id]`. Backend применяет `applyStoreChanges`, обновляет version, публикует в bus → frontend получает через WS.

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
| `apps/backend/src/routes/layout-selection.ts:84-91, 132-140` | Удалить оба `< 2 noop` branch. Передавать любое количество affected ids в `runLayout`. |
| `apps/backend/src/domain/layout.ts` | Новая функция `expandSelectionToHierarchy(rawIds, store) → ContainerTree`. Модификация `runLayout` для bottom-up iteration. Новая helper `resizeEnvelopeViaPatch(envelope, newBbox, batch)`. |
| `apps/backend/src/domain/layout.ts` (внутри `runLayout`) | Bottom-up loop по envelopes (sorted by depth desc), затем top-level pass. |
| Tests: `apps/backend/tests/domain/layout.test.ts` | Новые unit-тесты на `expandSelectionToHierarchy`, на bottom-up порядок, на resize-via-PatchOp. |
| Tests: `apps/backend/tests/routes-layout-selection.test.ts` | Обновить existing тесты (removal of `< 2 noop` ожидаемого поведения). Новые тесты на frame-selection, frame+external, nested containers. |
| Tests: `apps/frontend/src/canvas/tidy-layout.test.ts` | Removal `< 2 noop` тестов, добавление тестов на single-id передачу. |
| `apps/frontend/src/transport/ws.ts` (для undo G7) | По выбранному undo-подходу (α или β) — либо WS-handler hook для `undoLabel: "autolayout"` patch wrapping, либо apply через `editor.updateShapes(...)` с echo-guard. |

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

- `expandSelectionToHierarchy`:
  - Single non-envelope shape → tree с topLevelPeers=[shape], envelopes=[].
  - Single envelope → tree с envelopes=[that envelope] + все его транзитивные дети в scope.
  - Mixed selection (envelope + external) → правильное разделение.
  - Nested envelopes (schema-frame > shape-container > services) → корректный depth.
  - Cycle protection (искусственный — defensive test).
- Bottom-up iteration order: depth=2 envelopes обрабатываются раньше depth=1, раньше depth=0.
- `resizeEnvelopeViaPatch`: PatchOp содержит только `x/y/w/h`, не `props.w/h` (geo-specific) и не `props.h/w` (frame-specific) — проверить что мы правильно адресуем поля для обоих типов.

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

**Phase 1 — Backend core (1 task).**
- `expandSelectionToHierarchy` + tests.
- Refactor `runLayout` для bottom-up loop.
- `resizeEnvelopeViaPatch` helper.

**Phase 2 — Frontend и backend short-circuit removal (1 task).**
- Удалить `< 2 noop` в обоих местах + обновить existing тесты.
- Передавать любое количество ids.

**Phase 3 — External arrow filtering (1 task).**
- Логика фильтрации cross-boundary edges в inner pass.
- Unit tests.

**Phase 4 — Integration tests + manual E2E (1 task).**
- Integration тесты на route.
- Manual E2E на default комнате (после user cleanup).
- Manual test plan markdown.

**Phase 5 — Release (1 task).**
- `bun run test` — all packages green.
- CHANGELOG entry.
- Release commit + tag `0.25.0` (MINOR — new behavior, не breaking).
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

1. **Task 1.** Backend `expandSelectionToHierarchy` + unit tests.
2. **Task 2.** Backend `resizeEnvelopeViaPatch` helper + unit tests.
3. **Task 3.** Backend refactor `runLayout` для bottom-up loop. Update existing tests.
4. **Task 4.** External arrow filtering в inner pass + tests.
5. **Task 5.** Frontend + backend remove `< 2 noop` + update tests.
6. **Task 6.** Integration tests на route (frame-only, frame+external, nested).
7. **Task 7.** Manual E2E test plan + dogfooding на user'овой default комнате.
8. **Task 8.** CHANGELOG entry, release commit `0.25.0`, merge `--no-ff` в main.

Каждый task — в отдельном subagent через `superpowers:subagent-driven-development` skill. Review policy: phase-end (после Task 4 и после Task 8), не per-task.

## Связано

- `feature-gitflow-strict` memory — branch обязательна; финальный `--no-ff` merge.
- `feedback-plan-approval-gate` — после spec approval → writing-plans skill для implementation plan.
- `feedback-subagent-coordinator` — Opus координатор, Sonnet impl, Opus review.
- `feedback-batched-reviews` — phase-end review.
- `feedback-tldraw-docs` — перед написанием tldraw кода читать docs/references/tldraw-cheatsheet.md.
- DRW-134 spec (`docs/superpowers/specs/2026-05-23-drw-134-canvas-ai-protocol-design.md`) — v2 protocol foundation.
