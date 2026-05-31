# Autolayout Rebuild — Stage 1: Mermaid Import Productization — Design

**Date:** 2026-05-29
**Branch:** `feature/autolayout-rebuild`
**Lineage:** Sub-project A (engine comparison, shipped on branch @ `5feb3fd`, DRW-151 closed) → **Stage 1 (this spec)** → Stage 2 «B» (re-layout любой нарисованной схемы, отдельная спека позже).
**Status:** draft v2 (после adversarial-ревью wnmbuqgbe — verdict revise, блокеры закрыты), awaiting user review.

---

## 1. Контекст и цель

В куске A мы визуально подтвердили на доске: mermaid-native **dagre/elk** (через `@tldraw/mermaid` `createMermaidDiagram`) воспроизводят эталон почти 1:1, а наш backend-ELK (Pass A/B) — разгромно хуже. Решение зафиксировано в `docs/references/2026-05-29-engine-comparison-findings.md`.

Но «красивые» dagre/elk-импорты приходят **болванками**: native `geo` + arc-стрелки, без `schema-container` для subgraph'ов, без стилей, без устойчивой v2-identity. Наш v2-конвейер (backend `POST /api/schema/create`) умеет строить **наши объекты** (schema-container, elbow-стрелки, identity, bindings), но прибит к плохому ELK.

