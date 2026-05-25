# shemma

**AI-driven canvas board for Claude Code sessions.**

tldraw 5.x frontend + Bun backend (singleton daemon на `:8787` release+debug, `:8788` dev) + `shemma` CLI + skill cheat-sheet. Canvas-документы привязаны к spaces из registry `~/.config/shemma/spaces.json`; composite key `(spaceId, roomId)`. Multi-room, runtime profiles (dev/release/debug), single-binary distribution через `bun build --compile`.

## Project status

- **v0.0.1** (Phase 1 MVP) — shipped.
- **v0.1.0** (Phase 2.0 persistence hardening) — shipped (tag на `e10174f`).
- **v0.2.0** (Phase 2.1 Agent v2 domain-first) — shipped (tag на `0af178d`). 255 tests across 4 packages.
- **v0.3.0** (Phase 2.2 Sync hardening + B1 user-arrows) — shipped. 1321 tests across 5 packages (root pipeline).
- **v0.23.0** (Phase 3.0 Canvas-AI bidirectional protocol) — shipped. 1321 root + 206 frontend = 1527+ tests across 6 packages.

## Git policy — repository is LOCAL-ONLY

**Не пушим.** Remote `origin` не настроен и настраивать пока не надо. Все ветки + теги — только локально. Если в future ситуация изменится, user скажет явно. Не предлагай push в каждом ответе.

## Git workflow — GitFlow + SemVer

