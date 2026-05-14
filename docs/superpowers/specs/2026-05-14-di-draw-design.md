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
| 1 | DSL источника истины — **D2** (terrastruct/d2) | Mermaid, Graphviz/DOT, чистый JSON-shapes | У D2 есть `d2oracle` — публичное API для bidirectional edit с сохранением форматирования. У Mermaid roundtrip-парсера нет; правка через AST-регенерацию убьёт комментарии. См. research-выводы. |
| 2 | Canvas-движок — **tldraw SDK** | Excalidraw, fabric.js, Konva, self-rolled | Зрелый Editor API (CRUD, bindings, `meta`, `store.listen`), хорошие примеры. Принят риск проприетарной лицензии для прототипа; для prod нужен отдельный шаг. |
| 3 | Двухслойная модель: **семантика (D2) ⟂ стиль (overlay JSON)** | Хранить позицию/цвет внутри D2 как inline-стили | Развязка слоёв даёт стабильный AI-контекст (только D2-код) и независимое пользовательское оформление поверх. |
| 4 | Канал AI↔canvas — **MCP-сервер + skill-инъекция** | Только slash-команды; только hooks; Channels с самого начала | MCP покрывает write-сценарии Claude → canvas; skill с `!`curl`` подтягивает свежий snapshot перед каждым шагом. Channels (push canvas → Claude) откладываются на Phase 2. |
| 5 | Backend — **локальный Bun + Hono**, in-memory state | Node/Express, Cloudflare Workers, embedded server | Минимум зависимостей, быстрый старт, нативная TS/JSX, легко завернуть в один CLI-бинарь. |
| 6 | Frontend — **React + tldraw SDK**, статически отдаётся бэкендом | Next.js, отдельный dev-server | Не нужен SSR. Один процесс, один порт. |
| 7 | Stable id — **внутренний UUID, маппинг на d2-id** | Использовать d2-id напрямую | D2 ids меняются при rename. d2oracle отдаёт rename-события, маппер обновляет таблицу. |

## 3. Архитектура

### 3.1 Компоненты

1. **canvas-backend** — единый локальный процесс на Bun.
   - Хранит:
     - `d2Source: string` — текущий D2-код (семантический SSOT).
     - `overlay: Record<NodeId, OverlayProps>` — стили/смещения per-node поверх D2-layout.
     - `idMap: Record<UUID, D2NodeId>` — стабильный internal-id → d2-id.
     - `opLog: Op[]` — последние ≤20 операций для undo.
   - REST API:
     - `GET /api/state?fmt=full|compact` — отдаёт snapshot. `compact` = `{ d2Source, nodeIds[] }` (для skill-инъекции, ~200–500 токенов).
     - `PUT /api/d2/source` — полностью переписывает D2-source (используется на старте сессии или при regeneration "с нуля"). Backend сам пересчитывает layout.
     - `POST /api/d2/patch` — точечная операция через `d2oracle`: `{ operation: "Create" | "Connect" | "Move" | "Rename" | "Delete" | "Set" | "Edit", args }`. Операции — подмножество d2oracle Edit API.
     - `POST /api/overlay/:nodeId` — записывает overlay props.
     - `GET /healthz`.
   - WebSocket `/ws` — broadcast `{ kind, payload }`:
     - `kind: "d2-changed"` → payload содержит новый source + render-plan (узлы с layout-координатами от d2.compile).
     - `kind: "overlay-changed"` → payload с patch конкретной node.
     - `kind: "id-renamed"` → `{ from, to }` для синхронизации mappings на клиенте.

2. **tldraw-frontend** — React SPA, отдаётся бэкендом по `/`.
   - При connect: получает full snapshot → создаёт shapes с `meta = { internalId, d2NodeId, source: 'd2' }`.
   - При `d2-changed`: пересборка фигур из render-plan, поверх — overlay (позиция/цвет).
   - При `overlay-changed`: обновляет только затронутый shape.
   - `editor.store.listen({ source: 'user', scope: 'document' })`:
     - move/recolor существующего D2-shape → `POST /api/overlay/:nodeId`.
     - создание новой ноды/стрелки → строит d2oracle-операцию (`Create node` / `Connect`) → `POST /api/d2/patch`.
     - удаление D2-shape → `POST /api/d2/patch` с `Delete`.
     - ad-hoc free-form (sticky-note, рисунок от руки) — Phase 3, пока не поддерживаем.

