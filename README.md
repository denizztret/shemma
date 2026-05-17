# di.draw

> **Применимо к:** di.draw `0.0.1` (2026-05-15).
> Документ описывает поведение текущей версии. Поведение может измениться — сверяйтесь с [CHANGELOG.md](CHANGELOG.md) для следующих версий.

AI-driven canvas board для Claude Code сессий. tldraw 5.x frontend + Bun backend + `didraw` CLI + skill cheat-sheet + persistent watcher pattern.

Один single-binary `didraw`, в который вшиты backend, embedded UI и CLI dispatcher (`bun build --compile` + generated embedded-assets manifest).

## Features (0.0.1)

- **Multi-room canvas** — `~/.claude/projects/<slug>/canvas/<room>.json`, изоляция по сессии Claude Code.
- **Real-time collaboration** через WebSocket (`patch`, `prompt-created`, `prompt-resolved`, `prompt-removed`, `ai-activity`).
- **AI workflow** через Bash CLI: skill `/draw` инжектит canvas state + pending prompts в каждый AI turn.
- **AI activity badge** — оранжевый чип сверху по центру показывает, что агент что-то делает (actor + task), пока работает.
- **Per-shape prompts** — выдели shape, нажми `⌘K`/`Ctrl+K`, введи команду; она попадает в drawer слева. Удаление: `×` per-card или `🗑 N` (purge non-pending) с confirm.
- **Persistent watcher pattern** — Sonnet subagent в фоне обрабатывает pending prompts: применяет patch + резолвит. Latency 3–10с. См. [Watcher workflow](#ai-workflow-watcher-vs-manual).
- **Style roundtrip** — изменение цвета/заливки в любую сторону (AI ↔ backend ↔ tldraw). Ограничение: tldraw 5.x использует один `color` для stroke и fill (см. known issues).
- **Auto-center camera** на shapes, добавленных AI; персистентность позиции/zoom per room в localStorage.
- **Mermaid импорт** в браузере: `await window.didrawImportMermaid('graph LR\n  app --> db')`.

## Quick start (manual mode)

```bash
bun install
didraw                                  # zero-arg: ensure daemon в cwd .didraw/ + open browser
didraw open scratch                     # то же, но с конкретным room override
```

`didraw` без аргументов поднимает daemon с **project-local** storage в `<cwd>/.didraw/` (subdir `canvas-dev/` для dev, `canvas/` для release/debug) и открывает браузер на `?room=default`. Если daemon уже запущен на другом storage — `exit 1` с понятным error.

Storage precedence: `--storage <path>` > `DIDRAW_STORAGE_DIR` env > auto-cwd `.didraw/`.

## В Claude Code сессии

`.claude/settings.json` SessionStart-хук поднимает backend; PreToolUse-хук инжектит canvas-diff в каждый AI Bash. Дальше:

- `/draw нарисуй …` — skill инжектит state + cheat-sheet + pending prompts; AI обновляет canvas через `didraw patch --stdin`.
- Браузер можно открыть в любой момент: `http://localhost:8787/?room=<CLAUDE_SESSION_ID>`.
- На canvas: выдели объект(ы), нажми `⌘K`, введи промпт — он попадёт в drawer слева с привязкой к ID. AI увидит pending prompts через `didraw prompts list` и ответит через `didraw prompts resolve`.

## AI workflow: watcher vs manual

В версии `0.0.1` есть два пути обработки prompts:

1. **Manual / `/draw` invocation.** Pending prompts видны AI только при следующем явном вызове skill'а или `didraw prompts list`. Подходит для редких команд.
2. **Persistent watcher** — Sonnet subagent в фоне опрашивает pending каждые 1–4с и применяет. Запускается из родительской Claude Code сессии через Agent tool с `subagent_type=general-purpose, model=sonnet, run_in_background=true`. Описание паттерна — в [`docs/handoff/watcher-pattern.md`](docs/handoff/watcher-pattern.md) (TODO в этой версии).

> ⚠️ Stand-alone `didraw watch` (без Claude Code, через Anthropic API напрямую) — **не реализован** в `0.0.1`, см. backlog.

## CLI reference

Lifecycle:

```bash
didraw                                              # ensure daemon on cwd .didraw/ + open browser
didraw open [<room>] [--storage <path>] [--no-browser]
                                                    # explicit form; optional room override
didraw daemon ensure | start [--storage <path>] | stop [--all] | status [--profile dev|release|debug]
didraw ps                                           # JSON status for all profiles
didraw rooms list
didraw rooms export <room> --to <path>
didraw rooms rm <room> [--archive|--hard] [--force] --confirm
```

Domain (preferred AI interface):

```bash
didraw define <role> <name> [--label "..."] [--in <container>] [--room <id>]
didraw connect <from> <to> [--kind sync|async|data|dep] [--label "..."] [--room <id>]
didraw group <id1,id2,...> --as network|boundary --name <name> [--room <id>]
didraw note --text "..." [--about <name>] [--room <id>]
didraw layout [--mode layered-lr|layered-tb|tree|pack|force] [--scope all|<group>] [--room <id>]
didraw delete <id1,id2,...> [--cascade] [--room <id>]
didraw apply --stdin [--room <id>]                  # JSON batch on stdin
didraw context [--since N] [--viewport x,y,w,h] [--room <id>]
```

Data:

```bash
didraw state [--compact] [--since N] [--room <id>]
echo '{"ops":[...],"source":"ai"}' | didraw patch --stdin [--room <id>]
didraw prompts list [--status pending|resolved|dismissed|all]
didraw prompts resolve <id> [--response "text"]
didraw prompts dismiss <id>
didraw prompts delete <id>          # remove a single prompt (any status)
didraw prompts purge                # remove all non-pending in one shot
didraw clear --confirm
```

AI-activity badge (показывает в UI, что агент работает):

```bash
didraw ai start --actor watcher --task "applying prompts"
# ... do work ...
didraw ai stop
didraw ai status                     # current activity (or null)
```

Stale activity auto-clear через 5 минут на server-side, но явный `stop` — правильный шаблон.

Diagnostics:

```bash
didraw logs [--tail 50] [--follow] [--all | --profile dev|release|debug]
didraw doctor [--all | --profile dev|release|debug] [--json]
```

Versioning + update:

```bash
didraw version
didraw update --check
didraw update --channel stable|nightly|dev
didraw update                      # download + sha256 + atomic swap + restart
```

Mermaid импорт — **только через браузер** (per ADR-0001): открой canvas и в DevTools console выполни `await window.didrawImportMermaid('graph LR\n  app --> db')`.

Exit codes: `0` ok, `1` usage/error, `2` not-found, `3` daemon-not-healthy.

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
bun run test                              # 64 unit/integration: 50 backend + 4 client + 7 cli + 3 autosave/persistence
cd apps/frontend && bunx playwright test  # golden-path e2e
bun run lint                              # biome
```

## Release build

```bash
./scripts/build-release.sh 0.0.1 stable          # → release/didraw-{darwin-arm64,darwin-x64,linux-x64}
./scripts/generate-manifest.sh 0.0.1 stable      # → release/release-manifest.json
./scripts/publish-release.sh 0.0.1 stable        # build + manifest + gh release create (опционально)
```

Бинарь — single-file (frontend assets вшиты через `import ... with { type: "file" }`).
