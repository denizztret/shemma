# di.draw — Дизайн системы "AI-driven canvas board for Claude Code"

- **Дата:** 2026-05-14
- **Автор:** brainstorm-сессия (Claude Code + Денис Третьяков)
- **Статус:** Draft, ожидает ревью пользователя
- **Цель документа:** зафиксировать архитектурное решение прототипа, по которому далее будет составлен implementation plan.

## 1. Проблема и цель

При работе с Claude Code пользователь часто оперирует концептами архитектуры (приложение, сервер, терминал, поток сигналов). Сейчас они существуют только в тексте диалога. Идея — добавить **canvas-доску** как продолжение диалога: AI рисует/обновляет схему, пользователь правит её руками, и эти правки возвращаются в контекст следующего шага.

Ключевые ограничения:

- **Стоимость токенов.** Полный JSON canvas (фигуры + координаты + стили) — слишком дорого передавать в каждом prompt'е.
- **Двунаправленность.** Изменения должны течь и от AI к canvas, и от canvas к AI, без потери семантики.
- **Минимум boilerplate'а.** Стартовать как одно-пользовательский локальный прототип, без коллаб-сервера и без облака.

## 2. Принятые решения

| # | Решение | Альтернативы, отвергнутые сейчас | Почему |
|---|---|---|---|
| 1 | DSL источника истины — **Mermaid** | D2, Graphviz/DOT, чистый JSON-shapes | tldraw SDK имеет официальный пакет **`@tldraw/mermaid`**: Mermaid-код → нативные shapes (flowchart, sequence, state, mindmap). Это снимает 30–40% работы по рендерингу. Mermaid также — самый "знакомый" AI формат. Обратное преобразование (canvas → Mermaid) делегируется LLM через delta-журнал (решение №3). |
| 2 | Canvas-движок — **tldraw SDK** (hobby tier, watermark) | Excalidraw, fabric.js, Konva, self-rolled | Зрелый Editor API + готовый `@tldraw/mermaid`. Личное использование, watermark "made with tldraw" принят сознательно — лицензионных рисков нет. |
| 3 | Roundtrip canvas → Mermaid — **через LLM-делегирование**, не код | Свой Mermaid-roundtrip-парсер; d2oracle для D2 | У Mermaid нет roundtrip-API с сохранением форматирования. Вместо своей реализации — пользовательские правки на canvas пишутся в **журнал pending-deltas** (`add-node`, `add-edge`, `delete-edge`, ...). На следующий шаг диалога skill инжектит `mermaid_source + pending_deltas`, AI сама перегенерирует Mermaid и вызывает `canvas_set_mermaid` — дельты консумируются. |
| 4 | Трёхслойная модель: **семантика (Mermaid) ⟂ стиль (overlay JSON) ⟂ pending deltas (user-side draft)** | Хранить позицию/цвет внутри Mermaid; править Mermaid сразу с canvas | Разделение трёх слоёв даёт компактный AI-контекст, стабильный стилевой оверлей и явный visual-индикатор "не закоммичено" для пользовательских правок до AI-rewrite'а. |
| 5 | Канал AI↔canvas — **MCP-сервер + skill-инъекция** | Только slash-команды; только hooks; Channels с самого начала | MCP покрывает write-сценарии Claude → canvas; skill с `!`curl`` подтягивает свежий snapshot перед каждым шагом. Channels (push canvas → Claude) откладываются на Phase 2. |
| 6 | Backend — **локальный Bun + Hono**, in-memory state | Node/Express, Cloudflare Workers, embedded server | Минимум зависимостей, быстрый старт, нативная TS/JSX, легко завернуть в один CLI-бинарь. |
| 7 | Frontend — **React + tldraw SDK + `@tldraw/mermaid`**, статически отдаётся бэкендом | Next.js, отдельный dev-server | Не нужен SSR. Один процесс, один порт. |
| 8 | Stable id — **внутренний UUID, маппинг на mermaid-id** | Использовать mermaid-id напрямую | Mermaid id-шники могут меняться (например, AI переименовал `A` → `app`). Mapping uuid ↔ mermaid-id обновляется при каждом `set_mermaid`, overlay-ключи привязаны к UUID. |

## 3. Архитектура

### 3.1 Компоненты

