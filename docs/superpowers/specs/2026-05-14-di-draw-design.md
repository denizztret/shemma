# di.draw — Дизайн системы "AI-driven canvas board for Claude Code"

- **Дата:** 2026-05-14
- **Автор:** brainstorm-сессия (Claude Code + Денис Третьяков)
- **Статус:** Draft v3.2, одобрено пользователем после ревью
- **Цель документа:** зафиксировать архитектурное решение прототипа, по которому далее будет составлен implementation plan.

## История ревизий

- **v1** — D2 как SSOT, d2oracle для bidirectional edit.
- **v2** — Mermaid как SSOT, LLM-делегированный roundtrip через pending-deltas; tldraw watermark принят.
- **v3** — **canvas-state (JSON) как SSOT**, Mermaid — convenience entry-point; push canvas → Claude обязателен для MVP; свободные shapes (sticky/text/free-form) с MVP.
- **v3.1** — точечные правки по ревью: tldraw 5.x, Edge endpoints (свободные точки), Group обогащён, PreToolUse через `additionalContext`, deep-merge для style/meta, autosave в MVP, D2 в Phase 3, spike `@tldraw/mermaid` headless как Phase 0.1.
- **v3.2** — добавлены **два больших блока**: (1) **multi-room backend + per-session storage** (документ canvas живёт в `~/.claude/projects/<slug>/canvas/<room>.json`; CLI `didraw daemon|open|list|export|rm` для ручного режима; SessionStart hook для автоматического; multi-room с MVP); (2) **targeted prompts** (выделение объекта на canvas → prompt с привязкой → AI получает в контексте через injection/hook/Channels). MVP-оценка: 9.5–10 дней.
- **v3.2.1 (текущая, одобрено)** — финальные правки консистентности: статус → v3.2; §3.2 переписан с `rooms: Map<RoomId, RoomState>` и всеми endpoints через `?room=`; §8 — `Multi-user collaborative editing` (не путать с multi-room, который уже в MVP); §9 — открытый вопрос про storage переформулирован как "когда мигрировать с JSON на SQLite".

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
| 11 | **Multi-room backend с MVP**, документ canvas хранится в `~/.claude/projects/<slug>/canvas/<room>.json`; ключ комнаты = `CLAUDE_SESSION_ID` (auto) или произвольное имя (manual через `didraw open <room>`) | single-canvas; разные процессы backend на сессию; хранение в `<project>/.claude/canvas/` | Документ привязан к сессии Claude Code (живёт в той же папке, что `session.jsonl`), но backend единый. Ручной режим через CLI даёт скетч-комнаты вне сессий. |
| 12 | **Targeted prompts** — user выделяет shapes на canvas и пишет prompt; AI получает его с привязкой к объектам через injection / hook / Channels | Только текстовый диалог в Claude Code; комментарии-on-shape без AI-обработки | Превращает доску в input-channel, не только output. Объект-attached prompt'ы радикально упрощают "что ты имел в виду под этим узлом?". |

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
   - **State:** `rooms: Map<RoomId, RoomState>`, где `RoomState = { canvas: CanvasState, opLog: PatchOp[], prompts: Prompt[], version: number, dirty: boolean, lastTouched: number }`. Подробности lazy-load'а, LRU-выгрузки и привязки `RoomId` к `CLAUDE_SESSION_ID` — см. §3.5. Все нижеперечисленные REST/WS endpoints принимают `?room=<id>` и работают в контексте конкретной комнаты.
   - **REST API:**
     - `GET /api/state?room=<id>&fmt=full|compact&since=<version>` — snapshot комнаты. `compact` опускает дефолтные поля и округляет координаты. `since` — отдаёт только diff от указанной версии (через opLog).
     - `POST /api/patch?room=<id>` — принимает `{ ops: PatchOp[], source: "ai"|"user", clientOpId?: string }`. Применяет, возвращает новый `version`. **Идемпотентность** по `clientOpId` (защита от double-apply).
     - `POST /api/import/mermaid?room=<id>` — `{ source: string, layout?: "elk"|"keep" }`. Парсит через `@tldraw/mermaid`, конвертирует в CanvasState-операции, применяет.
     - `POST /api/layout?room=<id>` — `{ algorithm: "elk-layered" | "dagre", nodeIds?: string[] }`. Пересчитывает координаты для указанных узлов через elkjs, отдаёт diff.
     - Endpoints для targeted prompts (см. §3.6): `POST /api/prompt`, `GET /api/prompts`, `POST /api/prompt/:id/resolve`, `POST /api/prompt/:id/dismiss` — все также с `?room=<id>`.
     - `GET /healthz` — глобальный, без `room`.
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
| Backend поднят, sessionId не определён (нет env) | Используется `default` room. Ручной запуск без сессии работает. |
| Несколько Claude-сессий → несколько комнат | Backend multi-room с MVP: каждая комната = отдельный `CanvasState` + `opLog`, изоляция полная. |

