# di.draw — Дизайн системы "AI-driven canvas board for Claude Code"

- **Дата:** 2026-05-14
- **Автор:** brainstorm-сессия (Claude Code + Денис Третьяков)
- **Статус:** Draft v3, ожидает финального ревью пользователя
- **Цель документа:** зафиксировать архитектурное решение прототипа, по которому далее будет составлен implementation plan.

## История ревизий

- **v1** — D2 как SSOT, d2oracle для bidirectional edit.
- **v2** — Mermaid как SSOT, LLM-делегированный roundtrip через pending-deltas; tldraw watermark принят.
- **v3** — **canvas-state (JSON) как SSOT**, Mermaid — convenience entry-point; push canvas → Claude обязателен для MVP; свободные shapes (sticky/text/free-form) с MVP.
- **v3.1 (текущая)** — точечные правки по ревью: tldraw зафиксирован на 5.x, Edge endpoints поддерживают свободные точки в пространстве, Group обогащён (frame|group, координаты, collapsed), PreToolUse hook через `hookSpecificOutput.additionalContext`, deep-merge для style/meta, autosave-persistence поднят в MVP (Phase 1.6), D2-импорт явно вынесен в Phase 3, добавлен spike `@tldraw/mermaid` headless как Phase 0.1.

## 1. Проблема и цель

При работе с Claude Code пользователь часто оперирует концептами архитектуры (приложение, сервер, терминал, поток сигналов). Сейчас они существуют только в тексте диалога. Идея — добавить **canvas-доску** как продолжение диалога: AI рисует/обновляет схему, пользователь правит её руками, и эти правки реактивно возвращаются в контекст. Цель — co-creation surface, а не "лента памяти".

Ключевые ограничения:

- **Стоимость токенов.** Полный JSON canvas — слишком дорого передавать в каждом prompt'е, нужен компактный формат и дельты.
- **Двунаправленность.** Изменения текут и от AI к canvas, и от canvas к AI, без потери семантики.
- **Свобода форм.** Не привязываемся к flowchart-метафоре: должны быть узлы, стрелки, стикеры, тексты, free-form линии.
- **Минимум boilerplate'а.** Локальный одно-пользовательский прототип, без коллаб-сервера и без облака.

## 2. Принятые решения

