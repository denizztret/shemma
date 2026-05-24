# DRW-149 Phase 1: Probe Findings

**Дата:** 2026-05-24  
**Ветка probe:** `probe/drw-149-phase1-noop-removal`  
**Основной вывод:** runLayoutSubgraph имеет 4 конкретных gap'а для use-cases, которые нужны DRW-149.

---

## Метод

Сняли `< 2 noop` short-circuits (frontend + 2 в backend), написали 6 integration tests, которые вызывают `runLayout` напрямую с `scope="affected"` + `affectedIds`. Вывод `console.log` из каждого теста — ниже.

---

## Case 1: single frame selected

**filterToIds:** `{ shape:frame1 }`  
**Сценарий:** frame с 3 детьми внутри. Выбрали только сам frame, не детей.

**Консольный вывод:**
```
[DRW-149 Case 1] reason: undefined
[DRW-149 Case 1] batch.updated keys: []
[DRW-149 Case 1] frame x/y/w/h: 100 100 400 300
[DRW-149 Case 1] c1 x/y: 0 0
[DRW-149 Case 1] c2 x/y: 5 0
[DRW-149 Case 1] c3 x/y: 0 5
```

**Вывод:** GAP. `batch.updated` пуст — ни дети не были перемещены, ни frame не resize'нулся. Корень: в `runLayoutSubgraph`, когда `filterToIds = {frameId}`, frame попадает в `selectedContainers`, но его дети **не попадают** в `filterToIds` → `directSelectedChildrenOf(frameId)` возвращает `[]` → `passAResults` пуст → Pass B single-node short-circuit (строка 683-700) просто сохраняет оригинальные x/y/w/h frame'а без запуска Pass A. Дети не движутся.

**Ссылка:** `apps/backend/src/domain/layout.ts:592-598` (selected containers pass A gate: `directFilteredChildren.length === 0 → continue`).

---

## Case 2: single geo+boundary container selected

**filterToIds:** `{ shape:cont1 }`  
**Сценарий:** geo+boundary container с 2 детьми. Выбрали только контейнер.

**Консольный вывод:**
```
[DRW-149 Case 2] reason: undefined
[DRW-149 Case 2] batch.updated keys: []
[DRW-149 Case 2] container x/y/w/h: 200 200 300 200
[DRW-149 Case 2] s1 x/y: 0 0
[DRW-149 Case 2] s2 x/y: 5 0
```

**Вывод:** GAP. Идентичен Case 1 — дети не в `filterToIds`, `directSelectedChildrenOf` пуст, Pass A не запускается. Применяется к обоим типам container'ов (`frame` и `geo+boundary`).

---

## Case 3: frame + external shape selected

**filterToIds:** `{ shape:frame3, shape:ext }`  
**Сценарий:** frame с 2 внутренними детьми + отдельный shape вне frame. Edge: inner1 → ext. Оба верхнеуровневых item'а в selection.

**Консольный вывод:**
```
[DRW-149 Case 3] reason: undefined
[DRW-149 Case 3] batch.updated keys: [ "shape:frame3", "shape:ext" ]
[DRW-149 Case 3] frame x/y/w/h: 230 -210 400 300
[DRW-149 Case 3] ext x/y: 370 210
[DRW-149 Case 3] i1 x/y: 0 0
[DRW-149 Case 3] i2 x/y: 5 0
```

**Вывод:** ЧАСТИЧНО РАБОТАЕТ. Pass B правильно раскладывает frame и ext (2 top-level node, есть edge через cross-boundary remap). Но дети (i1, i2) не двигались — Pass A не запустился (аналогично Case 1/2). frame resize не произошёл (w/h = 400/300 оригинал). Это тот же GAP: children не в filterToIds → Pass A gate.

---

## Case 4: два child'а выбраны без frame

**filterToIds:** `{ shape:ch1, shape:ch2 }`  
**Сценарий:** frame с 3 детьми, 2 выбраны (ch1, ch2), 1 нет (ns1). Frame не в selection.