### 3.5 Запуск и хранение документов

**Документ canvas привязан к сессии Claude Code** и живёт в той же папке, что и `session.jsonl`. Backend — единый процесс на порту 8787, но с **multi-room state**: `Map<RoomId, RoomState>`. RoomId = либо `$CLAUDE_SESSION_ID` (автоматический режим), либо имя свободной комнаты (ручной режим).

#### Storage layout

```
~/.claude/projects/<project-slug>/
├── session.jsonl                            # стандартный Claude Code state
└── canvas/                                  # di.draw documents
    ├── <session-id-1>.json                  # canvas одной сессии
    ├── <session-id-2>.json
    └── _manual/                             # свободные комнаты (ручной режим)
        ├── scratchpad.json
        └── architecture.json
```

- Backend на каждый принятый patch делает debounced autosave (300ms) в соответствующий файл.
- Старт backend'а лениво подгружает комнату при первом обращении к ней (`GET /api/state?room=X` или WS `?room=X`).
- Файл — компактный JSON `CanvasState` (без opLog'а — он живёт только в памяти).

#### Режим 1: автоматический (из сессии Claude Code)

Регистрируется через `SessionStart` hook в `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "didraw daemon --ensure"
          }
        ]
      }
    ]
  }
}
```

- `didraw daemon --ensure` проверяет, запущен ли backend (по pid-файлу `~/.claude/.didraw.pid` и `lsof -i:8787`). Если нет — поднимает в фоне.
- При первом обращении из MCP-tool / skill backend подхватывает `$CLAUDE_SESSION_ID` (передаётся через query-параметр или X-header в API-вызовах от MCP-сервера) и создаёт/загружает соответствующую комнату.
- Draw skill дополнительно автоматически открывает `http://localhost:8787/?room=$CLAUDE_SESSION_ID` в браузере (один раз за сессию).

#### Режим 2: ручной (без сессии Claude Code)

CLI `didraw`:

```
didraw daemon              # запустить backend в фоне на 8787 (если не запущен)
didraw daemon --ensure     # idempotent: запустить, если не запущен; иначе ничего
didraw daemon --stop       # остановить backend
didraw daemon --status     # PID, аптайм, открытые комнаты

didraw open <room>         # открыть указанную комнату в браузере
                           # <room> = session-id ИЛИ имя из _manual/
                           # если не существует — создаст пустую в _manual/<room>.json
didraw open --file <path>  # открыть произвольный canvas.json по пути
didraw list                # список всех комнат (sessions/ и _manual/)
didraw export <room> --to <path>   # копирование canvas комнаты в файл проекта
didraw rm <room>           # удалить комнату (с подтверждением)
```

- При ручном запуске Hook'и и MCP не задействованы. Пользователь рисует руками. Это просто tldraw-доска с сохранением.
- `didraw open architecture` (без расширения) при отсутствии комнаты создаёт `_manual/architecture.json` — лёгкий way для скетча "только для меня".

#### Передача sessionId в MCP / Skill / Hook

- **MCP-сервер** (`canvas-mcp`): при инициализации читает env `CLAUDE_SESSION_ID`. Каждый tool-call автоматически добавляет `?room=$CLAUDE_SESSION_ID` к API-запросам. Fallback — `default`.
- **draw skill**: подставляет `$CLAUDE_SESSION_ID` в `curl`:
  ```
  !`curl -s "http://localhost:8787/api/state?fmt=compact&room=$CLAUDE_SESSION_ID"`
  ```
- **draw-prehook**: читает `$CLAUDE_SESSION_ID` из env, передаёт в запрос, обновляет `~/.claude/.draw-state-$CLAUDE_SESSION_ID` (per-session).

#### Backend multi-room — деталь реализации

- `Map<RoomId, { canvas: CanvasState, opLog: PatchOp[], prompts: Prompt[], version: number, dirty: boolean, lastTouched: number }>`.
- LRU-выгрузка: если комната не трогалась >1 часа и не подключён WS — выгружается из памяти (автосейв перед выгрузкой).
- Все REST endpoints принимают `?room=<id>` query (default = `"default"`).
- WS-сообщения роутятся по комнатам: `connect /ws?room=X` → клиент получает события только своей комнаты.

### 3.6 Targeted prompts — promt'ы с привязкой к объекту

Пользователь может выделить один или несколько объектов на canvas, написать рядом prompt — и AI получит этот prompt в своём контексте, зная, к каким именно объектам он относится. Это превращает доску в **входной канал для AI**, а не только в выходной.

#### Модель

```ts
type Prompt = {
  id: string,                              // UUID
  selection: string[],                     // ids of nodes / edges / groups
  text: string,
  createdAt: number,
  status: "pending" | "resolved" | "dismissed",
  response?: string,                       // что AI ответил (если решил записать)
  resolvedAt?: number,
}
```

`prompts: Prompt[]` живёт в `RoomState` вместе с `canvas` и `opLog`, сохраняется в `canvas.json` (только `pending` и недавние `resolved` — старые `resolved/dismissed` GC через 24 часа).

#### Backend

REST:
- `POST /api/prompt?room=<id>` — `{ selection, text }` → создаёт `Prompt` со `status:"pending"`. Возвращает `{ id }`.
- `GET /api/prompts?room=<id>&status=pending` — список.
- `POST /api/prompt/:id/resolve?room=<id>` — `{ response? }` → `status:"resolved"`.
- `POST /api/prompt/:id/dismiss?room=<id>` → `status:"dismissed"`.

WebSocket events:
- `{ kind: "prompt-created", prompt }` — broadcast при создании.
- `{ kind: "prompt-resolved", id, response? }` — при resolve/dismiss.

#### Frontend (UI)

- При **selection** одного или нескольких shapes — появляется floating-bar над выделением с input "Ask AI about this..." + кнопка Send.
- Enter / Send → `POST /api/prompt` с текущим selection.
- На выделенных объектах рисуется маркер `💬 N` если есть unresolved prompts. Клик по маркеру — drawer с историей prompt'ов/ответов по этому объекту.
- Когда приходит `prompt-resolved` по WS — маркер обновляется/исчезает, response (если есть) показывается в drawer'е.

#### Передача prompt'а в AI

- **Phase 1 (skill-injection):** в каждом `draw` skill-инъекте после `compact JSON` идёт секция:
  ```
  ## Pending prompts (user-promt'ы с привязкой к объектам)
  !`curl -s "$DIDRAW_URL/api/prompts?room=$CLAUDE_SESSION_ID&status=pending" | jq -c`
  ```
  AI видит `[{id, selection, text, createdAt}]`. Когда отвечает — вызывает `canvas_resolve_prompt({id, response?})`.
- **Phase 1.6 (PreToolUse hook):** hook'инг свежих prompts в `additionalContext` перед каждым `canvas_*` tool-call'ом (тот же механизм, что для canvas-diff).
- **Phase 2 (Channels):** новый prompt → push в активную сессию **мгновенно** через canvas-channel-mcp, без waiting и без скилла. AI прямо в середине ответа может прерваться "Пользователь спросил про сервер: ...".

#### MCP-tools

- `canvas_get_prompts({ status?: "pending"|"resolved"|"dismissed"|"all" })` — список.
- `canvas_resolve_prompt({ id, response?: string })` — пометить done. Опциональный `response` сохраняется и показывается user'у в drawer'е.
- `canvas_dismiss_prompt({ id })` — "не отвечу" / "не релевантно".

#### Сценарий использования

1. AI нарисовал архитектурную схему (через Mermaid-import).
2. User выделил узел "PaymentService", написал в input'е: *"А что если он упадёт? Покажи fallback path."*
3. Frontend → `POST /api/prompt` → backend сохраняет, WS-push.
4. Skill / hook / channel — AI узнаёт о новом prompt'е (зависит от Phase).
5. AI отвечает в Claude Code: "Если PaymentService падает, идёт fallback через RetryQueue → ManualReview. Добавляю эти узлы." + вызывает `canvas_apply_patch` + `canvas_resolve_prompt({id, response: "Добавил fallback path через RetryQueue."})`.
6. User видит на canvas: новые узлы, маркер 💬 на PaymentService обновился, в drawer'е появился response.

#### Edge cases

| Сценарий | Поведение |
|---|---|
| Объект из selection удалён до resolve | Prompt остаётся в очереди; в UI selection отображается как orphan ("targeted object deleted"). AI всё равно получает текст, но без рендеринга связи. |
| Очередь prompt'ов разрослась (10+ pending) | Compact-injection включает только последние 5; AI может попросить `canvas_get_prompts({status:"all"})` для полного списка. |
| User написал prompt, перезагрузил браузер | Prompt сохранён на бэкенде и в `canvas.json` — увидит при reload в drawer'е. |
| AI не отреагировал на prompt | Висит в `pending` неограниченно. User может вручную dismiss через UI или повторить prompt новым текстом. |

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
│   │   │   ├── rooms.ts           # Map<RoomId, RoomState>, LRU, lazy-load из файлов
│   │   │   ├── state.ts           # CanvasState, opLog, version (per-room)
│   │   │   ├── persistence.ts     # autosave debounce, load on first touch
│   │   │   ├── patch.ts           # apply PatchOp, validation, deep-merge
│   │   │   ├── mermaid-import.ts  # @tldraw/mermaid → PatchOp[]
│   │   │   ├── layout.ts          # elkjs обёртка
│   │   │   ├── ws.ts              # broadcast per-room
│   │   │   └── routes.ts
│   │   └── tests/
│   └── frontend/
│       ├── src/
│       │   ├── App.tsx                       # читает ?room= из URL
│       │   ├── canvas/
│       │   │   ├── editor.tsx
│       │   │   ├── from-canvas-state.ts      # CanvasState → tldraw shapes
│       │   │   ├── to-patch.ts               # tldraw store-event → PatchOp[]
│       │   │   └── kinds.ts                  # node-kinds → tldraw shape types
│       │   └── transport/ws.ts
│       └── tests/
├── packages/
│   ├── canvas-mcp/         # write/read MCP-сервер (читает CLAUDE_SESSION_ID)
│   ├── canvas-channel-mcp/ # Phase 2: Channels-протокол
│   └── didraw-cli/         # CLI: didraw daemon | open | list | export | rm
├── .claude/
│   ├── mcp.json            # регистрация canvas-mcp
│   ├── hooks/
│   │   └── draw-prehook.sh
│   ├── settings.json       # SessionStart + PreToolUse hooks
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
| **1.1 Backend MVP + multi-room** | `Map<RoomId, RoomState>`, lazy-load из `~/.claude/projects/<slug>/canvas/<room>.json`, apply_patch с deep-merge, REST/WS с `?room=`, op-log, version, idempotency | 1.5 | curl POST /api/patch?room=test добавляет узел в комнату test; GET /api/state?room=test отдаёт состояние; вторая комната `?room=other` изолирована |
| **1.2 Frontend MVP** | tldraw 5.x, читает `?room=` из URL, render CanvasState → shapes (включая frame/group), store.listen → POST /api/patch, WS-patch, free-form shapes (sticky/text/draw), свободные стрелки (Endpoint:point) | 2 | Браузер рисует, разные комнаты в разных табах изолированы, стрелки можно тянуть "в пустоту" |
| **1.3 didraw CLI** | команды `daemon` (start/stop/status/ensure), `open <room>`, `list`, `export`, `rm`; pid-файл, idempotent запуск, открытие браузера | 1 | `didraw open scratch` → backend поднимается, браузер открывается на `?room=scratch`, через 5 мин остановки — autosave на диск |
| **1.4 MCP + Skill + SessionStart hook** | canvas-mcp с автоматической подстановкой `CLAUDE_SESSION_ID` как room, draw skill с инъекцией compact JSON, SessionStart hook вызывает `didraw daemon --ensure` | 1 | В Claude Code "Нарисуй a→b" → на canvas конкретной сессии появляются узлы; в параллельной сессии — отдельная доска |
| **1.5 Mermaid-import + layout** | `@tldraw/mermaid` → PatchOp[] (по итогам spike — на backend или frontend), elkjs auto-layout, обработка ошибок парсинга | 1 | AI вызывает `canvas_import_mermaid` — canvas корректно отрисовывает |
| **1.6 PreToolUse hook** | hook-script с правильным `hookSpecificOutput.additionalContext`, регистрация в `.claude/settings.json`, persist `DRAW_LAST_VERSION` per-session | 0.5 | Пользователь сдвинул узел → на следующем canvas_* tool-call'е AI видит изменение через `additionalContext` |
| **1.7 Targeted prompts** | backend endpoints `/api/prompt`, frontend selection-input + drawer + 💬 маркер, skill инжектит pending prompts, MCP tools `resolve_prompt`/`dismiss_prompt` | 1 | User выделил узел, написал prompt → AI получил, ответил в Claude Code и вызвал resolve → маркер обновился |
| **1.8 Polish + tests** | golden-path Playwright (auto-mode + manual-mode + targeted prompts), README, demo-gif | 1 | Видеодемо: совместная сессия user + AI; параллельно ручная комната; targeted prompt'ы работают |
| **Phase 2: Channels-push** | canvas-channel-mcp, регистрация `--channels plugin:canvas-channel-mcp`, переадресация WS-событий → Claude session ([docs](https://code.claude.com/docs/en/channels)) | +2 | User меняет canvas — Claude получает событие без waiting; AI может комментировать без user-prompt'а |
| **Phase 3: D2-import, история, расширенный multi-user** | `POST /api/import/d2`, миграция persistence на SQLite (история op-log), conflict resolution для одновременного редактирования двумя пользователями, export Mermaid/SVG | +3 | D2-импорт работает; история patch'ей доступна; два пользователя в одной комнате не затирают друг друга |

**MVP до Phase 1.8: 9.5–10 рабочих дней** (+1 день на targeted prompts; multi-room и persistence теперь вместе в 1.1).

**Минимальное интересное демо = MVP + Phase 2 = ~12 дней.** Phase 2 особенно важна для targeted prompts: с Channels AI узнаёт о новом prompt'е мгновенно, без waiting на следующий tool-call.

## 7. Известные риски

1. **`@tldraw/mermaid` headless на backend.** Может не работать без DOM. **Первая задача implementation plan — Phase 0.1 spike**, который ответит на этот вопрос. Запасной план: парсинг и конвертация переезжают на frontend worker, бэкенд хранит только результирующие PatchOp'ы.
2. **Channels — preview-фича Claude Code (2.1.80+).** Может быть нестабильна, требовать конфигурации. Phase 1.5 (PreToolUse hook) уже даёт почти-реактивный режим, поэтому MVP не блокируется.
3. **AI хочет двигать существующие узлы, но не помнит точные координаты.** Скилл инжектит compact JSON с округлёнными координатами; AI может попросить `canvas_layout` для авто-перерасчёта или `canvas_get_state({fmt:"full"})` для точных координат.
4. **Свободные формы (free-form draw) с длинным массивом точек.** Если их много, compact JSON распухает. Митигация: `fmt=compact` опускает `kind:"freeform"` целиком, передавая только `{id, kind, label?: "...freeform sketch..."}` — AI знает что они есть, но не видит детали.
5. **Echo-loop через WS.** Если patch применяется и шлётся обратно — клиент применит снова. Защита через `source` + `clientOpId`-fingerprint; в тестах эту проверку покрываем явно.
6. **Layout-конфликты при ELK + ручные правки.** Если пользователь сдвинул узел, а потом AI запросил `canvas_layout` для всех — координаты пользователя затрутся. Митигация: `canvas_layout` принимает `nodeIds?` — можно лейаутить только новые узлы.
7. **Размер MCP-tool responses.** `canvas_get_state({fmt:"full"})` для большого canvas может быть тяжёлым. Митигация: `fmt:"compact"` по умолчанию + `since` для дельт.
8. **Stale prompts queue.** Если AI игнорирует prompts (не вызывает resolve/dismiss), очередь растёт и раздувает skill-инъект. Митигация: compact-injection обрезает до 5 последних; GC через 24 часа для `resolved/dismissed`; user может вручную dismiss из drawer'а.
9. **CLAUDE_SESSION_ID может быть недоступен в env.** Если переменная не передаётся в MCP-сервер (зависит от версии Claude Code), MCP попросит её через `request_meta` от клиента или fallback на `default`. Spike в Phase 0.1 включает проверку этой переменной.
10. **Race condition при первом запуске сессии.** SessionStart hook поднимает backend → требуется ~100ms на старт. Если skill-инъект срабатывает раньше → 502. Митигация: `didraw daemon --ensure` блокирует до health-check'а; skill ловит 502 и ретраит.

## 8. Что **не** делаем в MVP (зафиксировать)

- **Multi-user collaborative editing** (одновременная работа двух+ пользователей в одной комнате с merge/CRDT) — Phase 3. *Multi-room (per-session) уже в MVP, см. §3.5.*
- Аутентификация, ACL.
- Облачный хостинг.
- Импорт **D2** (только Mermaid в MVP); экспорт обратно в Mermaid/D2/SVG — Phase 3.
- Headless tldraw на сервере — пока не нужен.
- Поддержка всех типов Mermaid — что парсит `@tldraw/mermaid`, то и работает (flowchart точно; sequence/state/mindmap — best-effort).
- Версионирование / undo на уровне UI (op-log есть, но кнопок Undo/Redo пока нет — Phase 1.6 polish если успеваем).

## 9. Открытые вопросы / решённые умолчания

**Зафиксировано как дефолт (можно поменять одним замечанием):**

- **Порт backend = 8787** (env `DIDRAW_PORT` для override).
- **Backend — single process, multi-room.** Каждая комната = `CLAUDE_SESSION_ID` (auto) или произвольное имя (manual). Документы — `~/.claude/projects/<slug>/canvas/<room>.json`.
- **Два режима запуска**: автоматический (SessionStart hook → `didraw daemon --ensure`) и ручной (`didraw open <room>` или `didraw open --file <path>`).
- **Push canvas → Claude — двухуровневый**: Phase 1.6 (PreToolUse hook, всегда работает) + Phase 2 (Channels, реальный push).
- **Mermaid — convenience-entry, не SSOT.** Используется только когда AI вызывает `canvas_import_mermaid`. Дальше canvas-state ведёт сам себя.
- **Поддерживаемые формы в MVP**: rect, ellipse, diamond, sticky, text, freeform, edges (с Endpoint:node|point). Без ограничений по типу диаграммы.
- **Targeted prompts с MVP** (Phase 1.7): user выделяет shapes, пишет prompt, AI получает в контекст и резолвит через MCP.

**Реально открытое:**

1. **Эволюция persistence:** MVP — per-room JSON-файл (`canvas/<room>.json`, autosave debounce 300ms). Phase 3 — миграция на SQLite, если понадобится: история op-log за пределами 50 последних патчей, поиск по содержимому всех комнат, conflict-resolution для multi-user. Триггер миграции пока не выбран — решим по first use.
2. **Spike-результат по `@tldraw/mermaid` headless.** Если на Bun не работает — Phase 1.5 переедет на frontend (parsing + конвертация в worker, бэкенд получает уже готовые PatchOp'ы). Уточняем по итогам Phase 0.1.

---

*Документ зафиксирован 2026-05-14. После одобрения пользователя — переход к составлению implementation plan (skill `superpowers:writing-plans`).*