| # | Решение | Альтернативы, отвергнутые сейчас | Почему |
|---|---|---|---|
| 1 | **SSOT — canvas-state в виде компактного JSON.** Mermaid — единственный import-format в MVP API; D2 evaluated, не в MVP API (см. §8). | Mermaid SSOT (v2); D2 SSOT (v1); raw tldraw store как SSOT | DSL не панацея, важно минимизировать стоимость передачи. JSON {nodes, edges, groups} с типизированными узлами компактнее, чем mermaid-text+deltas, и поддерживает свободные формы. |
| 2 | Canvas-движок — **tldraw SDK 5.x** (hobby tier, watermark) | Excalidraw, fabric.js, Konva, self-rolled | Зрелый Editor API + `@tldraw/mermaid` (появился в SDK 5.0). Бесплатно для личного использования. |
| 3 | Импорт Mermaid — через `@tldraw/mermaid` как **convenience-tool**, не SSOT | Парсить Mermaid руками; полностью отказаться от Mermaid | Когда AI хочет одной строкой вкинуть начальный граф, Mermaid удобнее, чем 10 patch-операций. `@tldraw/mermaid` парсит и сразу создаёт shapes; после импорта Mermaid забывается. |
| 4 | AI оперирует canvas через **JSON-patch** (`canvas_apply_patch`) | Множество узких tools (add_node, add_edge, ...); set-whole-state каждый раз | Один tool с patch-форматом `{add: [...], update: [...], delete: [...]}` дёшев по токенам, идемпотентен (с client-id'ами операций), легко расширяем под новые типы shapes. Sugar-tools — поверх него. |
| 5 | Канал AI ↔ canvas — **MCP + skill-инъекция + PreToolUse hook + Channels (Phase 2)** | Только MCP; только hooks; только Channels | Multi-channel: MCP для write, skill для bootstrap-инъекции snapshot'а в новой сессии, `PreToolUse` hook для свежести state перед каждым tool-call'ом, Channels для real-time push canvas → Claude. |
| 6 | Backend — **локальный Bun + Hono**, in-memory state | Node/Express, Cloudflare Workers, embedded server | Минимум зависимостей, нативная TS, один CLI-бинарь. |
| 7 | Frontend — **React + tldraw SDK 5.x + `@tldraw/mermaid`**, статически отдаётся бэкендом | Next.js, отдельный dev-server | Не нужен SSR. Один процесс, один порт. |
| 8 | Auto-layout — **elkjs (layered) опционально, по запросу** | Всегда AI считает координаты; всегда auto-layout | AI обычно знает где расположить новые узлы; но при импорте Mermaid и при `apply_patch({layout: "elk"})` бэкенд считает координаты. Свободные shapes пользователь и AI размещают сами. |
| 9 | Stable ids — **внутренние UUID v4** для каждого node/edge/group | Использовать `mermaid-id` напрямую; client-generated nice-ids | UUID живут вне DSL'а, не страдают при rename, переживают import/export через Mermaid. |
| 10 | Backend port — **8787** (`/api`, `/ws`, `/`) | 7777 (занят у пользователя), 3000 (типовое для dev) | Свободен по умолчанию, легко запомнить, конфигурируется через env `DIDRAW_PORT`. |

## 3. Архитектура

### 3.1 Модель данных (компактный canvas-state)

Один универсальный JSON-документ, который и есть SSOT.

```ts
type CanvasState = {
  version: 1,
  nodes: Node[],
  edges: Edge[],
  groups: Group[],
}

type Node = {
  id: string,        // UUID, стабильный
  kind: "rect" | "ellipse" | "diamond" | "sticky" | "text" | "image" | "freeform",
  label?: string,
  x: number, y: number,
  w?: number, h?: number,
  style?: {                     // частичные поля, дефолты на клиенте
    color?: string,
    fill?: string,
    stroke?: string,
    fontSize?: number,
    rotation?: number,
  },
  meta?: Record<string, unknown>,   // место для AI/user аннотаций
}

type Endpoint =
  | { kind: "node", id: string }                     // прибито к узлу
  | { kind: "point", x: number, y: number }          // свободная точка в пространстве

type Edge = {
  id: string,
  from: Endpoint,
  to: Endpoint,
  label?: string,
  style?: { color?: string, dashed?: boolean, arrow?: "none" | "to" | "both" },
}

type Group = {
  id: string,
  kind: "frame" | "group",         // frame = tldraw frame (отдельный shape с границами); group = логическая группировка
  children: string[],              // ids of nodes / edges / nested groups
  label?: string,
  x?: number, y?: number,          // обязательны для frame, опциональны для group
  w?: number, h?: number,
  style?: { fill?: string, stroke?: string },
  collapsed?: boolean,             // только для group, prune children из compact-render
}
```

Это сразу и хранилище, и сериализационный формат, и формат, который видит AI. Без отдельного "overlay-слоя": положение и стиль живут на самом узле.

### 3.2 Компоненты

1. **canvas-backend** — Bun + Hono, единый локальный процесс на порту `8787`.
   - **State:**
     - `canvas: CanvasState` — единственная in-memory модель.
     - `opLog: PatchOp[]` — последние ≤50 патчей для undo и для push-diff.
     - `version: number` — монотонный счётчик; растёт на каждый принятый patch.
   - **REST API:**
     - `GET /api/state?fmt=full|compact&since=<version>` — snapshot. `compact` опускает дефолтные поля и округляет координаты. `since` — отдаёт только diff от указанной версии (через opLog).
     - `POST /api/patch` — принимает `{ ops: PatchOp[], source: "ai"|"user", clientOpId?: string }`. Применяет, возвращает новый `version`. **Идемпотентность** по `clientOpId` (защита от double-apply).
     - `POST /api/import/mermaid` — `{ source: string, layout?: "elk"|"keep" }`. Парсит через `@tldraw/mermaid`, конвертирует в CanvasState-операции, применяет.
     - `POST /api/layout` — `{ algorithm: "elk-layered" | "dagre", nodeIds?: string[] }`. Пересчитывает координаты для указанных узлов через elkjs, отдаёт diff.
     - `GET /healthz`.
   - **WebSocket `/ws`:**
     - Сообщение `{ kind: "patch", source: "ai"|"user", ops: PatchOp[], version }` — broadcast после каждого применённого patch'а.
     - `{ kind: "hello", version }` при connect.
   - **PatchOp** (одна универсальная структура для add/update/delete):
     ```ts
     type PatchOp =
       | { op: "add", target: "node"|"edge"|"group", value: Node | Edge | Group }
       | { op: "update", target: ..., id: string, set: Partial<...> }
       | { op: "delete", target: ..., id: string }
     ```
   - **Merge-семантика `op: "update"`:**
     - `set.style` и `set.meta` применяются как **deep-merge**: shallow merge на уровне ключей, undefined-значения удаляют ключ. Например, `set: { style: { fill: "#888" } }` обновит `fill`, оставив `stroke` и `fontSize` нетронутыми.
     - Остальные поля (`x`, `y`, `label`, `kind`, `from`, `to`, ...) — **replace**.
     - Это явное расхождение, чтобы AI и frontend могли посылать частичные стилевые правки без знания полного состояния.

2. **tldraw-frontend** — React SPA, отдаётся бэкендом по `/`.
   - При connect: `GET /api/state?fmt=full` → строит tldraw shapes из CanvasState. Каждому shape `meta = { canvasId, kind }`.
   - При `{kind:"patch"}` по WS: применяет diff к tldraw editor.
   - `editor.store.listen({ source: 'user' })`:
     - Любая правка пользователя → конвертируется в `PatchOp[]` → `POST /api/patch` с `source: "user"`. **Семантика и стиль обрабатываются единообразно**: и move, и add — это `update`/`add` патчи; разделять их не нужно, потому что нет отдельного "overlay-слоя".
     - Свободные формы (free-form draw, sticky, текст) — те же `kind:"freeform"|"sticky"|"text"` узлы.
   - При получении patch с `source: "ai"` — применяет к editor, **не** ретранслирует обратно (предотвращение echo-loop через `source`-фильтр).

3. **canvas-mcp** — MCP-сервер, регистрируется в `.claude/mcp.json`.
   - **Tools** — минимальный набор:
     - `canvas_get_state({ fmt?: "full"|"compact", since?: number })` — snapshot или diff.
     - `canvas_apply_patch({ ops: PatchOp[], clientOpId?: string })` — основной write-инструмент. Возвращает `{ ok: true, version } | { ok: false, error }`.
     - `canvas_import_mermaid({ source, layout?: "elk"|"keep" })` — convenience для начального наполнения.
     - `canvas_layout({ algorithm, nodeIds? })` — попросить auto-layout.
     - `canvas_clear()` — обнулить canvas (с подтверждением через `confirm: "yes-i-mean-it"` параметр).
   - **НЕТ** отдельных `add_node`, `add_edge`, `set_mermaid` и т.д. — всё это операции patch'а. AI работает с одним универсальным форматом.

4. **draw skill** — `.claude/skills/draw/SKILL.md`.
   - Frontmatter: `disable-model-invocation: false`, triggers на "нарисуй", "доска", "схема", `/draw`.
   - Тело инжектит:
     ```
     ## Canvas state (compact JSON)
     !`curl -s http://localhost:8787/api/state?fmt=compact`

     ## Cheatsheet (для apply_patch)
     - Координаты в пикселях, центр canvas ≈ (0,0).
     - Размер узла по умолчанию 120×60, sticky 200×120.
     - Связь между узлами — edge со ссылками from/to на их id.
     - Для крупных импортов: canvas_import_mermaid (graph LR/TD/sequence...) или canvas_layout после batch-add.
     ```
   - При первом запуске сессии skill открывает браузер на `http://localhost:8787`.

5. **draw-prehook** — `.claude/hooks/draw-prehook.sh`, регистрируется в `.claude/settings.json` по официальному формату Claude Code hooks ([docs](https://code.claude.com/docs/en/hooks)):
   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "mcp__canvas-mcp__canvas_.*",
           "hooks": [
             {
               "type": "command",
               "command": ".claude/hooks/draw-prehook.sh"
             }
           ]
         }
       ]
     }
   }
   ```
   - Скрипт `draw-prehook.sh` дергает `curl -s "$DIDRAW_URL/api/state?fmt=compact&since=$DRAW_LAST_VERSION"`, затем **печатает в stdout JSON**:
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "PreToolUse",
         "additionalContext": "## Canvas diff since version <N>\n<json>"
       }
     }
     ```
     Claude Code добавит `additionalContext` в контекст модели перед tool-call'ом. Без этой обёртки stdout уходит только в transcript / debug log и модель его не видит.
   - Хранение `DRAW_LAST_VERSION` — в `~/.claude/.draw-state` (обновляется самим скриптом после каждого вызова).
   - Это **Phase 1.5** канал — реактивность без Channels, работает в любой Claude Code.

