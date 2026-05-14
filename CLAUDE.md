# di.draw

**AI-driven canvas board for Claude Code sessions.**

tldraw 5.x frontend + Bun backend (`:8787`) + `didraw` CLI + skill cheat-sheet. Per-session canvas-документы в `~/.claude/projects/<slug>/canvas/<room>.json`. Multi-room, runtime profiles (dev/release/debug), single-binary distribution через `bun build --compile`.

## Project status

- **Spec:** `docs/superpowers/specs/2026-05-14-di-draw-design.md` (v3.7, approved)
- **Plan:** `docs/superpowers/plans/2026-05-14-di-draw-implementation.md` (v5, 47 tasks, ~5080 строк)
- **Stage:** Brainstorm/spec/plan завершены. Готов к исполнению. **Кода ещё нет.**

## Architecture summary

- **Core:** `CanvasState + PatchOp` REST/WS API в Bun backend.
- **Machine interface:** `didraw` CLI (lifecycle + data commands), shared `@didraw/client` HTTP wrapper. AI работает через Bash в skill cheat-sheet'е.
- **Runtime profiles:** `release` (8787, embedded UI) / `dev` (8788, Vite HMR) / `debug` (release + verbose). Параллельная работа без конфликтов.
- **MCP — Phase 2.1**, тонкий adapter над тем же `@didraw/client`. В MVP нет.
- **UI:** tldraw editor — primary; di.draw добавляет минимальный service-layer через `components`/`overrides` (room badge, prompts, version footer, update banner). См. spec §3.8.

## Key files

- `docs/superpowers/specs/2026-05-14-di-draw-design.md` — design contract (читай ПЕРЕД любыми архитектурными решениями)
- `docs/superpowers/plans/2026-05-14-di-draw-implementation.md` — implementation plan, 47 задач в TDD-формате
- `docs/decisions/` — ADRs (будут появляться по ходу исполнения; первая — ADR-0001 в Task 4)

## How to execute

Запустить subagent-driven-development по плану:

```
/superpowers:subagent-driven-development

Plan: docs/superpowers/plans/2026-05-14-di-draw-implementation.md
Spec: docs/superpowers/specs/2026-05-14-di-draw-design.md
Start: Task 1
```

Skill сам спавнит свежий subagent на каждую задачу, у которой checkbox `- [ ]` ещё не отмечен. Между задачами — review checkpoint.

## Debug tooling

- **chrome-devtools MCP** — для visual verification UI (см. Tasks 11.5, 28, 38, 39). Команды: `navigate_page`, `take_screenshot`, `take_snapshot`, `list_console_messages`, `click`.
- **bun test** — backend, CLI, client (`bun run test` из корня).
- **Playwright** — UI smoke (Task 39).

## Constraints (важно)

- **Не упрощай спеку**. Если что-то непонятно — спросить пользователя или зафиксировать в ADR, не "догадаться".
- **Cascade-delete, graceful shutdown, deep-merge для style/meta, echo-guard** — не оптимизации, а требования spec. Тесты в Tasks 6/8/10/13 их фиксируют.
- **tldraw 5.x обязателен** (npm `tldraw@^3.0` соответствует SDK 5.x; для `@tldraw/mermaid`). Проверь `npm view tldraw versions` при install.
- **CLI — стабильный machine interface**. Если меняешь output, обнови integration-тесты (Task 18) и `CHANGELOG.md` (Phase 1.11).
- **§3.8 UI design**: tldraw остаётся primary UI, наши элементы — service-layer. Никаких произвольных `position:fixed` overlay'ев.
