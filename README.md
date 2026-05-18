# shemma

> **Применимо к:** shemma `0.13.0` (2026-05-18).
> Документ описывает поведение текущей версии. Поведение может измениться — сверяйтесь с [CHANGELOG.md](CHANGELOG.md) для следующих версий.

AI-driven canvas board для Claude Code сессий. tldraw 5.x frontend + Bun backend + `shemma` CLI + skill cheat-sheet + persistent watcher pattern.

Один single-binary `shemma`, в который вшиты backend, embedded UI и CLI dispatcher (`bun build --compile` + generated embedded-assets manifest).

## Features

- **Multi-room canvas** — `~/.claude/projects/<slug>/canvas/<room>.json`, изоляция по сессии Claude Code.
- **Real-time collaboration** через WebSocket (`patch`, `prompt-created`, `prompt-resolved`, `prompt-removed`, `ai-activity`, `board-focus`).
- **MCP integration** (0.13.0+) — typed tools, discoverable resources, auto-open browser, room-resolution chain для агентских клиентов (Claude Desktop, Codex). См. [MCP integration](#mcp-integration).
- **AI workflow через Bash CLI** — skill `/draw` инжектит canvas state + pending prompts в каждый AI turn (legacy path; MCP — preferred).
- **AI activity badge** — оранжевый чип сверху по центру показывает, что агент что-то делает (actor + task), пока работает.
- **Per-shape prompts** — выдели shape, нажми `⌘K`/`Ctrl+K`, введи команду; она попадает в drawer слева. Удаление: `×` per-card или `🗑 N` (purge non-pending) с confirm.
- **Persistent watcher pattern** — Sonnet subagent в фоне обрабатывает pending prompts: применяет patch + резолвит. Latency 3–10с. См. [Watcher workflow](#ai-workflow-watcher-vs-manual).
- **Style roundtrip** — изменение цвета/заливки в любую сторону (AI ↔ backend ↔ tldraw). Ограничение: tldraw 5.x использует один `color` для stroke и fill (см. known issues).
- **Auto-center camera** на shapes, добавленных AI; персистентность позиции/zoom per room в localStorage.
- **Mermaid импорт** — `⌘M`/`Ctrl+M` или кнопка в toolbar открывает модал для вставки mermaid-кода. Программный доступ из DevTools: `await window.shemmaImportMermaid('graph LR\n  app --> db')`.

## Quick start (manual mode)

```bash
bun install
shemma                                  # zero-arg: ensure daemon в cwd .shemma/ + open browser
shemma open scratch                     # то же, но с конкретным room override
```

`shemma` без аргументов поднимает daemon с **project-local** storage в `<cwd>/.shemma/` (subdir `canvas-dev/` для dev, `canvas/` для release/debug) и открывает браузер на `?room=default`. Если daemon уже запущен на другом storage — `exit 1` с понятным error.

Storage precedence: `--storage <path>` > `SHEMMA_STORAGE_DIR` env > auto-cwd `.shemma/`.

## В Claude Code сессии

`.claude/settings.json` SessionStart-хук поднимает backend; PreToolUse-хук инжектит canvas-diff в каждый AI Bash. Дальше:

- `/draw нарисуй …` — skill инжектит state + cheat-sheet + pending prompts; AI обновляет canvas через `shemma patch --stdin`.
- Браузер можно открыть в любой момент: `http://localhost:8787/?room=<CLAUDE_SESSION_ID>`.
- На canvas: выдели объект(ы), нажми `⌘K`, введи промпт — он попадёт в drawer слева с привязкой к ID. AI увидит pending prompts через `shemma prompts list` и ответит через `shemma prompts resolve`.

## AI workflow: MCP vs CLI vs watcher

Три пути обработки prompts (в порядке предпочтения):

1. **MCP** (0.13.0+) — агентский клиент (Claude Desktop, Codex, etc.) подключается к stdio MCP-серверу `shemma mcp start`. Использует typed tools (`shemma_define`, `shemma_apply`, `shemma_prompts_list`, etc.) и discoverable resources вместо bash quoting. См. [MCP integration](#mcp-integration).
2. **Manual / `/draw` invocation** — pending prompts видны AI только при следующем явном вызове skill'а или `shemma prompts list`. Подходит для редких команд.
3. **Persistent watcher** — Sonnet subagent в фоне опрашивает pending каждые 1–4с и применяет. Запускается из родительской Claude Code сессии через Agent tool с `subagent_type=general-purpose, model=sonnet, run_in_background=true`.

> ⚠️ Stand-alone `shemma watch` (без Claude Code, через Anthropic API напрямую) — **не реализован**. Background-agent loop планируется в Phase 2.4 (см. spec §18).

## CLI reference

Lifecycle:

```bash
shemma                                              # ensure daemon on cwd .shemma/ + open browser
shemma open [<room>] [--storage <path>] [--no-browser]
                                                    # explicit form; optional room override
shemma daemon ensure | start [--storage <path>] | stop [--all] | status [--profile dev|release|debug]
shemma ps                                           # JSON status for all profiles
shemma rooms list
shemma rooms export <room> --to <path>
shemma rooms rm <room> [--archive|--hard] [--force] --confirm
```

Domain (preferred AI interface):

```bash
shemma define <role> <name> [--label "..."] [--in <container>] [--room <id>]
shemma connect <from> <to> [--kind sync|async|data|dep] [--label "..."] [--room <id>]
shemma group <id1,id2,...> --as network|boundary --name <name> [--room <id>]
shemma note --text "..." [--about <name>] [--room <id>]
shemma layout [--mode layered-lr|layered-tb|tree|pack|force] [--scope all|<group>] [--room <id>]
shemma delete <id1,id2,...> [--cascade] [--room <id>]
shemma apply --stdin [--room <id>]                  # JSON batch on stdin
shemma context [--since N] [--viewport x,y,w,h] [--room <id>]
```

Data:

```bash
shemma state [--compact] [--since N] [--room <id>]
echo '{"ops":[...],"source":"ai"}' | shemma patch --stdin [--room <id>]
shemma prompts list [--status pending|resolved|dismissed|all]
shemma prompts resolve <id> [--response "text"]
shemma prompts dismiss <id>
shemma prompts delete <id>          # remove a single prompt (any status)
shemma prompts purge                # remove all non-pending in one shot
shemma clear --confirm
```

AI-activity badge (показывает в UI, что агент работает):

```bash
shemma ai start --actor watcher --task "applying prompts"
# ... do work ...
shemma ai stop
shemma ai status                     # current activity (or null)
```

Stale activity auto-clear через 5 минут на server-side, но явный `stop` — правильный шаблон.

Diagnostics:

```bash
shemma logs [--tail 50] [--follow] [--all | --profile dev|release|debug]
shemma doctor [--all | --profile dev|release|debug] [--json]
```

Versioning + update:

```bash
shemma version
shemma update --check
shemma update --channel stable|nightly|dev
shemma update                      # download + sha256 + atomic swap + restart
```

Mermaid импорт — **в браузере** (per ADR-0001): `⌘M`/`Ctrl+M` или кнопка в toolbar открывает модал; программный путь — DevTools console `await window.shemmaImportMermaid('graph LR\n  app --> db')`.

Exit codes: `0` ok, `1` usage/error, `2` not-found, `3` daemon-not-healthy.

## MCP integration

Shemma ships an MCP (Model Context Protocol) adapter so agentic clients (Claude Desktop, Codex, etc.) can call Shemma through typed tools and discoverable resources without shell quoting.

> Полный гайд для пользователя — [`docs/mcp.md`](docs/mcp.md) (установка, обновление, жизненный цикл, auto-open, room resolution, trust model).

### Install

```bash
shemma mcp install --client claude   # writes Claude Desktop config
shemma mcp install --client codex    # writes ~/.codex/config.toml
shemma mcp install --client claude --print   # prints config snippet without writing
```

If the target config already exists, the command refuses to overwrite. Pass `--force` to overwrite (a `.bak.<timestamp>` copy is saved first).

### Manual config

```json
{
  "mcpServers": {
    "shemma": {
      "command": "shemma",
      "args": ["mcp", "start", "--cwd", "/path/to/project"]
    }
  }
}
```

### What the MCP server provides

- **Tools.** `shemma_define / connect / group / note / layout / delete / apply` for writes; `shemma_context / rooms_list / active_rooms / prompts_list / health / version` for reads; `shemma_open` for explicit browser-open; `shemma_prompt_resolve / dismiss` for CMD+K canvas prompts; `shemma_get_instructions` to read workflow markdown.
- **Resources.** `shemma://workflow/{overview,read-context,draw-architecture,resolve-prompts,trust-model}` for agent guidance, `shemma://status`, `shemma://rooms`, `shemma://active-rooms`, `shemma://room/{room}/context|state|prompts/...` templates.
- **Prompts.** `shemma_draw_architecture`, `shemma_review_canvas`, `shemma_explain_canvas`, `shemma_resolve_canvas_prompts`.

### Behaviour

- Auto-opens a browser tab the first time the agent draws in a new room (`--auto-open once` default; pass `never|always|confirm` to override).
- Room id auto-resolves from explicit arg → server config → `CLAUDE_SESSION_ID` → single active room → Backlog "In Progress" task slug → last-touched → "default".
- Canvas text is treated as **data, not instructions** (see `shemma://workflow/trust-model`).

CLI remains the stable interface; MCP is an alternative for clients that support it.

## Runtime profiles

| profile | port | storage | UI | log |
|---|---|---|---|---|
| `release` (default) | 8787 | `~/.claude/projects/<slug>/canvas/` | embedded | info |
| `dev` | 8788 | `~/.claude/projects/<slug>/canvas-dev/` | Vite HMR | debug |
| `debug` | 8787 | `canvas/` (как release) | embedded | debug |

`dev` и `release` могут работать параллельно (разные порты, pid-файлы, storage).

## Architecture

См. `docs/superpowers/specs/2026-05-14-di-draw-design.md` (v3.7) и `docs/superpowers/plans/2026-05-14-di-draw-implementation.md` (v5).

Ключевые ADR — `docs/decisions/`.

## Tests

```bash
bun run test                              # 611 unit/integration: 58 domain + 284 backend + 7 client + 152 cli + 110 mcp
cd apps/frontend && bunx playwright test  # golden-path e2e
bun run lint                              # biome
```

## Release build

```bash
./scripts/build-release.sh 0.13.0 stable          # → release/shemma-{darwin-arm64,darwin-x64,linux-x64}
./scripts/generate-manifest.sh 0.13.0 stable      # → release/release-manifest.json
./scripts/publish-release.sh 0.13.0 stable        # build + manifest + gh release create (опционально)
```

Бинарь — single-file (frontend assets вшиты через `import ... with { type: "file" }`).