**Цель Stage 1 — поженить валидированную dagre/elk-расстановку с нашим v2-объектным конвейером:** при импорте mermaid создавать НАШИ объекты на координатах от dagre/elk, с угловыми (elbow) стрелками, стилями, размещением во фрейме (и schema-container для subgraph'ов).

**Цель НЕ покрывает** re-layout произвольной нарисованной схемы (Cmd-Shift-L), умную маршрутизацию стрелок с объездом/учётом подписей, создание не-mermaid схем, не-flowchart mermaid — это Stage 2 «B» (см. §6).

---

## 2. Решения, зафиксированные до спеки

Следствие двух grounding-проходов + двух пробников + adversarial-ревью (всё по коду + tldraw-docs). Уверенность high если не указано иное.

### 2.1 Материализация = backend position-injection (не frontend post-process)

Backend остаётся единственным v2-builder'ом (Domain-SSOT, DRY). Frontend post-process отвергнут: он потребовал бы продублировать `mermaid-parser` на фронт и выводил бы `didrawId` из plaintext-лейбла (round-trip рвётся при `id='api'`, label `'API Gateway'`).

- `makeChildShape` уже принимает `overlay.position` *(`apps/backend/src/routes/schema.ts:462-523`, чтение `opts.overlay?.position?.x ?? 0`)*.
- Парсер строит **локальную** `idMap: mermaidId→NodeId` *(`apps/backend/src/domain/schema/mermaid-parser.ts:200`)*, но **сейчас НЕ возвращает её** в `ParseResult` *(return на `:361` отдаёт `{actions, direction, nodeStyles, nodeStylesByNodeId, subgraphStyles}`)*. → **новое: экспортировать `idMap` в `ParseResult`** (см. §4.2). Также есть `nodeStylesByNodeId` *(`:56`)*.
- Трансляция id → tldraw `shape.id` распределена по **трём** картам в handler'е (см. §4.2, блокер-3):
  - leaf-узлы → `nodeIdToShapeId` *(`schema.ts:762-776`)*;
  - subgraph-контейнеры → `groupActionToShapeId` (action.name = subgraph NodeId) *(`schema.ts:731-735`)*;
  - стрелки → random `arrowShapeId()` *(`schema.ts:788`)*, обратной карты нет → **стрелки не адресуются и в `positionsOverride` не входят**.

### 2.2 Источник позиций = A (mermaid-native, harvest-via-hook)

Фронтенд снимает `{mermaidNodeId → {x,y,w,h}}` из той же `createMermaidDiagram`-раскладки, что валидирована в A.

- `createMermaidDiagram` строит типизированный **blueprint** `MermaidBlueprintNode { id, x, y, w, h, kind, parentId, ... }` ДО создания tldraw-shape'ов, где `id` = **литеральный mermaid node-id** *(`@tldraw/mermaid/src/blueprint.ts:71-90`; `createMermaidDiagram.ts:110-111`)*. Subgraph-узлы имеют `kind='subgraph'` и несут `w/h` кластера *(`flowchartDiagram.ts:101-102,108-109`)*.
- Снимаем через **публичный хук** `options.blueprintRender.mapNodeToRenderSpec`, вызываемый по узлу с полным blueprint-узлом *(`renderBlueprint.ts:36/96`; прокидывается `createMermaidDiagram.ts:43/160`)*. No-op-маппер, возвращающий `undefined`, сохраняет дефолтный рендер.
- **Координаты blueprint'а плоские (layout-global).** Два уровня offset, оба обязательны (блокер-4):
  1. **Page-offset (верхний уровень):** `renderBlueprint` добавляет общий `offsetX/offsetY` *(`renderBlueprint.ts:38-49`)*. Для нас безразличен — относительная раскладка сохраняется; единый offset применяем при размещении во фрейме.
  2. **Parent-relative (внутри subgraph):** дети контейнера в tldraw хранят **parent-relative** координаты; `renderBlueprint` сам конвертит `child.x − parent.x` *(`renderBlueprint.ts:91-94`)*, а harvest-хук получает **сырой плоский** узел. Поскольку backend парентит детей в `schema-container` *(`schema.ts:770`)*, а `absoluteBounds` прибавляет `parent.x/y` *(`anchors.ts:104-114`)*, записывать плоскую child-координату НЕЛЬЗЯ — будет double-offset + неверный port-snap. → **для узлов с blueprint `parentId` писать `childRelX = node.x − subgraphNode.x`, `childRelY = node.y − subgraphNode.y`.**

**Headless-elkjs на backend (вариант C) для Stage 1 отвергнут** — невалидированное качество (повтор ставки на проигравший движок), нет числового baseline. C-подобный headless нужен только для Stage 2 «B».

### 2.3 tldraw-elbow реален, но с ограничениями (spec-риски)

Все 4 допущения кода — native tldraw 5.0.0, подтверждено type-defs + bundled source + docs (`props.kind`, `props.elbowMidPoint`, `binding.props.normalizedAnchor + isPrecise`). Ограничения, которые спека обязана учитывать:

1. **`elbowMidPoint` — НЕ глобальный абсолютный рычаг.** per-axis и **orientation-relative**: внутри `swapOrder ? 1 − elbowMidPoint : elbowMidPoint` *(`getElbowArrowInfo.tsx:217`)*. Одно число → зеркальный сдвиг при разном назначении сторон start/end. **Это required-fix для `computeElbowMidpoints`, см. §4.4/R2** (подтверждено: `midpoints.ts:110-128` не компенсирует swapOrder).
2. **Форму L/S/Z/U задать нельзя напрямую** — она производная от сторон-портов (`normalizedAnchor`) + геометрии. Влияем косвенно (выбор стороны в `computeAnchors` + midpoint) и валидируем результат.
3. **Тихий straight-fallback:** если elbow-route не строится — tldraw молча рисует диагональ *(`getArrowInfo.ts:28`)*. Для импорта риск низкий (раскладка mermaid не overlap'ит), мониторим на чекпойнте 1b.
4. **Port-lock — только после `computeAnchors`.** Сырой `compile`-output — `isPrecise:false`, `anchor(0.5,0.5)` *(`compile.ts:93/95`)* → center-bound + auto-route. Сторону форсит `computeAnchors` через `isPrecise=true` *(`anchors.ts:337-338`)*. **Порядок (§4.4) обязателен.**

### 2.4 Дефолты создания стрелок (правка от user)

`arc` по умолчанию — **только при ручном создании пользователем**. **Импорт, создание агентом и re-layout → `elbow`.** (v2-арт уже `kind="elbow"`; новое — сужение arc до ручного пути; правится в creation-default `stylesForNextShape`/override, НЕ в legacy `backfillStoreRecords`.)

### 2.5 Терминология: frame vs container (фиксируем модель)

Модель подтверждена user'ом (2026-05-29):
- **Frame** (native tldraw `frame` + `meta.didrawSchemaFrame`) = **разделитель разных схем** на доске (аналогия Miro: схема живёт внутри фрейма; объекты либо россыпью, либо собраны в контейнер). Вкладывать фрейм во фрейм можно, но некорректно. Конечная импортированная схема → внутри frame.
- **schema-container** (наш кастомный shape) = замена простой группировки для организации дочерних объектов; в импорте — mermaid **subgraph'ы** внутри фрейма.
- **Addressing-id** (id любого объекта) — будущая capability (хранение ссылки / передача адреса агенту / **центрирование на объекте, как в Figma**). Вне Stage 1, вынесено в **DRW-193**.

---

## 3. Архитектура и поток данных

```
[Frontend, DOM] паста mermaid (engine=elk|dagre)
   │  harvestMermaidPositions(src): createMermaidDiagram(..., { blueprintRender:{ mapNodeToRenderSpec: harvest } })
   │     → positionsMap: { mermaidId → {x,y,w,h} } (raw flat blueprint coords; subgraph-узлы несут w/h)
   │     → harvest+cleanup в offscreen/temp-page (§4.1): группы+bindings создаются и удаляются, undo живой страницы не трогаем
   │
   ▼  POST /api/schema/create  { source, positionsOverride: Record<string /*mermaidId*/,{x,y,w?,h?}>, ... }
[Backend] parseMermaidFlowchart(source) → { actions, idMap(mermaidId→NodeId), nodeStylesByNodeId, ... }   // idMap НОВОЕ в ParseResult
   │  build v2 objects (REUSE): frame + geo-nodes + schema-container subgraphs + identity + arrow(elbow)+bindings
   │  ── strict order, одна create-транзакция, ELK НЕ запускается ──
   │  (1) write child positions:  mermaidId → NodeId (idMap) → shape.id
   │         · leaf:      nodeIdToShapeId    ; coords = parent-relative если есть blueprint.parentId
   │         · container: groupActionToShapeId; coords = frame-relative
   │  (2) write container w/h:   из harvested subgraph blueprint (w/h обязательны для subgraph-ключей)
   │  (3) write frame w/h:       union-bbox всех инъецированных детей + padding (нет blueprint-узла у frame)
   │  (4) styles:                nodeStylesByNodeId → overlay/props (resolution chain, respect styleOwnedBy)
   │  (5) runAndBroadcastAnchors: computeAnchors (port-lock) → computeElbowMidpoints (lever, swapOrder-fixed)
   ▼  WS broadcast → frame/nodeIds
[Frontend] frame встаёт во viewport (one-shot reposition; НЕ ретриггерит backend-write)
```

---

## 4. Компоненты

### 4.1 Position harvest (frontend)

**Файл:** `apps/frontend/src/canvas/mermaid-import.ts` (рядом с `importMermaidLegacy`, уже зовущим `createMermaidDiagram` через `as any` на `:449`).

- Новая `harvestMermaidPositions(editor, source, opts): Promise<Record<string,{x,y,w,h}>>` — keyed by mermaid id.
- Primary: `createMermaidDiagram(editor, source, { mermaidConfig?, blueprintRender: { mapNodeToRenderSpec: (node) => { positions[node.id] = {x:node.x,y:node.y,w:node.w,h:node.h}; return undefined; } } } as any)`. Хук получает **сырые** координаты — это ОК, parent-relative-конверсию делает backend (§2.2).
- **Cleanup (блокер-7):** harvest как side-effect создаёт не только узлы, но **группы** (`editor.groupShapes`, `renderBlueprint.mjs:84,112`) и **bindings** (`editor.createBindings`, `:202,237,260`). Решение (закрывает §9 open-q #1 ДО кодинга): выполнять harvest на **offscreen/temp-page** (или в одном `editor.run({ history: 'ignore' })` с удалением всех новых записей child-before-parent, включая group/arrow/binding). Цель — никакого мигания native-диаграммы и нулевое загрязнение undo на странице пользователя.
- Хук/`blueprintRender` не в public `.d.ts` → `as any` (норма для файла, см. коммент `:438`).
- Fallback (за флагом, не primary): deep-import `parseFlowchartLayout`/`flowchartToBlueprint` (`dist-esm/flowchartDiagram.mjs`) — blueprint без создания shape'ов, но приватный API вне `exports`-map + требует повторить `mermaid.initialize(MERMAID_CONFIG)` *(`createMermaidDiagram.ts:29-38`)*, иначе позиции разойдутся.

### 4.2 Backend position-injection

**Файлы:** `packages/shemma-domain/src/schema-meta.ts` (тип запроса), `apps/backend/src/domain/schema/mermaid-parser.ts` (экспорт idMap), `apps/backend/src/routes/schema.ts` (handler).

- **Контракт (блокер-2):** `SchemaCreateRequest.positionsOverride?: Record<string /*mermaidId*/, { x: number; y: number; w?: number; h?: number }>` — keyed by **mermaid-id** (НЕ NodeId; NodeId — server crypto-random `generateNodeIdServer→cryptoRng`, `identity.ts:11-12`). w/h **обязательны для subgraph-ключей**, опциональны для leaf.
- **idMap (блокер-2):** добавить `idMap` в `ParseResult` (`mermaid-parser.ts:361`). Handler-цепочка: `mermaidId → NodeId (idMap) → shape.id`.
- **Адресация (блокер-3):**
  - leaf-узел: `nodeIdToShapeId[NodeId]`;
  - subgraph-контейнер: `groupActionToShapeId[NodeId]`;
  - стрелки: **не адресуются, не в `positionsOverride`** (геометрия — производная bindings + computeAnchors/midpoints).
- **Координаты (блокер-4):** узел с blueprint `parentId` → запись `childRel = node − subgraphNode`; top-level узлы/контейнеры → общий frame-offset.
- **Sizing fit-to-content без ELK (блокер-1):** `makeFrameShape` хардкодит 640×480 *(`schema.ts:393-394`)*, `makeSchemaContainerShape` — 300×200 *(`schema.ts:264-265`)*; native frame и `SchemaContainerShapeUtil.getGeometry` *(`SchemaContainerShapeUtil.tsx:71-76`)* НЕ растут под детей. → явный backend-шаг:
  - container `props.w/h` = harvested subgraph blueprint w/h (+ top-pad под заголовок);
  - frame `props.w/h` = union-bbox всех инъецированных детей + padding (зеркалим `maxX/maxY + pad` из `layout.ts:710-711`; у frame нет blueprint-узла → только так).
- **Strict order (блокер-1+4+8), одна create-транзакция:** (1) child positions (parent-relative) → (2) container w/h → (3) frame w/h → (4) styles → (5) `runAndBroadcastAnchors`. `computeAnchors` использует `absoluteBounds` *(`anchors.ts:242`)* → обязан считаться ПОСЛЕ финальных w/h, иначе центры по заглушкам 300×200 → неверный side-snap.
- **ELK НЕ запускается:** вызов `runLayout` *(`schema.ts:847`)* для импорта с `positionsOverride` пропускается. (Bypass-флаг внутри `runLayout` — задел для Stage 2 «B», в Stage 1 не нужен.)
- **Неполная карта (minor):** если у узла нет позиции — НЕ молча откатывать весь импорт на отвергнутый ELK. Логировать unmatched mermaid-ids + видимый warning; решение об откате — явное и репортится (тест: unmatched-path достижим).

### 4.3 Object materialization (reuse, без изменений логики)

`makeFrameShape` *(`schema.ts:375-410`)*, `makeChildShape` *(`:462-523`)*, `makeSchemaContainerShape` *(`:240-285`)*, `makeArrowShapeLocal`+bindings *(`:105-175`)*, identity `generateNodeIdServer`. Теперь с переданными позициями/размерами вместо ELK-вывода.

### 4.4 Стрелки: arc→elbow + рычаг (1b)

Для импорта стрелки уже строятся elbow. Работа 1b:
- **Порядок (§4.2 strict order):** `runAndBroadcastAnchors` *(`apps/backend/src/routes/_anchors.ts:24-71`)* вызывается ПОСЛЕ записи позиций+размеров (не после ELK). Шаги: `computeAnchors` *(`anchors.ts:228-367`, cardinal-snap + `isPrecise=true`)* → `computeElbowMidpoints` *(`midpoints.ts:39-132`)*.
- **R2 — required fix (major-5):** `computeElbowMidpoints` пишет `(idx+1)/(N+1)` без компенсации `swapOrder` → на смешанном веере (хаб с источниками сверху и снизу) ладдер зеркалит → веер визуально пересекается. Починка: определять `swapOrder` per-arrow по порядку сторон source/target и pre-invert записываемый midpoint. **Прокинуть `midpointDistribution`** через `runAndBroadcastAnchors` (сейчас call-site `_anchors.ts:30` зовёт без аргументов) — чтобы импорт мог откатиться на fixed-0.5, если фикс неполный. Falsifiable unit: mixed-orientation веер → post-render offsets монотонны, не зеркалят.
- Рычаг = `elbowMidPoint` (= «одна точка рычага»). `bend` инертен при elbow — не трогаем.
- **Edge-labels — known limitation (major-6):** `MermaidDiagramOptions` даёт только node-хук, edge-хука нет → ширину/геометрию лейблов не снять. Лейблы кладутся на стрелки backend-парсером как plain `richText` @ 0.5 *(`schema.ts:790-793`)*, БЕЗ маршрутизации под них. Вдобавок skip-ELK роняет существующее грубое label-spacing (`computeLabelDerivedSpacing` живёт в пропускаемом `runLayout`, `layout.ts:184`). → Stage-1 несёт лейблы только как текст; overlap лейблов на 1b — **known limitation**, маршрутизация под подписи — в B.
- **Connector-points (completeness-9):** Stage-1 вычисляет точки детерминированно (cardinal-snap, дефолт-центр) и перезаписывает `normalizedAnchor` с `isPrecise=true`. Тезис «settable anywhere / preserve существующих точек» — **в Stage-2 B** (там свободный `normalizedAnchor` + сохранение user-точек).

### 4.5 Стили + локализация + дефолты (1c)

- **Стили mermaid-узлов** `nodeStylesByNodeId` *(`mermaid-parser.ts:56`)* → overlay/props через resolution chain. **Приоритет (nit):** explicit child (`nodeStylesByNodeId`) > container sticky > board defaults > native. Уважать `meta.styleOwnedBy==='user'` *(`schema.ts:1110-1117`)*. Применимость dash/font/size — по матрице.
- **«sizes/fonts влияют на placement» (nit):** удовлетворено транзитивно — mermaid-движок учитывает размеры при раскладке (FONT_INFLATE=1.4, *Spacing=80), мы берём blueprint w/h. Закрывает §9 open-q #3 в пользу применения blueprint w/h.
- **Локализация:** frame — внешняя граница, subgraph → `schema-container` (§2.5). Одноуровневая модель; вложенность container-в-container — НЕ в scope (§6, DRW-156).
- **Дефолты создания (§2.4):** arc только для ручного создания; elbow для импорта/агента/re-layout.

---

## 5. Инкрементальная нарезка (визуальный контроль на каждом шаге)

Per memory `feedback-iterative-canvas-verification` — каждый под-этап завершается **живой проверкой на доске контроллером** (chrome-MCP), не доверяя subagent-скриншотам (`feedback-no-subagent-screenshot-trust`).

- **Task 0 — Spike (де-рискинг, до кода):** см. §8. Подтвердить harvest-via-hook + cleanup на sample-2; заодно проверить, что 4 subgraph'а sample-2 **не вложены** (иначе nested — не minor, см. §8).
- **1a — позиции + sizing + объекты:** harvest → `positionsOverride` (mermaid-id) → backend строит НАШИ объекты, пишет parent-relative позиции + fit-to-content размеры. ✅ *чек: schema-container subgraph'ы + geo-узлы + identity стоят 1:1 с эталоном; контейнеры обрамляют своих детей; frame обрамляет всё; ничего не клипается.*
- **1b — elbow + рычаг:** anchors/midpoints после sizing, swapOrder-fixed. ✅ *чек: стрелки угловые, port-locked, веера консистентны (не зеркалят); добавить кейс с labeled fan-in — overlap лейблов всплывает рано (known limitation).*
- **1c — стили + локализация + дефолты:** стили mermaid применены по приоритету, схема локализована, ручная стрелка=arc / импорт=elbow. ✅ *чек: стилизовано, локализовано, дефолты верны.*

---

## 6. Вне scope / отложено

- **Stage 2 «B»** — re-layout любой нарисованной/не-mermaid схемы (Cmd-Shift-L), headless layered-движок по нарисованному графу + умная elbow-маршрутизация («дорогой C») + **маршрутизация под edge-подписи** + **свободные/сохраняемые connector-points** + **создание не-mermaid схемы (ручное/агентом) → внутри frame (рекомендация)** (layout этой схемы решается движком B). Модель адресации/локализации (frame/container/center-on-object) — **DRW-193**.
- **Вложенность container-в-container** (DRW-156) — Stage 1 одноуровневый.
- **Детектор silent straight-fallback** — для импорта риск низкий (мониторим визуально); полноценный guard — кандидат в B.
- **Не-flowchart mermaid** (sequence/state/mindmap) — Stage 1 только flowchart.

---

## 7. Стратегия тестирования

- **Backend (bun test):** контракт `positionsOverride` keyed by mermaid-id → bounds на правильных shape.id (через idMap+nodeIdToShapeId+groupActionToShapeId); `idMap` в `ParseResult`; parent-relative — `absoluteBounds(child)` == harvested плоская координата; sizing — `frame.props.w/h ≥ union детей`, container w/h == harvested subgraph dims; `growY` обнулён; стили по приоритету с уважением `styleOwnedBy`; arrows elbow + bindings; anchors/midpoints вызваны ПОСЛЕ sizing; unmatched-id path репортится (не молчит).
- **Domain (bun test):** swapOrder-корректность `computeElbowMidpoints` (R2) — mixed-orientation веер.
- **Frontend (bun test):** `harvestMermaidPositions` — pure-часть (blueprint-node → запись), convention `panels.test.ts` (DOM-инфры нет).
- **Live E2E (контроллер, chrome-MCP):** чекпойнты §5; живой WS-subscriber tab (`feedback-ws-subscriber-via-chrome-mcp`). PRE-tag E2E обязателен (`feedback-probe-vs-production-validation`).

---

## 8. Риски и де-рискинг

| # | Риск | Сев. | Митигирование |
|---|---|---|---|
| **R1** | id↔shape.id mis-keying (3 карты: leaf/container/arrow) → узлы в (0,0) | HIGH | Перевод только в handler; контейнеры через `groupActionToShapeId`, стрелки исключены; backend contract-тест; live-чек 1a. |
| **R2** | `elbowMidPoint` orientation-relative (swapOrder) → зеркальные рычаги | HIGH | Required-fix `computeElbowMidpoints` + plumb `midpointDistribution`; unit на mixed-orientation; live-чек 1b. |
| **R3** | Sizing вне ELK не выполняется → клип/нахлёст | HIGH | Backend fit-to-content (container w/h из blueprint, frame w/h из union+pad); тест на размеры; live-чек 1a. |
| **R4** | Double-offset координат (flat vs parent-relative) → сдвиг + неверный port-snap | HIGH | `childRel = node − subgraphNode` для детей subgraph; backend-тест absoluteBounds. |
| **R5** | Throwaway-shapes (узлы+группы+bindings) засоряют undo/мигают | MED | offscreen/temp-page или `editor.run({history:'ignore'})` + child-before-parent cleanup; чек 1a. |
| **R6** | Edge-label routing/spacing теряется на импорте | MED | Known limitation (§4.4); visual-кейс labeled fan-in; маршрутизация → B. |
| **R7** | Тихий straight-fallback elbow | LOW | Низкий для импорта; мониторим 1b; guard → B. |
| **R8** | Nested subgraphs в фикстуре ломают одноуровневую модель | LOW→? | Подтвердить на spike, что sample-2 не вложен; иначе reject/flatten с явным сообщением. |
| **R9** | Deep-import fallback ломается на minor-bump | LOW | Primary = публичный хук; deep-import за флагом. |

**Spike (Task 0, до основного кода):** в room `a-engine-compare` (Vite dev, живой WS tab) импортнуть `apps/backend/tests/fixtures/sample-2-mermaid.md` через текущий путь, передав no-op `mapNodeToRenderSpec`, пишущий `node.id → {x,y,w,h}` в `window.__harvest`. Проверить: (a) собрано 18 узлов + 4 subgraph-id (с w/h), ключи = mermaid id; (b) **subgraph'ы не вложены** (R8); (c) cleanup убирает все throwaway-записи (узлы+группы+bindings), доска чиста, undo не загрязнён; (d) доска визуально идентична валидированному elk-результату. Подтверждает источник позиций без единой строки backend-кода.

---

## 9. Открытые вопросы

1. **Primary harvest vs deep-import для production.** Spike валидирует хук + cleanup. Если cleanup на offscreen/temp-page хрупок — переключиться на deep-import (без throwaway, ценой приватного API). Решаем по результату spike. *(open-q «throwaway на живой странице» — закрыт в §4.1 в пользу offscreen/temp ДО кодинга.)*
2. **Где живёт apply-positions:** inline в `POST /api/schema/create` (одна атомарная транзакция импорта) — предпочтительно.
3. ~~**w/h из blueprint**~~ — **закрыто:** применяем blueprint w/h (нужно для sizing контейнеров, §4.2/§4.5).
4. **User-confirm: внешний локализатор — frame или schema-container?** Stage 1 по умолчанию frame-as-outer (§2.5, существующая арх-ра). Подтвердить или зафиксировать смену.

---

## 10. Verified references (file:line)

- Backend handler/seam: `apps/backend/src/routes/schema.ts:105-175,240-285,264-265,375-410,393-394,462-523,731-735,762-776,788,847,1110-1117`
- Layout (sizing-логика, что НЕ зовём): `apps/backend/src/domain/layout.ts:184,700-712,710-711,1623-1625`; `runLayout:1387`
- Arrows: `compile.ts:58,69-70,93,95`; `anchors.ts:104-114,228-367,242,337-338`; `midpoints.ts:39-132,110-128`; `_anchors.ts:24-71,30`; `getElbowArrowInfo.tsx:217`; `getArrowInfo.ts:28`
- Parser: `apps/backend/src/domain/schema/mermaid-parser.ts:56,117-362,200,361`
- Identity: `identity.ts:11-12` (`generateNodeIdServer→cryptoRng`)
- Domain types: `packages/shemma-domain/src/schema-meta.ts:7-14`; `style-defaults.ts`; `layout-modes.ts`
- Frontend: `apps/frontend/src/canvas/mermaid-import.ts:438,449`; A-helpers `computeImportOriginX`/`repositionCustomFrameWhenReady`
- Custom shape: `apps/frontend/src/shapes/schema-container/SchemaContainerShapeUtil.tsx:71-76,99-100`
- `@tldraw/mermaid` (node_modules): `blueprint.ts:71-90,23-32`; `createMermaidDiagram.ts:29-38,43,110-111,160`; `renderBlueprint.ts:36,38-49,58,86,91-96`; `renderBlueprint.mjs:48,84,112,202,237,260`; `flowchartDiagram.ts:61-64,101-102,108-109,122,134-135`
- tldraw elbow: native 5.0.0 `props.kind`/`elbowMidPoint`/`normalizedAnchor`+`isPrecise`
- Findings A: `docs/references/2026-05-29-engine-comparison-findings.md`
