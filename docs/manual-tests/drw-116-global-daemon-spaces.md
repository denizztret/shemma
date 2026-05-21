# DRW-116 — Global daemon + spaces (Smoke matrix)

Version: 0.21.0 (pending)
Date: 2026-05-22
Plan: `docs/superpowers/plans/2026-05-21-global-daemon-spaces-plan.md`
Spec: `docs/superpowers/specs/2026-05-21-global-daemon-spaces-design.md`

Это финальный smoke-чеклист DRW-116 (Task 32). Структура: 8 сценариев из плана,
для каждого указан либо автотест, который покрывает его (run via `bun run test`),
либо ручные шаги, требующие chrome-devtools / реальный браузер.

Запускать после `bun run test` (зелёный suite) — перед release-коммитом 0.21.0.

---

## Scenario 1 — Fresh install: `shemma <path>`

Цель: чистая машина → `shemma <abs-path>` поднимает daemon, регистрирует space,
открывает браузер на `?space=<id>`.

**Автотесты (covered):**
- `packages/shemma-cli/tests/cli-top-level-path.test.ts::single path: registers space and emits ?space= URL` — register + URL format
- `packages/shemma-cli/tests/cli-spaces.test.ts::shemma s add::adds a space and lists it` — registry persistence

**Manual (browser):**

- [ ] Backup `~/.config/shemma/spaces.json` (если есть), `~/.claude/.shemma-port-*.lock/`.
- [ ] `rm -rf ~/.config/shemma/spaces.json ~/.claude/.shemma-port-*.lock/`
- [ ] `shemma ~/Projects/foo` — ожидаемо: daemon стартует на :8787, печатает `registered: <id>` + `URL: http://localhost:8787/?space=<id>`, автоматически открывает дефолтный браузер.
- [ ] В браузере: Gallery страница для space `<id>` рендерится с заголовком label = basename(`foo`); кнопка "New room" работает.
- [ ] Restore из backup.

---

## Scenario 2 — Daemon reuse

Цель: вторая попытка `shemma daemon start` на тот же port возвращает `already=true`
без spawn'а нового процесса.

**Автотесты (covered):**
- `packages/shemma-cli/tests/daemon-lock.test.ts::first start spawns daemon; second start returns already=true with same pid`
- `packages/shemma-cli/tests/daemon-lock.test.ts::acquires lock from stale daemon.pid with dead PID`
- `packages/shemma-cli/tests/daemon-lock.test.ts::recovers from lock dir without daemon.pid (parent crashed mid-acquire)`

**Manual (optional, redundant):**
- [ ] `shemma daemon start --profile release` → first call: spawns + healthy
- [ ] `shemma daemon start --profile release` → second call: `daemon already running (pid <N>, profile release, port 8787)`

---

## Scenario 3 — Multi: `shemma <p1> <p2>` → `?cols=`

Цель: два positional path → 2 space-регистрации + URL `?cols=<a>,<b>`.

**Автотесты (covered):**
- `packages/shemma-cli/tests/cli-top-level-path.test.ts::multiple paths: emits ?cols= URL with all ids`
- `packages/shemma-cli/tests/cli-top-level-path.test.ts::caps at 3 paths even if more provided`

**Manual (UI):**

- [ ] `shemma ~/foo ~/bar` — URL `http://localhost:8787/?cols=foo,bar`
- [ ] Browser: split-column layout, в каждой колонке независимая Gallery для своего space.
- [ ] Drag splitter — колонки меняют ширину; reload — ширины persist (localStorage).
- [ ] Click room в колонке A → колонка A переключается в App-view; URL push: `?cols=A:roomId,B`.
- [ ] Browser back → состояние восстановлено.

---

## Scenario 4 — MCP CWD → space resolution

Цель: запустить MCP-сервер с CWD внутри space-path → call `shape_define` без
`space` → резолвится в этот space.

**Автотесты (covered):**
- `apps/backend/src/migration/__tests__/migration-mcp-fallback.test.ts::MCP call without space resolves to default after legacy migration`
- `apps/backend/src/migration/__tests__/migration-mcp-fallback.test.ts::multi-legacy: most-recent becomes default; others are CWD-resolvable`
- `packages/shemma-cli/src/mcp.test.ts` — MCP space resolution unit tests

**Manual (optional):**

- [ ] `shemma s add ~/Projects/foo` (если ещё нет)
- [ ] `cd ~/Projects/foo`
- [ ] Запустить MCP-сервер (например через `claude mcp restart` после `shemma mcp install`)
- [ ] В Claude Code сессии: `shemma_define name=x role=service` без `space=` → выполняется в space, соответствующем CWD `~/Projects/foo`.

---

## Scenario 5 — Legacy migration

Цель: чистая install, но в `~/.claude/projects/<slug>/canvas/<room>.json` лежат
старые комнаты → migration создаёт `default` space (legacy layout) +
`legacy-<slug>` для остальных.

