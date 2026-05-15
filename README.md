# di.draw

AI-driven canvas board для Claude Code сессий. tldraw 5.x frontend + Bun backend + `didraw` CLI + skill cheat-sheet.

Один single-binary `didraw`, в который вшиты backend, embedded UI и CLI dispatcher (`bun build --compile` + generated embedded-assets manifest).

## Quick start (manual mode)

```bash
bun install
bun --cwd packages/didraw-cli src/index.ts open scratch
```

Откроется `http://localhost:8787/?room=scratch` — рисуй вручную.

## В Claude Code сессии

`.claude/settings.json` SessionStart-хук поднимает backend; PreToolUse-хук инжектит canvas-diff в каждый AI Bash. Дальше:

- `/draw нарисуй …` — skill инжектит state + cheat-sheet + pending prompts; AI обновляет canvas через `didraw patch --stdin`.
- Браузер можно открыть в любой момент: `http://localhost:8787/?room=<CLAUDE_SESSION_ID>`.
- На canvas: выдели объект(ы), напиши промпт — он попадёт в drawer слева с привязкой к ID. AI увидит pending prompts через `didraw prompts list` и ответит через `didraw prompts resolve`.

## CLI reference

Lifecycle:

```bash
didraw daemon ensure | start | stop | status [--profile dev|release|debug]
didraw open <room>
didraw list
didraw export <room> --to <path>
didraw rm <room> --confirm
```

Data:

```bash
didraw state [--compact] [--since N] [--room <id>]
echo '{"ops":[...],"source":"ai"}' | didraw patch --stdin [--room <id>]
didraw layout --algorithm elk-layered [--node-ids n1,n2] [--room <id>]
didraw prompts list [--status pending|resolved|dismissed|all]
didraw prompts resolve <id> [--response "text"]
didraw prompts dismiss <id>
didraw clear --confirm
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
bun run test                              # backend + client + cli (50+ unit/integration)
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