6. **draw-channel-mcp** *(Phase 2)* — MCP-server по протоколу Channels (Claude Code 2.1.80+).
   - Слушает `/ws` от canvas-backend.
   - Когда приходит patch с `source: "user"` → формирует уведомление в активную Claude-сессию: `User edited canvas: added 'cache' (uuid), connected server→cache`.
   - AI может реагировать без ожидания нового prompt'а от user'а.

### 3.3 Поток данных (золотой путь, обновлённый)

1. Пользователь в Claude Code: *"Нарисуй: приложение → сервер → терминал"*.
2. Skill `draw` срабатывает, инжектит current state (пустой).
3. Claude вызывает `canvas_import_mermaid({ source: "graph LR\n  app --> server --> terminal", layout: "elk" })` — самый короткий путь, AI знает Mermaid.
4. Backend парсит через `@tldraw/mermaid`, запускает elk-layered layout, конвертирует в PatchOp'ы, применяет, broadcast'ит по WS.
5. Frontend рисует три узла + две стрелки.
6. Пользователь руками двигает "server" вверх, красит в красный. Frontend → `POST /api/patch` `[{op:"update", target:"node", id:"<uuid_server>", set:{y:..., style:{fill:"red"}}}]`. Broadcast обратно — других клиентов нет, но `version` инкрементируется.
7. Пользователь руками добавляет на canvas ноду "cache" между server и terminal, рисует две новые стрелки, удаляет старую server→terminal.
8. Frontend конвертирует в `PatchOp[]` (1 add node, 2 add edge, 1 delete edge), шлёт `POST /api/patch`.
9. *(Phase 1.5+)* `PreToolUse` хук на следующем шаге AI подгружает diff с `since=<last_known_version>` — AI видит, что появились новые узлы и связи. *(Phase 2)* — Channels пушит это **сразу**, AI комментирует не дожидаясь user'а.
10. Пользователь: *"Хорошо. Назови этот cache 'edge-cache' и сделай его блёкло-серым."*
11. Claude вызывает `canvas_apply_patch({ ops: [{op:"update", target:"node", id:"<uuid_cache>", set:{label:"edge-cache", style:{fill:"#888"}}}] })`.
12. Бэкенд применяет, WS push, canvas обновляется.