1. **canvas-backend** — единый локальный процесс на Bun.
   - Хранит:
     - `mermaidSource: string` — текущий Mermaid-код (семантический SSOT).
     - `overlay: Record<UUID, OverlayProps>` — стили/смещения per-node поверх Mermaid-layout, ключ — внутренний UUID.
     - `idMap: Record<UUID, MermaidNodeId>` — стабильный internal-UUID → mermaid-id (обновляется при каждом `set_mermaid`).
     - `pendingUserDeltas: UserDelta[]` — журнал пользовательских семантических правок (`add-node`, `add-edge`, `delete-node`, `delete-edge`, `rename-label`) с момента последнего `set_mermaid`. Консумируется при `set_mermaid`.
     - `opLog: Op[]` — последние ≤20 операций для undo.
   - REST API:
     - `GET /api/state?fmt=full|compact` — snapshot. `compact` = `{ mermaidSource, pendingUserDeltas, nodeIds[] }` для skill-инъекции (~300–700 токенов).
     - `PUT /api/mermaid/source` — полностью переписывает Mermaid-source. Backend парсит через `@tldraw/mermaid`, очищает `pendingUserDeltas`, обновляет `idMap` и broadcast'ит.
     - `POST /api/deltas/append` — добавляет в `pendingUserDeltas` запись от пользователя (с canvas). Не трогает `mermaidSource`.
     - `POST /api/overlay/:uuid` — записывает overlay props.
     - `DELETE /api/deltas` — ручной reset журнала (если пользователь "передумал").
     - `GET /healthz`.
   - WebSocket `/ws` — broadcast `{ kind, payload }`:
     - `kind: "mermaid-changed"` → новый source + render-plan от `@tldraw/mermaid` (`DiagramMermaidBlueprint` или эквивалент).
     - `kind: "overlay-changed"` → patch конкретного shape.
     - `kind: "deltas-changed"` → текущий журнал (для синхронизации других tabs/инстансов).
     - `kind: "id-remap"` → `{ uuid, oldMermaidId, newMermaidId }` после `set_mermaid`.

2. **tldraw-frontend** — React SPA, отдаётся бэкендом по `/`.
   - При connect: получает full snapshot, через `createMermaidDiagram` из `@tldraw/mermaid` рендерит Mermaid → shapes. Каждому shape присваивает `meta = { uuid, mermaidId, source: 'mermaid' }`. Поверх — overlay.
   - При `mermaid-changed`: пересборка из render-plan. Старые UUID, чьи mermaid-id остались, сохраняют свой overlay; новые узлы получают новые UUID.
   - При `deltas-changed` от других клиентов: рисует pending-дельты как **draft-shapes** (полупрозрачные, с маркером "не закоммичено") поверх render-plan.
   - `editor.store.listen({ source: 'user', scope: 'document' })`:
     - move/recolor существующего Mermaid-shape → `POST /api/overlay/:uuid` (стиль).
     - добавление новой ноды/стрелки/удаление → `POST /api/deltas/append` (семантика, идёт в pending journal — НЕ в Mermaid сразу).
     - редактирование label существующего Mermaid-shape → `POST /api/deltas/append { kind: "rename-label", uuid, newLabel }`.
     - ad-hoc free-form (sticky-note, рисунок от руки) — Phase 3, пока не поддерживаем.

3. **canvas-mcp** — MCP-сервер, регистрируется в `~/.claude.json` или per-project `.claude/mcp.json`.
   - Tools (все детерминированно отображают на canvas-backend REST):
     - `canvas_get_state({ fmt? })` → snapshot (`full` или `compact`). `compact` всегда включает `pendingUserDeltas`.
     - `canvas_get_mermaid()` → текущий Mermaid-source.
     - `canvas_set_mermaid({ source })` → полностью переписать source. Это основной write-инструмент для AI. Backend парсит через `@tldraw/mermaid`, при успехе **консумирует `pendingUserDeltas`** (журнал очищается, потому что AI уже учёл их при перегенерации). Возвращает `{ ok: true, nodeIds: [...] } | { ok: false, error: "mermaid parse failed: ..." }`.
     - `canvas_move_node({ uuid, x, y, color? })` — пишет в overlay, **не** трогает Mermaid. Используется для тонких визуальных подсказок.
     - `canvas_clear_deltas()` — очистить pending-журнал, не трогая Mermaid (если AI решает игнорировать пользовательские дельты).
   - Все tools синхронные, идемпотентность не требуется (op-log на бэкенде).