3. **canvas-mcp** — MCP-сервер, регистрируется в `~/.claude.json` или per-project `.claude/mcp.json`.
   - Tools (все детерминированно отображают на canvas-backend REST):
     - `canvas_get_state({ fmt? })` → snapshot (`full` или `compact`).
     - `canvas_get_d2()` → текущий D2-source.
     - `canvas_set_d2({ source })` → полностью переписать (`PUT /api/d2/source`). Используется, когда AI генерирует диаграмму "с нуля" или после крупной реорганизации.
     - `canvas_patch_d2({ operation, args })` → точечная d2oracle-операция (`Create | Connect | Move | Rename | Delete | Set | Edit`). Возвращает `{ ok: true } | { ok: false, error: "compile failed: …" }`.
     - `canvas_add_node({ label, shape? })` — sugar над `canvas_patch_d2({ operation: "Create", … })`.
     - `canvas_add_edge({ from, to, label? })` — sugar над `Connect`.
     - `canvas_move_node({ id, x, y })` — пишет в overlay, **не** трогает D2.
   - Все tools синхронные, идемпотентность не требуется (op-log на бэкенде).

4. **draw skill** — `.claude/skills/draw/SKILL.md`.
   - Frontmatter: `disable-model-invocation: false`, triggers на "нарисуй", "обнови схему", "доска", `/draw`.
   - Тело инжектит:
     ```
     Current canvas (D2):
     !`curl -s http://localhost:7777/api/state?fmt=compact | jq -r .d2Source`
     ```
   - При первом запуске сессии skill также автоматически открывает браузер на `http://localhost:7777`.

### 3.2 Граница и интерфейс между слоями

- AI **не видит overlay** в нормальном инъект-промпте — только D2. Это сознательное решение: токен-бюджет важнее, чем точное знание позиций.
- AI может попросить overlay явно через `canvas_get_state({ fmt: "full" })`, если ему критично знать, где именно лежит узел.
- Frontend — единственный, кто решает, является ли пользовательская правка **семантикой** или **стилем**:
  - Изменение `x`, `y`, `props.color`, `props.size` существующего D2-shape → overlay.
  - Создание новой shape, удаление, изменение текста-label, добавление binding → D2.

### 3.3 Поток данных (золотой путь)

1. Пользователь в Claude Code: "Нарисуй: приложение → сервер → терминал".
2. Skill `draw` срабатывает, инжектит `!`curl …`` → текущий D2-источник пуст.
3. Claude генерирует tool-call `canvas_set_d2({ source: "app -> server -> terminal" })`.
4. Backend применяет, компилирует, WS push → frontend рисует три узла + две стрелки в layout, который дал d2.compile.
5. Пользователь руками двигает "server" вверх, перекрашивает в красный.
6. Frontend `store.listen` ловит change → `POST /api/overlay/server` с `{ x, y, color }`.
7. Пользователь: "Добавь cache между сервером и терминалом".
8. Skill снова инжектит D2-snapshot → Claude вызывает несколько `canvas_patch_d2` (`Create cache`, `Connect server→cache`, `Connect cache→terminal`, `Delete server→terminal` старого ребра) либо единый `canvas_set_d2` с переписанным D2-кодом — на усмотрение модели.
9. Backend пересобирает D2 через d2oracle → новый layout → WS push `d2-changed`.
10. Frontend пересоздаёт фигуры из render-plan, **сохраняет overlay для "server"** (тот же overlay-id, узел остался в D2).

### 3.4 Обработка ошибок и edge-cases

| Сценарий | Поведение |
|---|---|
| D2-код не компилируется | Backend → 422 с текстом ошибки. MCP отдаёт ошибку как tool-result. Claude получает feedback и пробует снова. |
| Одновременная правка user + AI | Last-write-wins. Op-log из 20 операций позволяет user'у нажать Undo. |
| Rename d2-id | d2oracle отдаёт rename-event → backend апдейтит `idMap` и шлёт `id-renamed` всем клиентам. Overlay-ключи мигрируют. |
| Удаление узла, потом возврат под тем же label | Overlay не восстанавливается автоматически (новый internal-id). Документировать как known limitation MVP. |
| Orphan overlays (узел исчез из D2) | GC при каждом compile: всё, чего нет в текущем графе и старше 1 часа, удаляется. |
| Backend упал | Frontend показывает баннер "disconnected", переподключается с экспоненциальным backoff. Claude-tool возвращает ошибку — модель видит. |
| Несколько Claude-сессий на один порт | Phase 1 — не поддерживается. Backend на 7777 один. Phase 2 — multiplex по `room_id`. |

## 4. Технологический стек

- **Backend:** Bun 1.x, Hono (HTTP), `ws` (WebSocket), `d2` (либо `@terrastruct/d2` WASM, либо CLI через child_process — выбираем в Phase 1 по производительности).
- **Frontend:** React 18, tldraw SDK (последняя стабильная), Vite (или встроенный Bun bundler), TypeScript.
- **MCP:** `@modelcontextprotocol/sdk` (Node), запуск как `npx canvas-mcp`.
- **Тесты:** vitest для unit/integration, Playwright для UI smoke.
- **Линтер:** biome (заменяет eslint+prettier).