Заметь: **никаких pending-deltas, никаких mermaid-roundtrip'ов, никакого overlay-слоя**. Одна модель, один формат, идём в обе стороны через `apply_patch`.

### 3.4 Обработка ошибок и edge-cases

| Сценарий | Поведение |
|---|---|
| Patch ссылается на несуществующий `id` | Backend → 422 `{ ok: false, error: "edge.from references unknown node <id>" }`. Op-log нетронут. AI пробует снова с актуальным state. |
| Echo-loop (AI получает свой же патч обратно через WS и применяет) | Защита: patch-сообщения по WS имеют `source` и `clientOpId`. Frontend и MCP игнорируют patch'и, инициированные ими же. |
| Одновременный patch user+AI | Last-write-wins на уровне отдельных полей. Op-log из 50 операций → Undo стек. |
| Mermaid-import не парсится | `/api/import/mermaid` → 422 с текстом. AI получает feedback. |
| Свободная shape (free-form draw) от пользователя | Сохраняется как `kind: "freeform"` с массивом точек в `meta.points`. AI видит её, но обычно не модифицирует — может только удалить или прокомментировать. |
| Backend упал | Frontend: баннер "disconnected", экспоненциальный backoff. MCP-tool → ошибка, модель видит. |
| Несколько Claude-сессий на один backend | Phase 1: одна "комната" по умолчанию, обе сессии разделяют state и conflict-resolve через op-log. Phase 3: `room_id` параметр. |
| Сессия Claude Code не Pro/v2.1.80+ | Channels недоступен → Phase 1.5 fallback (`PreToolUse` hook) даёт ~90% эффекта реактивности. |