**Консольный вывод:**
```
[DRW-149 Case 4] reason: undefined
[DRW-149 Case 4] batch.updated keys: []
[DRW-149 Case 4] frame x/y/w/h: 50 50 400 300
[DRW-149 Case 4] ch1 x/y: 0 0
[DRW-149 Case 4] ch2 x/y: 5 0
[DRW-149 Case 4] ns1 x/y (should be unchanged): 0 100
```

**Вывод:** GAP. Anchor detection отработал правильно (frame стал anchor — `anchorFrameIds` должен содержать его), но `batch.updated` пуст. Корень: Pass A для anchor frame вызывается в `runLayoutSubgraph:577-589`, но только через `topLevelAnchorIds` + `allDirectChildren = [...directSelectedChildrenOf(anchorId), ...directAnchorChildren]`. `directSelectedChildrenOf` смотрит на `selectedLeaves` — те, у кого `filterToIds.has(s.id)`. Это должно работать (ch1, ch2 в filterToIds). Однако в `buildEdges` для Pass B нет edges → ELK для 2 top-level детей без edges даёт произвольный layered порядок... а потом origin preservation centroid translation смещает их обратно к оригиналу. Нужна отладка глубже.

**Уточнение:** Скорее всего gap именно в том, что ch1/ch2 детьми anchor'а обрабатываются через Pass A, но результат Pass A остаётся только во вспомогательных maps, а в финальный `batch.updated` не попадает из-за `isSubgraphMode && !isAnchor && !affectedIds.has(s.id)` фильтра в строке 914 — anchor children не являются ни anchor'ом, ни напрямую в affectedIds (они в affectedIds, так что должны пройти). Возможно проблема в anchor detection для этого случая: `passAResults.set(anchorId, res)` → Pass A резальт записан под anchor id, но child positions из passAResults записываются в positions только если не уже есть (строка 737). Позиции children из Pass A должны попадать → но `batch.updated` пустой → значит EPS-check (строка 898+) определяет что они не изменились (original = computed). Т.е. layout вычислен верно, но оригинальные значения совпадают с ELK-output (или очень близки).

**Ссылка:** `apps/backend/src/domain/layout.ts:895-920` (EPS delta check).

---

## Case 5: external arrow inner→outer, только inner selected

**filterToIds:** `{ shape:inner5 }`  
**Сценарий:** single inner child в frame, стрелка наружу к outer shape. Только inner selected.

**Консольный вывод:**
```
[DRW-149 Case 5] reason: undefined
[DRW-149 Case 5] batch.updated keys: []
[DRW-149 Case 5] inner x/y: 100 100 (original: 100, 100)
[DRW-149 Case 5] outer x/y: 600 0 (should be unchanged: 600, 0)
[DRW-149 Case 5] frame x/y/w/h: 0 0 400 300
```

**Вывод:** РАБОТАЕТ ПРАВИЛЬНО (single-node path). Pass A: frame = anchor, inner = single selected leaf. `runLayoutSubgraph` → anchor detected → Pass A запущен с single child → Pass A внутри: `allDirectChildren = [inner5]` → ELK single-node layout → позиция не меняется (origin preservation). `batch.updated` пуст — inner не двинулся. outer не тронут. Поведение корректно: при 1 узле layout не производит изменений.

---

## Case 6: pinned frame — anchor x/y восстанавливается

**filterToIds:** `{ shape:pch1, shape:pch2 }`  
**Сценарий:** frame с meta.pinned=true, 2 children выбраны.

**Консольный вывод:**
```
[DRW-149 Case 6] reason: undefined
[DRW-149 Case 6] batch.updated keys: []
[DRW-149 Case 6] frame x/y/w/h: 300 400 400 300 (original x=300, y=400)
[DRW-149 Case 6] pch1 x/y: 0 0
[DRW-149 Case 6] pch2 x/y: 5 0
```