4. **draw skill** — `.claude/skills/draw/SKILL.md`.
   - Frontmatter: `disable-model-invocation: false`, triggers на "нарисуй", "обнови схему", "доска", `/draw`.
   - Тело инжектит компактный snapshot:
     ```
     Current canvas (Mermaid):
     !`curl -s http://localhost:7777/api/state?fmt=compact | jq -r .mermaidSource`

     Pending user deltas (необработанные правки с canvas; учти их при следующем canvas_set_mermaid, журнал будет очищен после успешной записи):
     !`curl -s http://localhost:7777/api/state?fmt=compact | jq -c .pendingUserDeltas`
     ```
   - При первом запуске сессии skill также автоматически открывает браузер на `http://localhost:7777`.

### 3.2 Граница и интерфейс между слоями

- AI **видит**: `mermaidSource` + `pendingUserDeltas`. Это весь компактный контекст. Overlay не инжектится — токен-бюджет важнее точных позиций.
- AI **может запросить**: `canvas_get_state({ fmt: "full" })` — включит overlay и render-plan, если нужно знать координаты.
- Frontend — единственный, кто решает, **семантика** vs **стиль**:
  - Изменение `x`, `y`, `props.color`, `props.size` существующего Mermaid-shape → overlay (мгновенно, в Mermaid не идёт).
  - Создание новой shape, удаление, изменение label, добавление стрелки → `pendingUserDeltas` (в Mermaid НЕ идёт мгновенно; ждёт следующего `set_mermaid` от AI).
- AI решает, как именно учитывать дельты — мерджит их в новый Mermaid (стандартный путь) или явно отбрасывает через `canvas_clear_deltas` ("я не хочу это добавлять").
- Если AI забыла учесть дельты, они остаются в журнале до следующего шага. Журнал показывается пользователю в UI как индикатор "не закоммичено".

### 3.3 Поток данных (золотой путь)

1. Пользователь в Claude Code: "Нарисуй: приложение → сервер → терминал".
2. Skill `draw` срабатывает, инжектит snapshot → `mermaidSource = ""`, `pendingUserDeltas = []`.
3. Claude генерирует tool-call `canvas_set_mermaid({ source: "graph LR\n  app --> server --> terminal" })`.
4. Backend парсит через `@tldraw/mermaid`, обновляет `idMap`, очищает (и так пустой) журнал, WS push → frontend рендерит три узла + две стрелки.
5. Пользователь руками двигает "server" вверх, перекрашивает в красный.
6. Frontend ловит `store.listen` → `POST /api/overlay/{uuid_of_server}` с `{ x, y, color }`. Mermaid не трогается.
7. Пользователь **вручную на canvas** добавляет ноду "cache" между server и terminal: новый shape + новые стрелки + удаление старого ребра server→terminal.
8. Frontend интерпретирует это как набор семантических операций → шлёт `POST /api/deltas/append` четырежды: `add-node cache`, `add-edge server→cache`, `add-edge cache→terminal`, `delete-edge server→terminal`. На canvas эти 4 элемента отображаются как **draft-shapes** (полупрозрачные).
9. Пользователь: "Хорошо, оформи эту версию".
10. Skill инжектит `mermaidSource + pendingUserDeltas`. Claude видит обе части → генерирует новый Mermaid с cache → `canvas_set_mermaid({ source: "graph LR\n  app --> server --> cache --> terminal" })`.
11. Backend парсит, обновляет idMap, **консумирует pending-журнал** (очищается), WS push `mermaid-changed` + `id-remap` (если что-то переименовалось).
12. Frontend пересобирает shapes из render-plan. UUID server остался → его overlay (позиция и красный цвет) применяется поверх нового layout. Cache становится "официальной" нодой (без draft-индикатора).

### 3.4 Обработка ошибок и edge-cases