## 4. Технологический стек

- **Backend:** Bun 1.x, Hono (HTTP/WS), `nanoid` для id (или crypto.randomUUID), elkjs для layout.
- **Mermaid-импорт на стороне backend:** через headless вариант `@tldraw/mermaid` — **либо** в дочернем браузере (puppeteer/playwright), **либо** через CLI `mermaid-cli` (`mmdc`) для smoke-парсинга. Решение — Phase 1.1 по бенчмарку. Запасной вариант — парсить на фронте: бэкенд просто хранит mermaid-source, фронт сам конвертирует и шлёт patch.
- **Frontend:** React 18, **tldraw SDK 5.x** (`@tldraw/mermaid` появился в 5.0; младшие версии не подходят), Vite, TypeScript.
- **MCP:** `@modelcontextprotocol/sdk` (Node), запуск как `npx canvas-mcp`.
- **Channels MCP (Phase 2):** тот же `@modelcontextprotocol/sdk` + Claude Code Channels Protocol (документация Anthropic).
- **Тесты:** vitest для unit/integration, Playwright для UI smoke.
- **Линтер:** biome.

## 5. Структура проекта

```
di.draw/
├── apps/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── state.ts           # CanvasState, opLog, version
│   │   │   ├── patch.ts           # apply PatchOp, validation
│   │   │   ├── mermaid-import.ts  # @tldraw/mermaid → PatchOp[]
│   │   │   ├── layout.ts          # elkjs обёртка
│   │   │   ├── ws.ts              # broadcast
│   │   │   └── routes.ts
│   │   └── tests/
│   └── frontend/
│       ├── src/
│       │   ├── App.tsx
│       │   ├── canvas/
│       │   │   ├── editor.tsx
│       │   │   ├── from-canvas-state.ts   # CanvasState → tldraw shapes
│       │   │   ├── to-patch.ts            # tldraw store-event → PatchOp[]
│       │   │   └── kinds.ts               # node-kinds → tldraw shape types
│       │   └── transport/ws.ts
│       └── tests/
├── packages/
│   ├── canvas-mcp/         # write/read MCP-сервер
│   └── canvas-channel-mcp/ # Phase 2: Channels-протокол
├── .claude/
│   ├── mcp.json
│   ├── hooks/draw-prehook.sh
│   ├── settings.json       # hook registration
│   └── skills/draw/SKILL.md
├── docs/superpowers/specs/
│   └── 2026-05-14-di-draw-design.md
├── biome.json
├── package.json            # Bun workspace
└── README.md
```