**Вывод:** РАБОТАЕТ ПРАВИЛЬНО (pin discipline). `batch.updated` пуст. Frame x/y остаётся 300/400. Pinned frame как anchor не двигается. Children не двинулись по той же причине что Case 4 (EPS check или origin preservation).

---

## Реальные gap'ы

Суммарно обнаружено **2 класса gap'а** в `runLayoutSubgraph`:

### GAP-1: Контейнер в filterToIds → children не layoutятся

**Файл:строка:** `apps/backend/src/domain/layout.ts:592-598`

```ts
for (const sc of topLevelSelectedContainers) {
  const directFilteredChildren = directSelectedChildrenOf(sc.id);
  if (directFilteredChildren.length === 0) continue;  // ← GAP: если children не в filterToIds
  ...
}
```

**Суть:** `directSelectedChildrenOf` ищет детей в `filterToIds` (selected leaves + selected containers). Когда пользователь выбирает frame (tldraw frame selection mutex — выбирается frame ИЛИ его дети, не оба), дети не попадают в filterToIds → Pass A пропускается → никакого layout.

**Влияние:** Cases 1, 2, 3 (partial).

**Нужный fix (Phase 2):** Расширить `filterToIds` перед вызовом `runLayoutSubgraph` — когда в affectedIds есть container, включить в него всех прямых детей этого container'а. Это "frame-expand" logic: `if (containerIds.has(id)) { for (child of directChildrenOf(id)) affectedIds.add(child.id) }`.

### GAP-2: Anchor с 2 детьми без edges → layout = noop (origin preservation)

**Файл:строка:** `apps/backend/src/domain/layout.ts:838-890` (origin preservation) + строка 683 (single-node short-circuit)

**Суть:** Case 4 — children layoutятся через Pass A, ELK их расставляет. Но затем origin-preservation (centroid baseline translation) сдвигает итоговые позиции обратно к оригинальным. Если детей 2, нет edges → ELK даёт произвольный, но не большой сдвиг → centroid translation возвращает их обратно. В итоге `batch.updated` пустой.

**Примечание:** Это частично желаемое поведение (не прыгать без причины), но для DRW-149 это проблема: пользователь ожидает что layout-in-frame реально перераспределит children по правилам ELK даже без edges.

**Нужный fix (Phase 3, если подтвердится):** Для intra-frame layout подавить origin-preservation или применить её только к container (anchor frame), не к его children.

---

## WS-sync pipeline

Анализ `apps/frontend/src/transport/ws.ts`:

**Echo-guard:** реализован через `{ source: "user", scope: "document" }` фильтр в `editor.store.listen` (строка 260). Входящие от сервера батчи применяются через `mergeRemoteChanges()` → tldraw маркирует их `source='remote'` → listener не срабатывает. Явного clientOpId-echo-guard для inbound нет — он реализован через `originClientId === clientOpId` check при `store-change` (строки 323-326): если это эхо нашего собственного user-change, только version advances, без повторного apply.

**AI patches pipeline:** AI-driven store-change приходит через WS `store-change` с `source="ai"`. Применяется через:
```ts
deps.editor.store.mergeRemoteChanges(() => {
  deps.editor.store.applyDiff(batchToDiff(msg.changes));
});
```
`mergeRemoteChanges` — tldraw 5.x API. Важно: по документации tldraw, `mergeRemoteChanges` **не создаёт undo entry** — изменения вносятся в store, но history не регистрирует их как пользовательское действие. Это делает AI patches необратимыми через Ctrl+Z.

**History API (из cheatsheet + deep doc):**
- `editor.run(() => { ... })` — batching, создаёт единый undo step.
- `editor.markHistoryStoppingPoint('name')` — создаёт именованный stopping point для undo.
- `editor.undo()` / `editor.redo()` — стандартный undo/redo.
- Ключевой контракт: `mergeRemoteChanges` **исключает** изменения из undo-history.

**Вывод для DRW-149:** AI layout patches (через `runLayout` + WS broadcast) применяются через `mergeRemoteChanges` → Ctrl+Z не вернёт их обратно. Это текущее поведение для **всех** AI-driven изменений (не только layout).