**Автотесты (covered):**
- `apps/backend/src/migration/__tests__/legacy-spaces.test.ts::registers a single legacy project as 'default'`
- `apps/backend/src/migration/__tests__/legacy-spaces.test.ts::registers multiple projects with most-recent as 'default'`
- `apps/backend/src/migration/__tests__/legacy-spaces.test.ts::is idempotent — second call doesn't add duplicates`
- `apps/backend/src/migration/__tests__/legacy-spaces.test.ts::ignores directories without canvas/ subdir`

**Manual (UI):**

- [ ] Backup `~/.config/shemma/spaces.json`.
- [ ] `rm ~/.config/shemma/spaces.json`
- [ ] Убедиться, что `~/.claude/projects/<some-slug>/canvas/<room>.json` существует.
- [ ] `shemma daemon start --profile release` → лог: `[migration] registered N legacy spaces`.
- [ ] `shemma s list` → видны `default` + `legacy-<slug>` записи с `storageLayout: "legacy"`.
- [ ] Browser: `http://localhost:8787/?space=default&room=<room>` → старая комната рендерится.
- [ ] Restore backup.

---

## Scenario 6 — Auto-skip migration (SHEMMA_SKIP_LEGACY_MIGRATION)

Цель: env-var **выставленная до spawn'а daemon'а** пропускает legacy scan
(для тестов / power-users).

**Автотесты (covered):**
- `apps/backend/src/migration/__tests__/legacy-spaces.test.ts::skip flag creates empty registry without scanning`
- `apps/backend/src/migration/__tests__/legacy-spaces.test.ts::no skip flag delegates to migrateLegacySpacesIfNeeded`

**Manual (optional):**

- [ ] `SHEMMA_SKIP_LEGACY_MIGRATION=1 shemma daemon start --profile release`
- [ ] `shemma s list --json` → `{"spaces": []}` (даже при наличии legacy projects).

---

## Scenario 7 — `--storage` deprecation

Цель: backward-compat — `--storage <path>` всё ещё работает, но печатает warning
и авто-регистрирует space с `storageLayout: "direct"`.

**Автотесты (covered):**
- `packages/shemma-cli/tests/cli-deprecation.test.ts::emits warning and auto-registers space on 'open --storage'`
- `packages/shemma-cli/tests/cli-deprecation.test.ts::emits warning on 'daemon start --storage'`
- `packages/shemma-cli/tests/cli-deprecation.test.ts::second 'daemon start --storage' on same path does not re-register (idempotent)`

**Manual (optional):**

- [ ] `shemma open --storage /tmp/legacy-storage --no-browser` → stderr содержит `--storage is deprecated` + `Auto-registered`.
- [ ] `shemma s list --json` → есть entry с `storageLayout: "direct"`, `path: "/tmp/legacy-storage"`.

---

## Scenario 8 — WS multi-space isolation (regression-критично)

Это пункт не из исходного списка 1-7, но плану важно валидировать что mutation в
(spaceA, roomFoo) не утекает в (spaceB, roomFoo) — основная архитектурная
инвариант DRW-116.

**Автотесты (covered):**
- `apps/backend/tests/ws-multi-space.test.ts::broadcast in (spaceA, roomFoo) does NOT reach a subscriber to (spaceB, roomFoo)`
- `apps/backend/tests/ws-multi-space.test.ts::WS upgrade rejected (400) with malformed ?space=`
- `apps/backend/tests/ws-multi-space.test.ts::WS upgrade rejected (400) with unknown ?space=`
- `apps/backend/tests/ws-multi-space.test.ts::WS upgrade without ?space= still succeeds (legacy compat)`

**Manual (UI):**

- [ ] Открыть `?space=A&room=r1` в Tab 1, `?space=B&room=r1` в Tab 2.
- [ ] В Tab 1 создать shape → в Tab 2 shape НЕ появляется.
- [ ] В Tab 2 создать другой shape → в Tab 1 он НЕ появляется.

---

## SpacesPage (root `/`)

UI-функциональность вне scope автотестов:

- [ ] Открыть `http://localhost:8787/` без query — рендерится SpacesPage со списком зарегистрированных spaces.
- [ ] Форма "Add space" принимает abs path, валидирует, после submit space появляется в списке.
- [ ] Клик по space → `/?space=<id>` (Gallery view).
- [ ] "Forget" кнопка убирает space с подтверждением.

---

## Acceptance

После прохождения чеклиста:

- [ ] `bun run test` — всё зелёное (baseline before release: 985 tests).
- [ ] Ни одного chrome-devtools error / unhandled rejection в браузере.
- [ ] `shemma doctor` (если применимо) — без warnings.

После приёмки — release-коммит + tag `0.21.0` + merge `feature/global-daemon-spaces` → `main` через `--no-ff`.