| Сценарий | Поведение |
|---|---|
| Mermaid не парсится `@tldraw/mermaid` | Backend → 422 с текстом ошибки. MCP-tool отдаёт `{ ok: false, error: "..." }`. Claude получает feedback и пробует снова. `pendingUserDeltas` **не консумируется** при ошибке. |
| Одновременная правка user + AI | Last-write-wins по mermaidSource; pendingUserDeltas — append-only. Op-log из 20 операций позволяет Undo. |
| AI забыла учесть pending-дельты | Журнал не очищается без успешного `set_mermaid`. На следующем шаге снова инжектится — AI получает повторный шанс. Пользователь видит draft-shapes и может сам нажать "Discard pending". |
| AI явно отбрасывает дельты | `canvas_clear_deltas` — журнал очищается, draft-shapes исчезают, но user может увидеть "AI ignored your edits" в UI-лог. |
| Mermaid id поменялся при rewrite (`A` → `app`) | Backend ищет соответствие по label (или по позиции в графе) → отправляет `id-remap { uuid, oldMermaidId, newMermaidId }`. Overlay-ключи привязаны к UUID, не страдают. |
| Не нашёл соответствие — нода исчезла | Overlay помечается orphan. GC через 1 час, если не возвращается. |
| Backend упал | Frontend: баннер "disconnected", экспоненциальный backoff. Claude-tool возвращает ошибку — модель видит. |
| Несколько Claude-сессий на один порт | Phase 1 — не поддерживается. Phase 2 — multiplex по `room_id`. |

## 4. Технологический стек