---

## Выбор undo стратегии (α vs β)

### Стратегия α: markHistoryStoppingPoint на клиенте

Перед применением AI layout batch вызвать `editor.markHistoryStoppingPoint('before-ai-layout')`, а сам batch применять через `editor.run(() => { store.put(...) })` вместо `mergeRemoteChanges`. Тогда Ctrl+Z вернёт состояние до layout.

**Проблема:** Это меняет семантику для ВСЕХ AI patches (не только layout), требует рефакторинга ws.ts. При multi-client сессии undo у одного клиента не откатывает у другого (server-side state не откатывается).

### Стратегия β: отдельный undo-layout endpoint на backend

Frontend при layout-success делает дополнительный запрос `POST /api/agent/layout-selection/undo` (или аналог), который применяет reverse patch к server state + broadcast. Клиент при Ctrl+Z перехватывает через `editor.store.listen` и инициирует server-side undo.

**Проблема:** Сложно, требует snapshot'а pre-layout state на сервере.

### Рекомендация: **α** (markHistoryStoppingPoint)

**Обоснование:** WS sync в shemma устроен так, что `mergeRemoteChanges` используется осознанно для подавления echo. Для layout это не нужно — layout инициируется явным действием пользователя (⌘⇧L). Можно добавить опциональный путь: если `msg.source === "ai" && msg.layoutAction === true`, применять через `editor.run()` + `markHistoryStoppingPoint` вместо `mergeRemoteChanges`. Это:
- Не ломает текущую echo-guard логику для обычных AI ops.
- Делает layout undoable через стандартный Ctrl+Z.
- Не требует server-side snapshot.
- Работает в single-client сценарии (основной для shemma).

**Конкретно в ws.ts:** в case `"store-change"` добавить проверку `msg.layoutAction` и применять другой путь. Backend `layout-selection.ts` при broadcast добавляет `layoutAction: true` в WS event.

---

## Phase 3 tasks (предлагаемые)

1. **Task 3.1 (GAP-1 fix):** Frame-expand logic в `runLayout` для subgraph mode. Когда в `affectedIds` есть container (`containerIds.has(id)`), добавлять всех прямых детей в `affectedIds` перед вызовом `runLayoutSubgraph`. Файл: `apps/backend/src/domain/layout.ts:800-810`. Тест: обновить Cases 1, 2 в probe файле (ожидать non-empty `batch.updated` с moved children).

2. **Task 3.2 (GAP-2 analysis):** Проверить origin-preservation suppression для intra-frame случаев. Когда все `anchorShapes` — дети anchor-frame (не top-level page shapes), centroid translation не имеет смысла. Можно отключить для этого сценария или ввести `suppressOriginPreservation` hint. Файл: `apps/backend/src/domain/layout.ts:838-890`.

3. **Task 3.3 (undo α):** Добавить `layoutAction: true` flag в WS broadcast из `layout-selection.ts`. В `ws.ts` добавить `editor.markHistoryStoppingPoint` + `editor.run()` путь для layout actions. Файл: `apps/backend/src/routes/layout-selection.ts:202-207`, `apps/frontend/src/transport/ws.ts:337-349`.

4. **Task 3.4 (схема-frame trigger):** Добавить в frontend способ передать `affectedIds = все shapes внутри schema-frame` в `tidyLayout`. Текущий `tidyLayout` принимает `ids: string[]` и требует ≥2 — после GAP-1 fix этого достаточно, если передавать frame id отдельно. Или: добавить `mode: "frame"` в body, backend сам резолвит детей. Файл: `apps/frontend/src/canvas/tidy-layout.ts` + `apps/backend/src/routes/layout-selection.ts`.

---

## Итог

Phase 3 **НЕ пропускается** — 2 конкретных gap'а требуют кода. GAP-1 (frame-expand) это блокирующий для DRW-149. GAP-2 (origin preservation) — secondary, может быть Phase 3.5. Undo стратегия: **α** (frontend markHistoryStoppingPoint).