## 6. Этапы и трудозатраты

| Phase | Что делаем | Дни | DoD |
|---|---|---|---|
| **0. Bootstrap** | monorepo (Bun workspaces), biome, tsconfig, скелеты apps/packages, port=8787 (env) | 0.5 | `bun run dev` поднимает backend+frontend |
| **0.1 Spike: `@tldraw/mermaid` headless** | прототип-эксперимент: парсится ли пакет на Bun без DOM (через jsdom/playwright/CLI mmdc); если нет — фиксируем перенос конвертации на frontend | 0.5 | Решение и benchmark зафиксированы в `docs/decisions/0001-mermaid-import-location.md` |
| **1.1 Backend MVP** | CanvasState (Node/Edge/Endpoint/Group по §3.1), apply_patch с deep-merge для style/meta, REST, WS, op-log, version, idempotency | 1 | curl POST /api/patch добавляет узел → WS broadcast, GET /api/state?since=N отдаёт diff |
| **1.2 Frontend MVP** | tldraw 5.x, render CanvasState → shapes (включая frame/group), store.listen → POST /api/patch, WS-patch, free-form shapes (sticky/text/draw), свободные стрелки (Endpoint:point) | 2 | Браузер рисует, пользовательские правки сразу летят в backend и обратно; стрелки можно тянуть "в пустоту" |
| **1.3 MCP + Skill** | canvas-mcp (`get_state`/`apply_patch`/`import_mermaid`/`layout`/`clear`), draw skill с инъекцией compact JSON | 1 | В Claude Code "Нарисуй a→b" → на canvas появляются узлы |
| **1.4 Mermaid-import + layout** | `@tldraw/mermaid` → PatchOp[] (по итогам spike — на backend или frontend), elkjs auto-layout, обработка ошибок парсинга | 1 | AI вызывает import_mermaid с `graph LR` или `sequenceDiagram` — canvas корректно отрисовывает |
| **1.5 PreToolUse hook** | hook-script с правильным `hookSpecificOutput.additionalContext` форматом, регистрация в `.claude/settings.json` с вложенным `hooks: [{type:"command",...}]`, persist `DRAW_LAST_VERSION` | 0.5 | Пользователь сдвинул узел — на следующем canvas_* tool-call'е AI видит изменение через `additionalContext` |
| **1.6 Persistence (autosave)** | `canvas.json` в корне проекта; autosave debounce-300ms на каждый принятый patch; load при старте; idempotency после restore | 0.5 | Сделал правку → выключил backend → запустил → canvas на месте |
| **1.7 Polish + tests** | golden-path Playwright, README, demo-gif | 1 | Видеодемо: совместная сессия user + AI создаёт неравномерную схему с произвольными формами |
| **Phase 2: Channels-push** | canvas-channel-mcp, регистрация `--channels plugin:canvas-channel-mcp`, переадресация WS-событий → Claude session ([docs](https://code.claude.com/docs/en/channels)) | +2 | User меняет canvas — Claude получает событие без waiting; AI может комментировать без user-prompt'а |
| **Phase 3: D2-import, SQLite, multi-room** | `POST /api/import/d2`, миграция autosave на SQLite (если нужна история), `room_id` в URL, export Mermaid/SVG | +3 | D2-импорт работает; несколько комнат изолированы; история patch'ей доступна |

**MVP до Phase 1.7: 7.5–8 рабочих дней** (включает spike + autosave persistence + правильный hooks-формат с `additionalContext`).

**Минимальное интересное демо = MVP + Phase 2 = ~10 дней.** Phase 2 обязательна для эффекта "доска живёт".

## 7. Известные риски

1. **`@tldraw/mermaid` headless на backend.** Может не работать без DOM. **Первая задача implementation plan — Phase 0.1 spike**, который ответит на этот вопрос. Запасной план: парсинг и конвертация переезжают на frontend worker, бэкенд хранит только результирующие PatchOp'ы.
2. **Channels — preview-фича Claude Code (2.1.80+).** Может быть нестабильна, требовать конфигурации. Phase 1.5 (PreToolUse hook) уже даёт почти-реактивный режим, поэтому MVP не блокируется.
3. **AI хочет двигать существующие узлы, но не помнит точные координаты.** Скилл инжектит compact JSON с округлёнными координатами; AI может попросить `canvas_layout` для авто-перерасчёта или `canvas_get_state({fmt:"full"})` для точных координат.
4. **Свободные формы (free-form draw) с длинным массивом точек.** Если их много, compact JSON распухает. Митигация: `fmt=compact` опускает `kind:"freeform"` целиком, передавая только `{id, kind, label?: "...freeform sketch..."}` — AI знает что они есть, но не видит детали.
5. **Echo-loop через WS.** Если patch применяется и шлётся обратно — клиент применит снова. Защита через `source` + `clientOpId`-fingerprint; в тестах эту проверку покрываем явно.
6. **Layout-конфликты при ELK + ручные правки.** Если пользователь сдвинул узел, а потом AI запросил `canvas_layout` для всех — координаты пользователя затрутся. Митигация: `canvas_layout` принимает `nodeIds?` — можно лейаутить только новые узлы.
7. **Размер MCP-tool responses.** `canvas_get_state({fmt:"full"})` для большого canvas может быть тяжёлым. Митигация: `fmt:"compact"` по умолчанию + `since` для дельт.

## 8. Что **не** делаем в MVP (зафиксировать)

- Коллаб (несколько пользователей одновременно).
- Multi-room/multi-session — Phase 3.
- Аутентификация, ACL.
- Облачный хостинг.
- Импорт **D2** (только Mermaid в MVP); экспорт обратно в Mermaid/D2/SVG — Phase 3.
- Headless tldraw на сервере — пока не нужен.
- Поддержка всех типов Mermaid — что парсит `@tldraw/mermaid`, то и работает (flowchart точно; sequence/state/mindmap — best-effort).
- Версионирование / undo на уровне UI (op-log есть, но кнопок Undo/Redo пока нет — Phase 1.6 polish если успеваем).

## 9. Открытые вопросы / решённые умолчания

**Зафиксировано как дефолт (можно поменять одним замечанием):**

- **Порт backend = 8787** (env `DIDRAW_PORT` для override).
- **Push canvas → Claude — двухуровневый**: Phase 1.5 (PreToolUse hook, всегда работает) + Phase 2 (Channels, реальный push).
- **Mermaid — convenience-entry, не SSOT.** Используется только когда AI вызывает `canvas_import_mermaid`. Дальше canvas-state ведёт сам себя.
- **Поддерживаемые формы в MVP**: rect, ellipse, diamond, sticky, text, freeform, edges. Без ограничений по типу диаграммы.

**Реально открытое:**

1. **Storage эволюция:** MVP — autosave одного `canvas.json` (Phase 1.6). Phase 3 — миграция на SQLite, если понадобится история, multi-room, или граф вырастет. Триггер миграции пока не выбран — решим по first use.
2. **Spike-результат по `@tldraw/mermaid` headless.** Если на Bun не работает — Phase 1.4 переедет на frontend (parsing + конвертация в worker, бэкенд получает уже готовые PatchOp'ы). Уточняем по итогам Phase 0.1.

---

*Документ зафиксирован 2026-05-14. После одобрения пользователя — переход к составлению implementation plan (skill `superpowers:writing-plans`).*