- **Backend:** Bun 1.x, Hono (HTTP), `ws` (WebSocket). Парсинг и render-plan Mermaid на бэкенде **либо** через `@tldraw/mermaid` в browser-friendly режиме (если работает без DOM — проверить в Phase 1.1), **либо** перенести этот шаг полностью на фронтенд (фронтенд парсит mermaid от backend'а), **либо** использовать вспомогательный браузерный worker (Bun не имеет DOM). Дефолт — рендерить на клиенте, на бэкенде только валидация (попытка парсинга).
- **Frontend:** React 18, tldraw SDK (актуальная стабильная, 4.x), `@tldraw/mermaid`, Vite (или встроенный Bun bundler), TypeScript.
- **MCP:** `@modelcontextprotocol/sdk` (Node), запуск как `npx canvas-mcp`.
- **Тесты:** vitest для unit/integration, Playwright для UI smoke.
- **Линтер:** biome (заменяет eslint+prettier).

## 5. Структура проекта

```
di.draw/
├── apps/
│   ├── backend/          # Bun + Hono + ws (без рендеринга mermaid)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── state.ts          # mermaidSource + overlay + idMap + pendingDeltas
│   │   │   ├── mermaid-validate.ts  # smoke-parse через @tldraw/mermaid (либо CLI mmdc)
│   │   │   ├── id-remap.ts       # сопоставление uuid ↔ mermaid-id при set_mermaid
│   │   │   ├── ws.ts             # broadcast
│   │   │   └── routes.ts
│   │   └── tests/
│   └── frontend/         # React + tldraw + @tldraw/mermaid
│       ├── src/
│       │   ├── App.tsx
│       │   ├── canvas/
│       │   │   ├── editor.tsx
│       │   │   ├── from-mermaid.ts   # @tldraw/mermaid → tldraw shapes
│       │   │   ├── user-deltas.ts    # tldraw event → POST /api/deltas/append
│       │   │   ├── draft-overlay.ts  # рендер pending-deltas как draft-shapes
│       │   │   └── overlay.ts        # позиция/цвет поверх mermaid layout
│       │   └── transport/ws.ts
│       └── tests/
├── packages/
│   └── canvas-mcp/       # MCP-сервер, обёртка над backend REST
│       ├── src/index.ts
│       └── README.md
├── .claude/
│   ├── mcp.json          # регистрация canvas-mcp
│   └── skills/draw/
│       └── SKILL.md
├── docs/
│   └── superpowers/specs/
│       └── 2026-05-14-di-draw-design.md   # этот файл
├── biome.json
├── package.json          # workspace
└── README.md
```

## 6. Этапы и трудозатраты

| Phase | Что делаем | Дни (1 dev) | DoD |
|---|---|---|---|
| **0. Bootstrap** | monorepo, biome, tsconfig, скелеты apps/packages | 0.5 | `bun run dev` поднимает оба процесса |
| **1.1 Backend MVP** | state (`mermaidSource` + `overlay` + `pendingDeltas` + `idMap`), REST, WS, mermaid smoke-validate | 1 | `curl PUT /api/mermaid/source -d '{source:"graph LR\n a-->b"}'` → WS push, `curl GET /api/state` отдаёт корректный snapshot |
| **1.2 Frontend MVP** | tldraw, `@tldraw/mermaid` → shapes, store.listen → overlay | 1.5 | Браузер рисует Mermaid, drag сохраняет overlay, переподключение работает |
| **1.3 MCP + Skill** | canvas-mcp tools, draw skill с инъекцией mermaid+deltas, регистрация в Claude Code | 1 | В Claude Code "Нарисуй a→b" → на canvas появляются узлы |
| **1.4 User-deltas + roundtrip** | tldraw add-node → `pendingDeltas`, draft-shapes, AI учитывает deltas при следующем set_mermaid, консумация после успеха | 1 | Полный цикл §3.3 (1–12) проходит без потерь |
| **1.5 Polish + tests** | golden-path Playwright, README, demo-gif | 0.5–1 | Видеодемо |
| **Phase 2:** Channels-push canvas → Claude | local channels-MCP + WS-listener | +2 | User двинул shape — Claude видит без skill-инъекции |
| **Phase 3:** Persist + git, ad-hoc free-form | Mermaid + overlay + deltas в файлы, ad-hoc shapes (sticky notes) поверх | +2 | Файлы коммитятся, free-form-объекты живут вне Mermaid |

**MVP (Phase 0 + 1.1–1.5): 5 рабочих дней одного разработчика** (1 день экономии на отсутствии собственного render-plan-конвертера — `@tldraw/mermaid` уже делает это).

## 7. Известные риски

1. **AI-managed roundtrip не детерминирован.** Если AI неправильно учтёт `pendingUserDeltas`, журнал останется в буфере и пользователь будет видеть draft-shapes до следующего шага. Митигация: явный UI-индикатор "не закоммичено" + ручной "Discard pending" + `canvas_clear_deltas` от AI.
2. **`@tldraw/mermaid` — новый пакет SDK 5.** Возможны баги, неполное покрытие подвидов диаграмм (mind map, sequence). Митигация: MVP ограничивается flowchart (`graph LR/TD`), остальное — Phase 3.
3. **Потеря overlay при удалении-возврате узла под тем же label.** Если узел уходит из Mermaid и возвращается через несколько шагов, его UUID будет новым, overlay не восстановится. Документировать как known limitation MVP.
4. **Push canvas → Claude недоступен в MVP** — реактивность только через инъекцию при следующем prompt'е. Принимается осознанно (Phase 2).
5. **Mermaid ограничен по выразительности.** Сложные диаграммы (C4, custom shapes-with-icons) — за пределами MVP. При необходимости — гибрид с ad-hoc free-form объектами (Phase 3) или альтернативный DSL.
6. **id-remap эвристики могут ошибаться.** Если AI переименует ноду И сместит её в графе одновременно, авто-сопоставление по label/контексту может промахнуться. Митигация: при неудаче — overlay помечается orphan и пересоздаётся.

## 8. Что **не** делаем в MVP (зафиксировать)

- Коллаб (несколько пользователей одновременно).
- Поддержка нескольких комнат / нескольких Claude-сессий.
- Аутентификация, ACL.
- Облачный хостинг.
- Поддержка sequence/state/mindmap диаграмм Mermaid — MVP только flowchart (`graph LR/TD`). Остальное — Phase 3 (когда стабилизируется `@tldraw/mermaid`).
- Ad-hoc free-form рисунки (sticky-notes, заметки) — Phase 3.
- Push canvas → Claude — Phase 2.
- Headless tldraw на сервере — пока не нужен (всё в браузере).

## 9. Открытые вопросы (для пользователя)

1. **Порт backend** — предлагается 7777 (как у madstudio, чтобы держать единую "сетку" локальных сервисов). Подтверждение?
2. **Phase 2 (push)** — обязательно ли его включить в "минимально интересное демо", или MVP с lazy-read достаточно для первого впечатления?
3. **Mode коммита `pendingUserDeltas`**: (a) только AI решает, когда консумировать (через `set_mermaid`); (b) добавить ручную кнопку "Commit to Mermaid" в UI, которая шлёт AI запрос "перепиши mermaid с учётом deltas". Текущая спека — (a), но (b) может быть UX-улучшением.
4. **Поддерживаемые типы Mermaid в MVP** — ограничиваемся `graph LR/TD` flowchart (как зафиксировано в §8), или сразу пробуем sequence/state?

**Закрытые ранее уточнениями пользователя:**
- DSL = Mermaid (tldraw имеет официальный `@tldraw/mermaid`).
- Лицензия tldraw — hobby/watermark, личное использование, не риск.

---

*Документ зафиксирован 2026-05-14. После одобрения пользователя — переход к составлению implementation plan (skill `superpowers:writing-plans`).*