## 5. Структура проекта

```
di.draw/
├── apps/
│   ├── backend/          # Bun + Hono + d2 + ws
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── state.ts          # in-memory D2 + overlay + idMap
│   │   │   ├── d2-engine.ts      # обёртка над d2oracle + compile
│   │   │   ├── ws.ts             # broadcast
│   │   │   └── routes.ts
│   │   └── tests/
│   └── frontend/         # React + tldraw
│       ├── src/
│       │   ├── App.tsx
│       │   ├── canvas/
│       │   │   ├── editor.tsx
│       │   │   ├── from-d2.ts    # render-plan → shapes
│       │   │   ├── to-d2.ts      # tldraw event → d2 operation
│       │   │   └── overlay.ts
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
| **1.1 Backend MVP** | state, d2-engine, REST, WS | 1.5 | `curl POST /api/d2/patch '{op:"ReplaceAll", d2:"a->b"}'` → WS push с render-plan |
| **1.2 Frontend MVP** | tldraw, render-plan → shapes, store.listen → overlay | 2 | Браузер рисует, drag сохраняет overlay |
| **1.3 MCP + Skill** | canvas-mcp tools, draw skill, регистрация в Claude Code | 1 | В Claude Code "Нарисуй a→b" → на canvas появляются узлы |
| **1.4 Двунаправленный roundtrip** | tldraw add-node → d2oracle Create, persist overlay через rebuild | 1 | Полный цикл (см. §3.3 пп. 1–10) проходит без потерь |
| **1.5 Polish + tests** | golden-path Playwright, README, demo-gif | 0.5–1 | Видеодемо |
| **Phase 2:** Channels-push canvas → Claude | local channels-MCP + WS-listener | +2–3 | User двинул shape — Claude видит без skill-инъекции |
| **Phase 3:** Persist + git | D2 + overlay в файлы, autosave, undo расширяется до сессии | +1–2 | Файлы коммитятся, при перезапуске состояние восстанавливается |

**MVP (Phase 0 + 1.1–1.5): 6–7 рабочих дней одного разработчика.** Демо: AI и пользователь совместно строят простую архитектурную схему, не теряя пользовательских правок при AI-добавлениях.

## 7. Известные риски

1. **Лицензия tldraw для коммерческого использования.** Прототип — ок (trial 100 дней или hobby с watermark). Прод — отдельное решение и закладка бюджета.
2. **D2 как зависимость.** WASM-сборка `@terrastruct/d2` весит ~2 MB; CLI требует бинарь. Выбираем в Phase 1.1 после бенчмарка.
3. **Потеря overlay при удалении-возврате узла.** Принимается как limitation MVP; Phase 3 — попытка восстановить по сходству label.
4. **Push canvas → Claude недоступен в MVP** — реактивность только через инъекцию при следующем prompt'е. Принимается осознанно (Phase 2).
5. **D2 не покрывает все типы диаграмм** (нет sequence-style "из коробки", если идея вырастет в его сторону). При необходимости — расширение DSL или гибридная схема (вариант C из брейнсторма).

## 8. Что **не** делаем в MVP (зафиксировать)

- Коллаб (несколько пользователей одновременно).
- Поддержка нескольких комнат / нескольких Claude-сессий.
- Аутентификация, ACL.
- Облачный хостинг.
- Импорт/экспорт Mermaid (пользователь упоминал — оставляем как Phase 3+ опцию).
- Ad-hoc free-form рисунки (sticky-notes, заметки) — Phase 3.
- Push canvas → Claude — Phase 2.
- Headless tldraw на сервере — пока не нужен (всё в браузере).

## 9. Открытые вопросы (для пользователя)

1. **OK ли заменить Mermaid на D2 как SSOT?** Это рекомендация по research-итогам; Mermaid можно оставить как формат экспорта.
2. **Цель MVP — личный research-тул или потенциальный продукт?** От ответа зависит, насколько срочно решать лицензию tldraw.
3. **Какой порт по умолчанию** для backend? Предложен 7777 (как у madstudio, чтобы держать единую "сетку" локальных сервисов).
4. **Считать ли push canvas → Claude (Phase 2) обязательным для "минимально интересного демо"?** От этого зависит, объединять ли Phase 1 и Phase 2 в один спринт.

---

*Документ зафиксирован 2026-05-14. После одобрения пользователя — переход к составлению implementation plan (skill `superpowers:writing-plans`).*