**Branches:**
- `main` — production-ready. **ВСЕ изменения** идут через ветки + `--no-ff` merge. Прямые коммиты в `main` **запрещены без исключений** — даже однострочная правка docs/memory/README. На main-line должны быть только merge-коммиты, release-коммиты и теги; одиночных feature/fix/docs коммитов вне ветки быть не должно.
- `feature/<short-name>` — новые фазы и крупные feature'ы. От `main`, merge обратно по готовности.
- `fix/<short-name>` или `hotfix/<short-name>` — баг-фиксы из backlog. От `main`, merge обратно.
- `docs/<short-name>` — правки CLAUDE.md / docs/* / memory pointers / README / changelog backfill вне feature scope. От `main`, merge обратно.
- Merge style: `--no-ff` (сохраняем merge-коммит как явную метку конца ветки). Никогда не `rebase` feature-ветку перед merge — branch history должна оставаться видимой.
- Удалять ветку после merge (локально).

**SemVer (https://semver.org):**
- `MAJOR.MINOR.PATCH`. Pre-1.0 (`0.x.y`) — нет гарантий API stability, любая `MINOR` может ломать.
- `MAJOR` (после 1.0) — breaking API change.
- `MINOR` — backward-compat feature (новая phase обычно).
- `PATCH` — backward-compat bug fix (фикс из backlog).

**Tags:**
- Чистые числа без префикса: `0.3.0`, `0.3.1`, `0.4.0` и т.д.
- НЕ использовать `v0.x.y` — это устаревший формат. Старые `v0.1.0` / `v0.2.0` / `v0.3.0` остаются как legacy; решение про переименование — отдельно.
- Tag ставится локально на `main` после release-коммита.

**Когда ставить tag (release triggers):**

| Триггер | Релиз? |
|---|---|
| Завершена фаза (MINOR bump, например `0.27.0` → `0.28.0`) | да |
| Накопилось ≥3 fix'ов **и** user даёт explicit signal "релиз" (PATCH bump, `0.27.0` → `0.27.1`) | да |
| Critical hotfix (regression ломает работу) | да (PATCH сразу) |
| Merge одной feature/fix ветки в `main` | **нет** |
| Завершён один Backlog task | **нет** |
| Прошёл интервал времени / scheduled cadence | **нет** |

Между релизами версия определяется runtime через `git describe --tags --dirty` → формат `0.27.0-3-gabc1234[-dirty]`. Это и есть source of truth для dev/debug сборки. Промежуточные теги НЕ нужны.

Каждый tag сопровождается: bump в package.json (всех 9), release-commit, optional `git push --tags`, optional GH Release с binaries (через `./scripts/publish-release.sh`). См. [[feedback-versioning-tags-only-on-release]] + [[feedback-batch-release-cluster]].

## Plan workflow (важно)

1. Brainstorm → spec в `docs/superpowers/specs/`.
2. Plan в `docs/superpowers/plans/`.
3. **Plan approval gate** — user читает план, могут быть правки и ревью. Не запускать execution самостоятельно.
4. Перед execution — **подготовка к compact/новой сессии**: убедиться, что memory отражает current state (plan path, executor mode, baseline commit) для clean resume.
5. После compact/new session — запуск execution по утверждённому плану.

Этот workflow повторяется для каждой phase. Don't skip the approval gate.

## Architecture summary

- **Core:** `CanvasState + PatchOp` REST/WS API в Bun backend.
- **Singleton daemon (0.22.0+):** один process на машину обслуживает все spaces. mkdir-lock в `~/.shemma/run/<profile>.lock/` с PID handshake + metadata file; `shemma daemon status` читает оттуда. Idle-shutdown 30 min default. Параллельные `shemma` invocations либо attach'атся к существующему daemon, либо подвисают на lock acquire.
- **Spaces registry (0.22.0+):** `~/.config/shemma/spaces.json` с `proper-lockfile` concurrency. Каждый space = `{id, path, storageLayout, lastUsedAt, ...}`. Storage layouts: `direct` (path/<room>.json — для тестов и legacy `--storage`), `claude` (legacy `~/.claude/projects/*/canvas/`), `shemma` (новый default: `<path>/.shemma/canvas/<room>.json`). Composite key `(spaceId, roomId)` — глобально уникален.
- **Domain layer (v0.2.0+):** typed actions (define/connect/group/note/layout/delete) поверх `@shemma/domain` shared package. AI работает через `POST /api/domain` (`shemma` CLI обёртка), не через сырой `/api/patch`.
- **Token-cheap context:** `GET /api/agent/context?since=N` отдаёт domain summary без геометрии (≤8KB на 100 элементов).
- **Machine interface:** `shemma` CLI (lifecycle + data commands + `s` subcommands для registry), shared `@shemma/client` HTTP wrapper (threads `space?` через каждый HTTP call). AI работает через Bash в skill cheat-sheet'е.
- **Runtime profiles:** `release` / `debug` шарят port 8787 (одновременно работать не могут — second instance attach'ится к первому через mkdir-lock), `dev` (8788, Vite HMR) — параллельно ОК.
- **MCP:** все tools принимают optional `space?: string`. Resolver: explicit > CWD prefix match > `default` > ambiguous. Ambiguity error содержит только `id` + `label`, без absolute paths (privacy per spec §3 + §8.3).
- **Frontend multi-column (0.22.0+):** spaces landing page → `?cols=` URL syntax → multi-column layout с resizable splitters, active column tracking, within-column gallery↔room transitions.
- **UI:** tldraw editor — primary; shemma добавляет минимальный service-layer через `components`/`overrides`. См. Phase 2.1 spec §3.8.

## Key files (current)

- `docs/superpowers/specs/2026-05-14-di-draw-design.md` v3.7 — Phase 1 MVP (shipped).
- `docs/superpowers/specs/2026-05-15-di-draw-phase2-0-persistence-design.md` v1.2 — Phase 2.0 (shipped).
- `docs/superpowers/specs/2026-05-15-di-draw-phase2-agent-v2-design.md` v2.1.3 — Phase 2.1 (shipped).
- `docs/superpowers/specs/2026-05-16-di-draw-phase2-2-sync-hardening-design.md` v0.1 — Phase 2.2 (plan-ready, not executed).
- `docs/superpowers/plans/` — implementation plans, по одному на phase.
- `docs/decisions/` — ADRs (ADR-0001 Mermaid frontend-side).
- `CHANGELOG.md` — версии 0.0.1, 0.1.0, 0.2.0.
- `MEMORY.md` (auto-memory, в `~/.claude/projects/.../memory/`) — индекс активных memory-файлов.

## Current stage — Stabilization (testing + bugfix)

**Phase 2.2 SHIPPED как 0.3.0.** Новые фазы пока НЕ запускаем. Текущий режим — интенсивное тестирование + bug-fix из backlog.

**Где живут задачи:**
- **Backlog.md** (primary, с этого момента) — `backlog/tasks/` (gitignored, local-only), task prefix `DRW`. CLI + MCP-сервер `backlog`.
- **`docs/backlog.md`** (legacy) — справочник по немигрированным D2/D4-D11/B-T*/B-F*/P-2.x задачам. Новые задачи туда НЕ добавлять — только в Backlog.md.

## Task management — Backlog.md (обязательно)

**Все операции с задачами — через `backlog` CLI или MCP-сервер `backlog`.** Не редактировать `backlog/tasks/*.md` вручную (нарушает frontmatter consistency, ломает индексы / MCP / Web UI / branch-scanning).

**Команды:**
- **Создание:** `backlog task create "Title" --priority high|medium|low --labels "bug,critical" -d "Description" --ac "Criterion 1" --ac "Criterion 2" --modified-file "path/to/file" --plain`. После создания **переименовать файл** в формат `drw-NNN-short-name.md` (backlog по дефолту делает длинные имена по title; 2-3 слова после префикса достаточно — CLI продолжает работать).
- **Статус:** `backlog task edit DRW-NNN -s "In Progress"` / `"Done"`. Валидные: `To Do`, `In Progress`, `Done`.
- **AC / plan / notes:** `backlog task edit DRW-NNN --ac "..."` / `--plan "..."` / `--notes "..."` / `--final-summary "..."`.
- **Список / поиск:** `backlog task list --plain`, `backlog search "keyword" --plain`.
- **Board:** `backlog board` (TUI) или `backlog board export <path> --force` (markdown).
- **Архив:** `backlog task archive DRW-NNN` после завершения.

**Ограничения (backlog v1.45.1 hardcoded):**
- Имя файла — **только lowercase** в префиксе (`drw-001-foo.md`). Uppercase префикс (`DRW-001-foo.md`) ломает list/view/search.
- ID в frontmatter + CLI output — uppercase `DRW-001` (нормально).
- `taskPrefix` — read-only после `init`; смена только через удаление `backlog/` и `--task-prefix` при init.

**Исключение:** phase-level планы/specs остаются в `docs/superpowers/plans/` и `docs/superpowers/specs/`, НЕ дублируются в Backlog.md. Backlog — только независимые bug-fix / improvement задачи.

## How to execute (when phase mode resumes)

Запустить subagent-driven-development по утверждённому плану в отдельной feature-ветке:

```
git checkout -b feature/<phase-name>
/superpowers:subagent-driven-development
Plan: docs/superpowers/plans/<plan>.md
Spec: docs/superpowers/specs/<spec>.md
Start: Task 1
```

Skill спавнит свежий subagent на каждую задачу. **Review policy: phase-end only** — ни spec, ни quality review между задачами не делаем. Implementer-subagent коммитит каждую задачу, идём дальше. **В конце фазы** (после последней задачи плана): (1) `code-simplifier` agent проходит по diff'у фазы и упрощает, (2) затем единый full spec+quality review одним проходом, (3) fixes, (4) release commit + tag (числовой, без `v`), (5) merge feature-ветки в `main` через `--no-ff`. См. memory `feedback-batched-reviews`.

## Debug tooling

- **chrome-devtools MCP** — для visual verification UI.
- **bun test** — backend, CLI, client, domain (`bun run test` из корня — 1321 тестов в 5 packages). Frontend отдельно: `bun test --cwd apps/frontend src` — 206 тестов. Итого 1527+.
- **Playwright** — пока нет suite, но dependency установлен.

## Constraints (важно)

- **Не упрощай спеку**. Если что-то непонятно — спросить пользователя или зафиксировать в ADR, не "догадаться".
- **Cascade-delete, graceful shutdown, deep-merge для style/meta, echo-guard, pin discipline, atomic domain mutations + best-effort layout** — не оптимизации, а требования spec.
- **tldraw 5.x обязателен.** Проверять `https://tldraw.dev/docs/editor` ПЕРЕД написанием tldraw кода (см. memory `feedback-tldraw-docs`).
- **CLI — стабильный machine interface.** Меняешь output → обнови integration-тесты + `CHANGELOG.md`.
- **§3.8 UI design**: tldraw остаётся primary UI, наши элементы — service-layer через components/overrides API. Никаких произвольных `position:fixed` overlay'ев.
- **Commits:** только описание изменений; никаких `Co-Authored-By`/`Signed-off-by`/`Generated by` trailers (см. global `~/.claude/CLAUDE.md`).
- **Domain SSOT:** все Role/ConnectionKind/LayoutMode/presets из `@shemma/domain` package. Никаких локальных redeclaration в backend/frontend.
- **Element identity:** дуальная модель (DRW-134, 0.23.0+).
  - **Legacy v1 rooms** (без `meta.didrawProtocol === "v2"`): identity = `meta.didrawName` (string slug); tldraw shape ID = opaque random.
  - **v2 rooms**: identity = `meta.didrawId` (NodeId format `<slug>-<6char-base36>` или `e-<6char>` для anonymous), stable + immutable на весь lifetime shape'а. `meta.didrawLabel` — mutable display label. Overlay-layer addresses shapes via `didrawId`. Генерация: `generateNodeId` из `@shemma/domain`; backend использует crypto RNG (`generateNodeIdServer`).
- **Container model:** `Group.children: ElementId[]` каноничен; `meta.parent` на узлах НЕ пишется.
- **Pin/style ownership:** `meta.pinned + meta.position` и `meta.styleOwnedBy === "user"` — user-owned, AI не перетирает.
- **Daemon-safe room ops:** `flushIfDirty(id) → stat → op`; для restore — evict ПОСЛЕ rename.
