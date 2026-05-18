## 0.12.1 — 2026-05-18 — Friendly dev-mode update hint

### Changed

- **`shemma update` в dev mode** теперь печатает actionable hint вместо однострочного refusal: предлагает `git pull && ./scripts/build-release.sh` для rebuild ИЛИ `./scripts/install.sh --version` для установки release binary. JSON mode сохраняет structured `code: "dev-mode-no-update"`.

---

## 0.12.0 — 2026-05-17 — Group B distribution

### Fixed

- **Placeholder distribution URLs** (DRW-059 B1) — `packages/shemma-cli/src/update.ts` и `apps/backend/src/update-check.ts` больше не указывают на `github.com/example/shemma`. По умолчанию fetch идёт через GitHub Releases API (`api.github.com/repos/denizztret/shemma/releases/latest`) — двухшаговый flow: `/releases/latest` → найти asset `release-manifest.json` → fetch его по `assets/<id>` с `Accept: application/octet-stream`. Это работает для private repo (через PAT) и public repo (anonymous).
- **`v$VERSION` tag convention** (DRW-059 B1) — `scripts/publish-release.sh` теперь ставит numeric tag `0.12.0` вместо `v0.12.0`, согласно `CLAUDE.md` (см. memory `feedback-gitflow-semver-tags`).
- **CHANGELOG → release notes** (DRW-059 B1) — `scripts/publish-release.sh` извлекает section `## <VERSION>` из `CHANGELOG.md` и передаёт через `gh release create --notes-file` вместо placeholder string. Если entry не найден — graceful fallback на `"Release X on channel Y"`.
- **`generate-manifest.sh` base URL** (DRW-059 B1) — default `MANIFEST_BASE_URL` теперь `github.com/denizztret/shemma/releases/download/<version>` (без `v` prefix). URLs в manifest informational — реальный download идёт через GitHub API.

### Added

- **PAT auth chain for private repo** (DRW-059 B2) — новый модуль `packages/shemma-cli/src/auth.ts` с функциями `readToken()` / `saveToken()` / `authHeaders()`. Precedence:
  1. `process.env.SHEMMA_GITHUB_TOKEN`
  2. `~/.config/shemma/auth.json` → `{ "github_token": "ghp_..." }`
  3. `gh auth token` (1.5s timeout, best-effort)
  4. null → anonymous fetch (works для public repo)
  Token persists с `chmod 600`. `Authorization: Bearer <token>` + `User-Agent: shemma-cli|shemma-backend` headers injected при fetch манифеста и binary asset.
- **`scripts/install.sh` — dual flow** (DRW-059 B2) — backwards-compatible new flag `--version <X>` запускает remote install из GitHub Release. Path A: `gh release download --repo denizztret/shemma` (если `gh` авторизован). Path B fallback: `curl + jq + PAT` (env `SHEMMA_GITHUB_TOKEN` или interactive prompt из `/dev/tty`). После successful Path B install token сохраняется в `~/.config/shemma/auth.json` (chmod 600) — последующие `shemma update` подхватят его автоматически. Дополнительные flags: `--repo <owner/name>` (override default `denizztret/shemma`). Default mode без `--version` остаётся как раньше (symlink на local pre-built binary).
- **Backend auth-aware `update-check`** (DRW-059 B2) — `apps/backend/src/update-check.ts` использует ту же auth chain (skipGhCli=true чтобы не блокировать request loop на 1.5s). Failure всё ещё silent (cache `latest=null`, `updateAvailable=false`).
- **Dev-mode version fallback** (DRW-059 B3) — `packages/shemma-cli/src/version-cmd.ts` теперь читает `packages/shemma-cli/package.json:version` когда `SHEMMA_VERSION` env не задан (или empty), добавляя суффикс `-dev` чтобы отличать source-run от compiled binary. `shemma version` показывает `shemma v0.12.0-dev [dev]` вместо legacy `shemma v[unknown]`. Banner (lifecycle.ts) уже использовал этот fallback с 0.11.0; consistency восстановлена.
- **Tests** — `packages/shemma-cli/tests/auth.test.ts` (11 unit-тестов на token precedence + chmod 600 + roundtrip), `tests/update-fetch.test.ts` (4 subprocess test'а на static-URL + auth header + 404), `tests/version-cmd.test.ts` (2 теста на dev fallback), `tests/install-script.test.ts` (4 bash smoke-теста на flags + remote-mode error paths). Backend: `tests/update-check.test.ts` (4 теста на static URL + auth + 404 + malformed JSON). Итого: CLI 114 → 135 (+21), backend 258 → 262 (+4).

### Changed

- **`packages/shemma-cli/src/update.ts`** — `fetchManifest()` теперь раздаёт два пути: static URL (`SHEMMA_MANIFEST_URL` указывает на JSON напрямую, для legacy / тестов) vs GitHub API URL (две hop'а). `downloadAndVerify(url, accept, sha256)` принимает Accept explicit для API path (`application/octet-stream`). Both inject PAT auth header когда token есть.
- **Default repo override** — обе точки (`update.ts` + `update-check.ts`) поддерживают `SHEMMA_GITHUB_REPO=<owner/name>` env override для форков и интеграционных тестов.

### Notes

- B4 (first publish) делает координатор отдельным шагом после merge этой ветки.
- Existing `SHEMMA_MANIFEST_URL` env override продолжает работать (треатается как static URL автоматически если не matches `api.github.com/repos/.../releases/`). Backward-compat: tests которые ставили manifest URL на in-process Bun.serve и раньше работают.

---

## 0.11.0 (Unreleased) — Group A CLI UX polish

### Added

- **Friendly CLI output** (DRW-056) — default `shemma <cmd>` теперь печатает human-readable формат с ANSI символами (✖ ошибка, ✔ успех, → действие, · info, ⚠ warning). Цвета добавляются только если `process.stdout.isTTY === true`; non-TTY pipes/redirects получают plain Unicode без escapes. Все error paths мигрированы через единый модуль `packages/shemma-cli/src/ui.ts`.
- **`--json` global flag** (DRW-056) — opt-in к machine-readable JSON output для agent / CI integration. Mode byte-identical с pre-0.11.0 behaviour (включая `{ ok: false, error, ...data }` shape на stderr для errors и raw response JSON на stdout для domain/rooms/data commands).
- **Startup banner** (DRW-057) — при `shemma` / `shemma open <room>` перед открытием браузера печатается multi-line banner: `shemma v<version> [<profile>] listening on http://localhost:<port>`, `storage: <abs path>`, `room: <id>`, `· daemon started|already running`, опционально `↑ update available: v<X.Y.Z>` (если `update-check` returns positive), `→ opening <URL>` (если не `--no-browser`). Banner suppressed в `--json` mode.
- **Interactive prompt for missing `.shemma/`** (DRW-058) — при `shemma` zero-arg launch если `.shemma/` отсутствует в `cwd` И не задан `--storage`/`SHEMMA_STORAGE_DIR`, CLI делает: (а) **TTY** (`process.stdin.isTTY && process.stdout.isTTY`) — printout 3-option меню `[1] Create .shemma/ here`, `[2] Specify storage path`, `[3] Cancel`; (б) **non-TTY** (CI / piped / agent invocations) — fail-fast с понятным hint'ом и exit 1. Explicit `--storage` / env path → skip check. Existing `.shemma/` → silent reuse (как было).
- **`shemma init [<path>]` command** (DRW-058 bonus) — non-interactive bootstrap: создаёт `.shemma/` в `cwd` или указанном path, печатает `✔ initialized .shemma/ in <path>` (human) или structured JSON в `--json` mode. Идемпотентно.
- **Tests** — `packages/shemma-cli/tests/ui.test.ts` (22 unit tests на formatter helpers, TTY/non-TTY/JSON modes), `tests/storage-interactive.test.ts` (8 tests на non-TTY fail-fast + `shemma init`), `tests/banner.test.ts` (4 tests на banner content / suppression). Existing tests адаптированы — добавлен `--json` flag в subprocess invocations (`zero-arg-open`, `domain`, `data`, `lifecycle.http`, `room-flag`, `ps`, `daemon-storage-flag`, `doctor`). Total CLI tests: 80 → 114.

### Changed

- **CLI output structure (default mode):** все existing `console.log(JSON.stringify(...))` paths в `lifecycle.ts`, `daemon.ts`, `data.ts`, `domain.ts`, `ai.ts`, `prompts.ts`, `ps.ts`, `doctor.ts`, `update.ts`, `version-cmd.ts`, `logs.ts`, `util.ts` мигрированы через `ui.success` / `ui.error` / `ui.info` / `ui.printResponse`. **Breaking для скриптов**, которые парсили stdout без `--json` — нужно добавить `--json` flag или migrate на human-grepable output.
- **`die()` / `fail()` helpers** — теперь используют `ui.error()` вместо raw `console.error(JSON.stringify(...))`. Connection-refused errors получают дополнительный hint `→ is the daemon running? try 'shemma daemon start'`.
- **`shemma daemon status`** в human mode печатает `✔ daemon running (pid X, profile Y, port Z)` или `· daemon not running (profile Y, port Z)` вместо raw JSON pretty-print.
- **Usage block** — добавлены строки `shemma init [<path>]` и `--json` в `shemma --help`.

### Notes

- ANSI escapes реализованы raw (`\x1b[31m...\x1b[0m`) без deps: zero-dep matches madstudio approach.
- В `--json` mode `info()` сообщения silenced (decorative для human только).
- Domain command responses (`/api/domain`) в `--json` mode выводят raw JSON на stdout, в human mode — только `✔ ok` / `✖ error`. User может pipe `--json` в `jq` для structured queries.

---

## 0.10.0 — 2026-05-18 — Renamed to Shemma

### Changed (breaking — mechanical rename)

- **Project rename:** `didraw` → `shemma` на всех уровнях, кроме internal persistence keys (`meta.didrawName`, `meta.didrawIsGroup`, backend `didrawIndex`) — они остаются для backward compatibility existing room JSON envelopes.
- **CLI binary:** `didraw` → `shemma`. Создан wrapper `~/.local/bin/shemma`. Старый `~/.local/bin/didraw` оставлен как пользовательский machine state — можно удалить вручную (`rm ~/.local/bin/didraw`) после re-source shell.
- **Packages:** `@didraw/backend` → `@shemma/backend`, `@didraw/frontend` → `@shemma/frontend`, `@didraw/client` → `@shemma/client`, `@didraw/domain` → `@shemma/domain`. CLI package: `didraw` → `shemma`. Root: `didraw-root` → `shemma-root`.
- **Directories:** `packages/didraw-cli/` → `packages/shemma-cli/`, `packages/didraw-client/` → `packages/shemma-client/`, `packages/didraw-domain/` → `packages/shemma-domain/`. Renamed через `git mv` для preservation истории.
- **Storage folder convention:** project-local `.didraw/` → `.shemma/` (cwd auto-discovery). Existing `.didraw/` directories продолжат работать только если user задаёт `--storage <path>` явно. Recommended migration: `mv .didraw .shemma` в проектах где используется.
- **Daemon log/pid files:** `~/.claude/.didraw-<profile>.pid|log` → `~/.claude/.shemma-<profile>.pid|log`. Запущенный 0.9.x daemon следует остановить через `didraw daemon stop` ДО update, иначе orphan pid file.
- **Log prefix:** `[didraw]` → `[shemma]` во всех stdout/stderr lines.
- **Env vars:** `DIDRAW_STORAGE_DIR` → `SHEMMA_STORAGE_DIR`, `DIDRAW_PROFILE` → `SHEMMA_PROFILE`, `DIDRAW_PORT`, `DIDRAW_LOG_LEVEL`, `DIDRAW_LOG_MAX_MB`, `DIDRAW_MANIFEST_URL`, `DIDRAW_VERSION`, `DIDRAW_CHANNEL`, `DIDRAW_GIT_SHA`, `DIDRAW_BUILD_DATE`, `DIDRAW_GRACEFUL_SHUTDOWN_MS`, `DIDRAW_BIN`, `DIDRAW_CROSS_WORKSPACE` — все получили префикс `SHEMMA_`.
- **Browser-side helper:** `window.didrawImportMermaid()` → `window.shemmaImportMermaid()` (DEV-console).
- **Envelope schema field:** JSON envelope `shemma: { shemmaVersion, createdAt }` (раньше `didraw: { didrawVersion, createdAt }`). `parseFull()` принимает оба варианта (forward-compat для existing files), serialize пишет новый формат.

### Legacy compatibility layer (single-version backfill)

- Backend `apps/backend/src/config.ts` читает `SHEMMA_*` → fallback на `DIDRAW_*` с deprecation warning `[shemma] DIDRAW_FOO is deprecated; use SHEMMA_FOO instead`. Это **single legacy compat layer** — user может не успеть переписать свои скрипты.
- CLI `packages/shemma-cli/src/profile.ts` — same fallback для `SHEMMA_PROFILE` / `SHEMMA_PORT`.
- CLI `packages/shemma-cli/src/lifecycle.ts:open()` — `SHEMMA_STORAGE_DIR` → `DIDRAW_STORAGE_DIR` fallback.
- CLI `packages/shemma-cli/src/doctor.ts` — `SHEMMA_VERSION` → `DIDRAW_VERSION` fallback в version check.
- **Removed в 1.0.0.** До этого момента старые env vars работают, но warn'ятся.

### Preserved (no rename, by design)

- **`meta.didrawName`** на shapes — internal persistence key. Rename без backfill сломает existing rooms. Marked TODO в `apps/frontend/src/canvas/id-prefix.ts:getDidrawName`.
- **`meta.didrawIsGroup`** — same reason.
- **Backend `RoomState.didrawIndex` + `rebuildDidrawIndex` / `findShapeByDidrawName`** — internal identifiers связанные с `didrawName` key.
- **Historical files:** `docs/superpowers/specs/*.md`, `docs/superpowers/plans/*.md`, `backlog/tasks/drw-*.md` — не тронуты как historical record.
- **Backlog task prefix `DRW-`** — hardcoded в Backlog.md v1.45.1 tooling.
- **Git history** — commit messages не переписаны.

### Migration (user-facing)

1. `rm ~/.local/bin/didraw` (старый wrapper), убедиться что `which shemma` указывает на `~/.local/bin/shemma`.
2. Если используешь env vars в shell rc / CI: заменить `DIDRAW_*` → `SHEMMA_*` (старые работают до 1.0.0 с warning).
3. Если используешь project-local `.didraw/` storage: `mv .didraw .shemma` в каждом проекте.
4. Перезапустить daemon если был запущен (`didraw daemon stop` потом `shemma`).

---

## 0.9.0 — 2026-05-17 — Project-local `.didraw/` storage + zero-arg launch + Mermaid import UI

### Added

- **Mermaid import UI** (DRW-053) — modal-overlay для импорта Mermaid-диаграмм через GUI без захода в DEV-console. `Cmd+M` (Ctrl+M на не-mac) открывает full-overlay modal с textarea (auto-focus), кнопками `Render` / `Cancel`, hotkey'ями `Esc` = Cancel, `Cmd/Ctrl+Enter` = Render. Successful render → modal закрывается, диаграмма отрисована на canvas. Parse-error → error message в modal, modal остаётся открытым с тем же текстом для исправления. Дополнительно: кнопка `M` в нижнем tldraw toolbar (`components.Toolbar` override через `DefaultToolbar` wrap) для discoverability. На root frame'е импортированной группы сохраняется `meta.mermaidSource: string` — foundation для future edit UI. Auto-suffix дубликатов через `didrawName` сохранён (как раньше). DEV-console helper `window.didrawImportMermaid(source)` оставлен для debugging. Файлы: `apps/frontend/src/mermaid/MermaidImportModal.tsx` (new), `apps/frontend/src/chrome/TldrawComponents.tsx` (Toolbar override), `apps/frontend/src/canvas/mermaid-import.ts` (sourceTargetIds + meta.mermaidSource), `apps/frontend/src/App.tsx` (Cmd+M handler + modal mount). 5 новых тестов в `mermaid-import.test.ts` покрывают tagging logic.
- **`didraw` zero-arg launch** (DRW-052) — `didraw` без аргументов: ensures daemon на `<cwd>/.didraw/` storage + opens browser на `?room=default`. Multi-project independence теперь visible: user видит "доски этого проекта живут в `.didraw/`" вместо invisible `~/.claude/projects/<slug-hash>/canvas/`. Storage precedence: `--storage <path>` > `DIDRAW_STORAGE_DIR` env > auto-cwd `.didraw/`. Profile-specific subdir сохраняется внутри (`canvas/` для release/debug, `canvas-dev/` для dev).
- **`didraw open [<room>]`** — explicit form с optional room override. Без аргумента room → `default`. С аргументом — override.
- **`--no-browser` flag** — для CI/testing/headless flow'ов. Daemon ensures + JSON success-payload без attempt'а spawn'нуть browser.
- **`GET /api/health`** — extended health endpoint, возвращает `{ ok, profile, storage, version }`. Используется `didraw open` для daemon-conflict detection: если daemon уже запущен на ДРУГОМ storage → exit 1 с structured JSON `{ ok:false, error:"daemon-conflict", running, target, profile }` + human-readable hint `daemon already running on storage "X"; expected "Y". Run 'didraw daemon stop' first.`. Legacy `/healthz` (boolean probe) — preserved для `CanvasClient.health()` + Playwright wait-on.
- **`CanvasClient.getHealth()`** — typed wrapper над `/api/health`. Returns `null` если daemon unreachable.
- **CLI helpers** — `packages/didraw-cli/src/browser.ts:openBrowser(url)` (cross-platform launcher: `open`/`start`/`xdg-open`); `packages/didraw-cli/src/storage.ts:resolveStorageForOpen(opts, cwd, env, profile)` (pure precedence resolver); `packages/didraw-cli/src/ps.ts:getRunningDaemonStorage(profile)` (HTTP probe для daemon discovery).

### Changed

- **`apps/backend/src/routes/health.ts`** — exports `makeHealthRoutes(storageDir)` factory вместо singleton-а; `apps/backend/src/index.ts` пробрасывает actual `storageDir` из `makeApp` opts, чтобы in-process test daemons и `--storage` flag репортили правильный path (а не ambient `config.storageDir`).

### Notes

- Legacy rooms в `~/.claude/projects/<slug-hash>/canvas/` остаются доступными через `DIDRAW_STORAGE_DIR=…` или `--storage`. Auto-migration НЕ делаем (per spec out-of-scope).
- Tests: backend `routes-health.test.ts` (3 new tests); client `getHealth` (2 new tests); CLI `zero-arg-open.test.ts` (6 new subprocess tests) + `storage.test.ts` (6 new `resolveStorageForOpen` unit tests). Total deltas: backend 255 → 258 pass, client 4 → 6 pass, CLI 68 → 80 pass (12 new = 6 unit + 6 integration). Root `bun test`: still green.

---

## 0.8.0 — 2026-05-17 — Backlog cleanup + simplification sweep

Накопительный stabilization-релиз поверх 0.7.2: 4 backlog задачи (DRW-012/018/022/023) + сквозной code-simplifier pass по diff'у `0.3.3..HEAD` (Phase 3.0+). Без новых фаз.

### Added

- **`didraw daemon start --storage <path>`** (DRW-022) — CLI флаг для project-local storage без `export DIDRAW_STORAGE_DIR=…` + manual restart. Path может быть абсолютным или относительным к cwd; резолвится перед spawn'ом child process'а. Под user-provided path сохраняется profile-specific subdir convention: `<path>/canvas/` для `release`/`debug`, `<path>/canvas-dev/` для `dev` — параллельные daemons на одном `--storage` пути не конфликтуют по rooms. Path auto-`mkdir -p`; non-creatable path → JSON error в stderr + exit 1. Explicit `--storage` overrides ambient `DIDRAW_STORAGE_DIR`. Daemon startup log теперь печатает финальный `[didraw] storage: <path>`. CLI success-output дополнен полем `storage` когда флаг задан.
- **CLI helper module `packages/didraw-cli/src/storage.ts`** — pure-functions `parseStorageArg(argv, cwd)`, `resolveStorageDirForProfile(base, profile)`, `ensureStorageDir(path)`. 11 новых unit-тестов + 4 integration через subprocess CLI.

### Fixed

- **tsc-strict cleanup in `apps/backend/tests/`** (DRW-012) — `bunx tsc --noEmit` теперь чист по тестам: non-null assertion на `body.rooms[0]!.id` после `toHaveLength(1)` в `routes-rooms.test.ts`; `toEqual(V2_SCHEMA as any)` для V2-формы schema в `ws-protocol.test.ts` (TLSchemaDef требует `storeVersion`/`recordVersions`, которых у V2 нет by design). Тесты поведения не меняли, `bun test` 255 pass / 0 fail. Pre-existing src/ error в `src/domain/layout.ts:280` (`Required<LayoutHint>` vs optional `affectedIds`) оставлен — out of scope DRW-012.
- **Root `bun test` cleanup: isolate Playwright suite** (DRW-023) — `apps/frontend/tests/golden.spec.ts` переименован в `golden.pw.ts`; `apps/frontend/playwright.config.ts` теперь использует `testMatch: /.*\.pw\.ts$/`. Bun test auto-discovery (по дефолту ищет `*.test.ts` / `*.spec.ts`) больше не подхватывает playwright-spec'и и не падает на `Playwright Test did not expect test() to be called here`. Root `bun test`: 428 pass / 0 fail / 0 error (было 1 fail + 1 error из-за этого файла). Playwright runner (`bunx playwright test`) продолжает находить suite по новой маске.

### Changed

- **Frontend: pause inbound WS during truncated-recovery** (DRW-018) — `apps/frontend/src/transport/ws.ts:setPaused(p)` API на handle'е от `startStoreSync`. `App.tsx onTruncated` вызывает `setPaused(true)` перед `seedSchema`+`getState`+`loadSnapshot`, после успешного apply — `setPaused(false)`. Inbound `replay`/`store-change` фреймы дропаются пока paused; `sync-ack`/`truncated`/`prompt`/`ai-activity` продолжают идти. Outbound user mutations не блокируются — пользователь может рисовать во время recovery. Устраняет flicker от straggler-патчей. 5 новых тестов в `ws.test.ts`.

### Internal

- **Code-simplifier pass по diff `0.3.3..HEAD`** — 9 refactor commits, net `-162 LOC` across 13 файлов без изменения поведения. Извлечены DRY helpers: `makeArrowShape`/`makeArrowBindings` (compile.ts), `fetchAndLoadSnapshot` (App.tsx hydrate/recovery), `findRoomFile` (routes/rooms.ts), `isEmptyBatch` (store-ops.ts), `die`/`printAndExitOnFail`/`dieRequireFlag` (CLI usage errors), `writeLines` (logs command). Удалены unused store-types helpers + dead layout flag + unused envelope re-export. `runLayout`/WS protocol/migrate-v2 — намеренно НЕ трогали (correctness-sensitive). 428 tests pass, tsc clean.

---

## 0.7.2 — 2026-05-17 — Backend seed-schema endpoint + drop App.tsx schema workaround

Закрывает class of bugs типа DRW-046 — arrow.kind drift и прочие миграции tldraw 5.x — за счёт того, что backend получает реальную V2-схему ДО первого `GET /api/state`, а не уже в момент WS hello. Frontend больше не подменяет схему в `loadSnapshot`. DRW-047.

### Added

- **`POST /api/state/seed-schema?room=...`** — клиент аплоадит свою V2 schema до initial `GET /api/state`. Idempotent: если room уже имеет реальную (не placeholder) schema — `{ ok:true, upgraded:false }` без перезаписи. Body validation: `schema` must be non-null object, иначе 400 `schema-required`. Mirrors WS hello upgrade path (`ws-protocol.handleHello`).
- **`@didraw/frontend.seedSchema(room, schema)`** в `apps/frontend/src/transport/api.ts` — best-effort помощник, вызывается перед `getState()` в обоих местах (`hydrateAndSync` initial + `onTruncated` recovery).

### Removed

- **`apps/frontend/src/canvas/schema-placeholder.ts:isPlaceholderSchema`** — больше не нужен после переноса проверки на backend.
- **`App.tsx` schema override branch** — `isPlaceholderSchema(s.store?.schema) ? { ...snapshot, schema: editor.store.schema.serialize() } : ...`. Snapshot теперь всегда грузится как есть.

### Notes

- `backfillStoreRecords` (arrow `kind: "arc"` backfill для legacy 0.4.x rooms) сохранён — это независимая защита от data drift и не связана с placeholder schema upgrade.
- Tests: 369+ pass (255 backend + 58 domain + 52 cli + 4 client) + 6 новых `routes-state-seed-schema.test.ts` (fresh upgrade, idempotent repeat, missing/null/string schema → 400, invalid room → 422).

---

## 0.7.1 — 2026-05-17 — Gallery action row hotfix

- Gallery `RoomCard` action row теперь в одну строку (`flex-wrap: nowrap`) с компактным padding `3px 8px`.

---

## 0.7.0 — 2026-05-17 — Gallery UX polish: inline rename + click-to-open + auto-suffix duplicate + SVG thumbnails

User-driven UX improvements после первого реального использования Gallery.

### Added

- **SVG thumbnail preview** в RoomCard (DRW-051, supersedes deferred DRW-030). Новый `apps/backend/src/thumbnail.ts:renderThumbnail(snapshot, w, h)` — pure SVG string из TLStoreSnapshot (no `@tldraw/*` import). Поддерживает geo (rect/ellipse/diamond), note (yellow rect), text/frame (placeholder rects), arrow (line), draw/line/highlight (polyline approximation). Bounding box auto-fit + padding. Empty store → "Empty" centered.
- **`GET /api/rooms/:id/thumbnail?w=240&h=160&archived=true`** возвращает `image/svg+xml`. Lazy load в RoomCard через `<img loading="lazy">`; onError fallback на "📐 N elements" текст.
- **`POST /api/rooms/:id/duplicate-auto`** — server-side picks first available `<id>-copy`, `<id>-copy2`, ..., атомарно проверяя active + archived. Single roundtrip.
- **`@didraw/client.duplicateAuto(id)`** + **CLI `didraw rooms duplicate <id>`** (без `--as`) теперь auto-suffix. С `--as` остаётся явный override.
- **`/api/session` response field `home`** (от `os.homedir()`) — frontend использует для `~/` prefix path display.

### Changed

- **Gallery card UX** (DRW-048):
  - Title теперь interactive button → click → open room (заменяет старую Open кнопку).
  - Click на thumbnail preview → open room.
  - Open button удалена из action row (action row: Archive / Export / Rename / Duplicate для active; Restore / Delete permanently для archived).
  - Rename теперь inline editing в самом заголовке: click Rename → title заменяется на `<input>` с current name pre-filled (autoFocus). Enter → submit; Esc/Blur → cancel.
- **Gallery header** (DRW-050): workspace path с `~/` prefix если matches `home`. Truncation удалена (`word-break: break-all` вместо ellipsis). `title` attribute хранит full absolute path.
- **Archived cards** (DRW-049): Duplicate button удалена (дубликат archived → confusing UX).

### Removed

- `apps/frontend/src/gallery/InlineRoomForm.tsx` — стал obsolete (Rename → inline title editing; Duplicate → auto-suffix one-click).

### Tests

363 pass (+9 vs 0.6.2 baseline 354). Added: thumbnail snapshot tests (5 cases — empty, known geo+arrow+note, ellipse, diamond, frame); duplicate-auto routes (3 cases — happy path, collision → -copy2, 404 missing source).

### Notes

- Tests не покрывают UI interactions (нет Playwright suite — DRW-023 deferred).
- `RoomCard` поведение verified manually в chrome-devtools: thumbnail render, click-open, rename inline, duplicate auto, `~/` prefix.

---

## 0.6.2 — 2026-05-17 — Hotfix: arrow.props.kind for tldraw 5.x schema drift

Found via 0.6.1 re-smoke: existing rooms с AI-created arrows не загружались (ValidationError "props.kind: Expected arc or elbow, got undefined"). tldraw 5.x runtime требует `kind` на arrow shapes; наш backend этого не писал.

### Fixed (partial — new arrows only)

- **Backend**: `kind: "arc"` (tldraw 5.x default) добавлен во все три места создания arrow records: `apps/backend/src/migrate-v2.ts:edgeToArrow` + `apps/backend/src/domain/compile.ts` (connect + note-about branches). Все NEW arrows (через CLI/AI/migration) теперь содержат корректный prop.
- **Frontend**: `apps/frontend/src/canvas/schema-placeholder.ts` экспортирует `backfillStoreRecords(store)` который добавляет `kind: "arc"` к arrow records если field отсутствует. Используется в `App.tsx` обоих местах loadSnapshot (hydrateAndSync + onTruncated recovery). Idempotent для already-fixed records.

### Known limitation

**Existing 0.4.x-0.6.1 rooms с AI arrows всё ещё broken** — iterative discovery нашёл что tldraw 5.x также требует `elbowMidPoint`, удаление legacy `text`, `binding.props.snap` и потенциально других missing props. Полная migration не вошла в этот PATCH — отдельная задача **DRW-046** (recommended approach: one-shot migration script для existing envelopes).

**Workaround:** создавать FRESH rooms через Gallery → они работают end-to-end. Legacy rooms (cloned, test-phase3, default и т.д.) — нужны до DRW-046 fix либо ручной archive/recreate.

### Tests

354 pass (без изменений — backend и frontend unit-тесты на existing формат не падают; legacy room loading требует integration test что не входит в этот hotfix scope).

---

## 0.6.1 — 2026-05-17 — 0.6.0 smoke bugfix (DRW-041..045)

5 bugs закрыты одним sub-agent commit'ом после manual smoke test 0.6.0.

### Fixed

- **DRW-041 (HIGH)** — Gallery Archived tab filter broken. `apps/frontend/src/gallery/Gallery.tsx`: archived grouping теперь применяет `rooms.filter(r => r.archived === true)` перед `sortRooms`. Counter `(N)` derives from filtered length и автоматически корректен. Current tab уже скипал archived через `continue` — без изменений.
- **DRW-042 (MEDIUM)** — `didraw ps` показывал port текущего профиля для всех 3. `packages/didraw-cli/src/ps.ts`: добавлен local `PORT_BY_PROFILE` map + `portForPs(p)` helper. Для non-current profile — static map (env override unknowable cross-process); для current — delegates `portFor(p)` чтобы honour `DIDRAW_PORT`.
- **DRW-043 (LOW)** — `packages/didraw-cli/package.json:version` залип на `0.0.1` с MVP. Bumped → `0.6.1` синхронно с root.
- **DRW-044 (LOW)** — `didraw doctor` false-negatives на ad-hoc dev daemon. Три sub-fix'а в `doctor.ts`:
  - `checkDaemonStatus`: после pidfile check ставит HTTP probe (`isHealthy(port)`); если 200 OK → `ok "running (ad-hoc, no pidfile) on :PORT"`.
  - `checkPortOwner`: probes health сначала; если port healthy (ad-hoc case) → `ok "port not checked (daemon ok)"`. Только если pid-tracked daemon unhealthy — fall through to lsof.
  - `checkStorageWritable`: `mkdirSync(storageDir, { recursive: true })` перед `writeFileSync`. ENOENT больше не false-fail.
- **DRW-045 (MEDIUM)** — "← Gallery" link не кликался (overlapped). Root cause: tldraw `.tlui-layout` has `pointer-events: none` на root container; children must restore it. `chrome/TldrawComponents.tsx`: wrapper получил `className="tlui-share-zone"` (mirror tldraw's `DefaultSharePanel` class) + inline `pointerEvents: "all", zIndex: 300`. §3.8 (no fixed overlays) сохранён — компонент остаётся в SharePanel slot.

### Tests

354 pass (+3 vs 0.6.0 baseline 351). New: `ps per-profile port` (2 cases), `doctor storage mkdir` (1).

---

## 0.6.0 — 2026-05-17 — D phase: CLI DX (ps, logs, doctor, --debug, install)

### Added

- **`didraw ps`** — single command shows daemon status across all profiles (dev/release/debug). Returns JSON array `[{profile, port, pid?, running, healthy}]`. Exit 0 always (даже если ничего не работает — пустой массив).
- **`daemon stop --all`** — kills daemon across all 3 profiles, idempotent (`already-stopped` ok). Если `--profile <p>` тоже передан — stops только этот.
- **`didraw logs [--profile|--all] [--tail N] [--follow]`** — читает daemon log из `~/.claude/.didraw-<profile>.log`. `--follow` через 200ms poll loop (cross-platform reliable). `--all` префиксует каждую line `[<profile>] `. Exit codes 0/1/2 (ok/usage/file-not-found).
- **`didraw doctor [--profile|--all] [--json]`** — read-only self-diagnostic. 7 checks: bun-version, didraw-version, daemon-status, port-owner (через lsof, graceful skip если не установлен), storage-writable, manifest-reachable (timeout 3s), config-readable. Human output с per-check `[ok|warn|fail]` + summary; `--json` для machine consumption. Exit 0 если no fails (ok/warn allowed), 3 если any fail. Каждый fail имеет `hint` что делать.
- **`--debug` top-level flag** — shortcut для `--profile debug`. Не меняет порт (debug использует release-port 8787, отличается verbose log level).
- **`scripts/install.sh`** — bash symlink installer. Default `$HOME/.local/bin/didraw`, override через `--prefix=<dir>`. Auto-detects binary для текущего OS/arch. Напоминает добавить prefix в PATH если ещё нет.

### Changed

- **`daemon.ts:start()`** теперь захватывает stdout/stderr через `stdio: ['ignore', fd, fd]` где `fd = openSync(logPath, 'a')`. Раньше было `stdio: 'ignore'` — весь output терялся. Rotation single-level через `DIDRAW_LOG_MAX_MB` (default 10) → `.log.1`.
- **`usage()` cleanup:** удалён phantom `import mermaid` command (Mermaid живёт в frontend per ADR-0001); stale `didraw list/export/rm` заменены на `rooms list/export/rm`; `layout --algorithm` → `layout --mode`. README CLI Reference синхронизирован.

### Tests

351 pass (+19 от 0.5.0 baseline 332): CLI `ps.test.ts` (3), `logs.test.ts` (5), `doctor.test.ts` (8), плюс integration assertions.

### Refactor

Post sub-agent simplifier pass (commit `2be1d8b`):
- `logs.ts`: removed dead `if (all && opts.profile !== "release") {}` placeholder; collapsed two identical exit-2 branches.
- `doctor.ts`: replaced inline `require("node:crypto")`/`require("node:path")` IIFE с proper top-level ESM imports.
- `index.ts`: extracted `assertNotAllWithProfile()` helper (был copy-pasted для logs + doctor).

### Concerns

- `lsof` based `port-owner` check может silently `warn` если lsof не установлен. Workaround: macOS pre-installs; Linux usually too; corp Linux может потребовать `apt install lsof`.
- `manifest-reachable`: `DIDRAW_MANIFEST_URL` unset → `warn` (not fail). Offline / corp proxy → также `warn`. Никогда не блокирует exit 0.

---

## 0.5.0 — 2026-05-17 — E phase: Rooms Gallery + delete policy + rename/duplicate

Multi-task initiative shipping a full web UI каталог комнат с группировкой, фильтрами, lifecycle actions, и опт-ин linked-session safety. 8 tasks closed (DRW-029, 031, 033, 034, 035, 036, 037, 039) + 2 deferred (DRW-030 thumbnails, DRW-038 auto-archive — оба с notes для возобновления).

### Added — Rooms Gallery UI (DRW-029)

- **`/` (no `?room=`) и `?view=gallery` рендерят Gallery** вместо fallback на `room=default`. Существующий `?room=<id>` flow preserved.
- **Группировка:** "Current workspace" (rooms где `linkedSession` совпадает с current OR пуст) и "Past sessions" (linked to другой сессии). Внутри каждой группы — sort toggle "recent first" / "name A→Z".
- **Tabs:** Current workspace / Archived. "All workspaces" tab скрыт (DRW-032 deferred).
- **Per-card actions:** Open / Archive / Restore / Export / Delete / Rename / Duplicate. На archived cards Delete заменяется на "Delete permanently" (mode='hard' с confirm), Rename hidden.
- **5s undo toast** после archive (через `pushError`/local toast state — pure timer + abort flag, без timer libs).
- **"New room" form** — inline input + `validateRoomId` (regex mirror) → redirect на `/?room=<id>`.
- **"← Gallery" button** в editor chrome (рядом с RoomBadge), компонент `chrome/GalleryLink.tsx`.
- **Linked badge** на card если `linkedSession === current sessionId` (через `/api/session`).
- **Placeholder preview** ("📐 N elements") — actual thumbnails defer to DRW-030.

### Added — Backend endpoints (DRW-031, DRW-037, DRW-039)

- **`GET /api/session`** → `{ sessionId, projectSlug, workspaceDir }` — env capture at config load.
- **`GET /api/rooms?include=archived`** — joins `.archive/` items с `archived: true` flag.
- **`GET /api/rooms` items** теперь несут `linkedSession?`, `projectDir?`, `projectName?` (basename of `projectDir`).
- **`DELETE /api/rooms/:id`** принимает `{ confirm, mode?: 'archive' | 'hard', force? }`. Default `mode: 'archive'`. `mode: 'hard'` + linked-to-active-session без `force` → 409 `linked-to-active-session`.
- **`POST /api/rooms/purge-archive { confirm: true }`** — bulk hard unlink всех файлов в `.archive/`.
- **`POST /api/rooms/:id/rename { to, force? }`** — atomic flush → evict → fs rename → envelope `roomId` mutation. 409 на конфликт без force, 422 на archived/invalid.
- **`POST /api/rooms/:id/duplicate { as }`** — copy file + reset `opLog` + `version: 1` + clear `linkedSession`. 409 на конфликт.

### Added — CLI commands

- **`didraw rooms rename <old> <new> [--force]`**
- **`didraw rooms duplicate <id> --as <newId>`**
- **`didraw rooms purge-archive --confirm`**
- **`didraw rooms rm <id> --hard --force --confirm`** — bypass linked-check 409 (для linked rooms). `rooms rm` без флагов остаётся hard delete (ADR-0003 Variant A, no breaking change).

### Added — `@didraw/client`

- `getSession()`, `renameRoom(id, to, opts?)`, `duplicateRoom(id, as)`, `purgeArchive()`. `deleteRoom(id)` расширен опциональным вторым аргументом `{ mode?, force? }`.

### Added — Frontend transport

- `apps/frontend/src/transport/session.ts` — `fetchSession()` с tab-scoped cache.
- `apps/frontend/src/transport/api.ts` — `listRooms({includeArchived})`, `archiveRoom`, `restoreRoom`, `exportRoom`, `deleteRoom(id, opts?)`, `renameRoom`, `duplicateRoom`, `purgeArchive`.

### Decisions (closed via this release)

- **ADR-0003** (`docs/decisions/0003-rooms-delete-policy.md`) — layered delete: archive default in UI/API, hard delete explicit; implicit linkage detection через `roomId === CLAUDE_SESSION_ID`; CLI `rooms rm` остаётся hard (Variant A).
- **DRW-032 (cross-workspace):** Variant A — opt-in только через env `DIDRAW_CROSS_WORKSPACE=1`. Implementation deferred to 0.5.x.
- **DRW-033 (project name):** В Claude Code projects нет manifest файла; храним `Room.meta.projectDir` сами, `projectName = basename(projectDir)`.
- **DRW-034 (CLI rm):** stays hard, no breaking change (within ADR-0003 §"CLI semantics").
- **DRW-035 (linkage):** implicit only для MVP; explicit `rooms link` — future.

### Deferred from 0.5.0

- **DRW-030** thumbnails — placeholder shipped; real thumbnails (client-side hidden-editor render → base64 → backend cache) deferred. 2-3 hour follow-up task.
- **DRW-038** auto-archive stale rooms — deferred until user pressure ("Gallery захламлена"). ADR-0003 уже отметил retention policy как future ADR.

### Tests

332 pass (+12 от 0.4.2 baseline 296 + 24 за E phase: backend session, rooms-delete-policy, rooms-rename-duplicate, gallery archived-list, projectDir; CLI rename/duplicate subprocess integration; humanize/validate unit utilities в frontend через `bun --cwd apps/frontend test` — не в root suite, frontend test infra ещё TODO).

### Refactor

Post sub-agent simplifier pass (commit `ee20a8a`):
- Extracted `writeAtomic(path, data)` helper в `routes/rooms.ts` (был duplicated в rename/duplicate handlers).
- Extracted `readdirOrEmpty(dir)` helper (был duplicated в `purge-archive` и `readRoomItems`).
- Hoisted `RoomItem` type на module level.
- Frontend `RoomCard.tsx`: extracted `InlineRoomForm` component (rename + duplicate forms были структурно идентичны — общий wrapper с input/OK/cancel/Enter/Escape).

### Backwards compatibility

- Existing v3 room envelopes без `linkedSession` / `projectDir` загружаются normally (поля optional, additive).
- CLI `rooms rm`, `rooms archive`, `rooms restore`, `rooms export`, `rooms import` — без изменений semantics.
- HTTP `DELETE /api/rooms/:id` без `mode` field теперь archives (raw `{confirm: true}` — old hard behavior changed to archive). Callers, ожидавшие hard, должны явно передать `mode: 'hard'`. CLI `rooms rm` это уже делает.

---

## 0.4.2 — 2026-05-17 — Phase 3.1: persist tldraw schema from first client (DRW-040)

### Changed

- **WS hello protocol** теперь несёт опциональное поле `schema` — клиент посылает `editor.store.schema.serialize()` в первом hello frame. Backend хранит V2 схему первого подключившегося клиента в `RoomState.store.schema` и схватывает её в next `scheduleSave` цикле. Для новых rooms и для существующих 0.4.0 rooms (где persisted schema = V1 stub из `migrate-v2.defaultSchema()`) replacement происходит автоматически при первом 0.4.x connect.
- **Phase 3.0 workaround `e6ff76c` снят**: `App.tsx` больше не подменяет `s.store.schema` на каждый loadSnapshot. Условный fallback остался ровно на первый коннект к свежей комнате (schema ещё placeholder) через `isPlaceholderSchema()` helper — на втором коннекте backend уже отдаст реальную V2 schema, override автоматически выключится.

### Added

- `apps/backend/src/ws-protocol.ts:isPlaceholderSchema()` — структурный детектор V1 stub vs V2 schema (без импорта `@tldraw/*`).
- `apps/backend/src/ws-protocol.ts:handleHello()` возвращает `{ reply, schemaUpgraded }` — caller (index.ts) при `schemaUpgraded` вызывает `scheduleSave`, чтобы новая schema персистировалась.
- `apps/frontend/src/canvas/schema-placeholder.ts` — frontend-side helper, повторяет backend detection 1:1.

### Architectural

- Backend по-прежнему НЕ импортирует `@tldraw/*` (spec Phase 3.0 §12). `clientSchema` принимается как opaque object и хранится как-есть.
- Race-condition fix: первый клиент к свежей комнате не падает на migrator'е, потому что (а) backend отдал V1 stub, (б) frontend детектит placeholder, (в) подменяет на свою current schema. На WS hello отправляет ту же schema → backend upgrade'ит. Все следующие циклы получают V2 → override skip'ается.

### Tests

296 pass (+8 vs 0.4.1 baseline): backend `ws-protocol.test.ts` +5 (hello+schema parsing, `isPlaceholderSchema` 3 case, schema-upgrade в `handleHello`), `ws-hello-replay.test.ts` +1, frontend `transport/ws.test.ts` +2 (hello frame шлёт schema).

---

## 0.4.1 — 2026-05-17 — Batch 1 quick wins (post-3.0 cleanup)

### Fixed

- **DRW-001** — `RoomBadge` показывал `v0.4.0` с префиксом `v`. Now: `0.4.0` (синхронно с numeric-tag policy).
- **DRW-002** — `GET /favicon.ico → 404`. Добавлен `apps/frontend/public/favicon.svg` + `<link rel="icon" type="image/svg+xml">` в `index.html`.
- **DRW-016** — `MAX_VISIBLE = 5 → 3` в `apps/frontend/src/state/error-bus.ts` (sync со spec Phase 2.2 §5.1).

### Refactor

- **DRW-013** — `pushOpLog(room, entry, max)` helper в `apps/backend/src/rooms.ts`; 4 call sites (`index.ts`, `routes/domain.ts` ×2, `routes/layout.ts`) теперь используют helper вместо дублированного cap-splice.
- **DRW-014** — удалён legacy `ws.send({kind:"hello", version:0})` initial frame в `apps/backend/src/index.ts:websocket.open`; client сам инициирует hello с `lastVersion`, сервер отвечает sync-ack/replay/truncated.

### Docs

- **DRW-019** — spec Phase 2.2 §3.1 и §3.4 синхронизированы с config: `opLogMaxSize` default 200 → 50.

### Cancelled (obsolete after Phase 3.0)

- DRW-006 (retry-422 loop), DRW-007 (markHistoryStoppingPoint), DRW-008 (version polling), DRW-011 (to-patch tests), DRW-015 (findGroupByName unification), DRW-017 (OpLog schema validation), DRW-020 (style.dashed:false), DRW-021 (cross-client endpoint-move) — устранены архитектурно при переходе на tldraw-as-primary.

### Tests

288 pass (58 domain + 203 backend + 4 client + 23 cli). No new tests — все правки либо тривиальные UI / config refactors, либо удаления, покрытие сохраняется существующими integration-тестами.

---

## 0.4.0 — 2026-05-17 — Phase 3.0: tldraw-as-primary, domain-as-view

**Архитектурный pivot.** Tldraw store стал primary persistence; наш domain layer — read-only view + write-compiler поверх него. Двусторонняя визуальная синхронизация AI ↔ user работает для **всех** tldraw shape types (закрывает DRW-024 fundamental).

### Breaking

- **Envelope schemaVersion 3** (`TLStoreSnapshot` + `StoreOpLogEntry`). v2/v1 rooms мигрируются автоматически при первой загрузке (`<room>.json.v2.bak` backup создаётся рядом, atomic v3 rewrite).
- **WS protocol**: `kind: 'patch'` → `kind: 'store-change'`; payload `PatchOp[]` → `StoreChangeBatch` (`{ added, updated: [old, new], removed }`). Добавлен incoming `kind: 'user-change'` от клиента. Replay/sync-ack/truncated пути сохранены идентично Phase 2.2.
- **`/api/patch` endpoint удалён** (был deprecated с Phase 2.1). AI и CLI используют `/api/domain`.
- **`/api/state`** shape: `{ store: TLStoreSnapshot, version, prompts, aiActivity }` вместо `{ canvas, version, prompts }`.
- **`/api/agent/context`** view: `elements[]` с unified shape (`id`, `type`, `label`, `role`, `from`, `to`, `children`, `pinned`); без геометрии в default response (opt-in `?include=geometry`).

### Added

- Все tldraw shape types (freehand draw, line, image, video, embed, bookmark, highlight, frame, ...) теперь синхронизируются на backend и видны AI через `/api/agent/context`. Bi-directional viz pair-coding с LLM работает для произвольных user gestures.
- `apps/backend/src/store-types.ts` — opaque `TLRecord` / `TLStoreSnapshot` / `StoreChangeBatch` / `StoreOpLogEntry` (backend не импортирует `@tldraw/*`).
- `apps/backend/src/migrate-v2.ts` — lossless v2 → v3 envelope migrator (preserves `didrawName/role/connectionKind/pinned/position/styleOwnedBy`; v2 nodes → tldraw geo/note/text; v2 groups → frame + parentId; v2 edges → arrow + 2 bindings).
- `apps/backend/src/store-ops.ts` — pure `applyStoreChanges` / `rebuildDidrawIndex` / `findShapeByDidrawName` / `cascadeDeleteShape` (cascade arrows by binding refs; frames release children to `page:page`).
- `apps/frontend/src/transport/ws.ts:startStoreSync` — WS bridge: `editor.store.listen({source:'user',scope:'document'})` → debounce 50ms → `user-change`; receive `store-change`/`replay` → `editor.store.mergeRemoteChanges(() => applyDiff(...))`. Echo-guard через `clientOpId`.
- Backend `meta.didrawName` index для O(1) name → shape lookup в compile.
- Atomic v3 rewrite через `writeAtomic(tmp → rename)`; `.v2.bak` создаётся через rename (не перезатирает существующий backup).

### Removed

- Frontend `canvas/to-patch.ts`, `from-canvas-state.ts`, `kinds.ts`, `echo-guard.ts`, `role-render.ts`, `richtext.ts` (translation layer больше не нужен).
- Frontend `<Tldraw persistenceKey>` (split-brain risk; single source of truth = backend store).
- Backend `patch.ts`, `routes/patch.ts`, `domain/supported-kinds.ts`, `layout-postprocess.ts`, legacy `Node/Edge/Group/PatchOp/CanvasState` типы.

### Preserved (без изменений семантики)

- CLI command surface: `define <role> <name>`, `connect <from> <to> --kind`, `group <ids> --as --name`, `note --about --text`, `layout --mode --scope`, `delete <id>`, `apply --file`, `context [--since] [--include geometry]`, `rooms list/create/restore/delete/import/export/archive`, `daemon start/stop/status`, `data dir`, `version`. CLI source неизменна.
- Phase 2.2 WS hello/replay/truncated path; opLog rolling window (`config.opLogMaxSize`).
- Pin discipline (DRW-003) — non-pinned displacement при overlap с pinned bbox.
- Group bbox writeback (DRW-004) — frame получает `props.w/h` из ELK output.
- ADR-0002 absolute coords (children в frame хранят absolute x/y).
- `@didraw/domain` SSOT для Role/ConnectionKind/LayoutMode/presets.
- Idempotency LRU + `clientOpId` echo-guard.

### File structure shift

- App.tsx: 460 → 266 LOC (-42%). Diff loop удалён.
- `apps/frontend/src/canvas/` 11 → 3 файлов (camera-persist, id-prefix, mermaid-import).
- `transport/ws.ts` теперь единая точка sync; chrome layer слушает `window.dispatchEvent('didraw:ws-message')`.

### Tests

- Test count: **298** (domain 58 + backend 203 + client 4 + cli 23 + frontend 10). +43 net тестов: переписаны под новый model, добавлены envelope-v3 (7), migrate-v2 (6), store-ops (8), domain-compile (7), ws-protocol (6), layout-pin-discipline (10), domain/layout (5), domain-context (6), rooms-migration (2), ws-user-change (10), transport/ws (10).

### Migration notes (для существующих deploys)

- При первом запуске 0.4.0: каждая existing room мигрируется автоматически. `<room>.json` переписывается как v3; оригинал сохраняется как `<room>.json.v2.bak`. Connected clients получают `truncated` при reconnect и перезагружают snapshot — это норма Phase 2.2 path.
- Frontend bundle обязан быть на 0.4.0 (старые bundles не понимают `kind: 'store-change'`). Embedded UI в single-binary release всегда совместима с backend.

---

## 0.3.3 — 2026-05-17

### Fixed (DRW-024)

- **Hotfix: tldraw draw shape crash на reload.** Любой shape вне нашего синхронизатора (draw/line/image/highlight/...) отправлялся на backend без serializer'а → корраптил envelope → tldraw crash в `getGeometry` (Polyline2d) при reload. Reload ломал комнату и требовал файлового удаления для восстановления.
- **Whitelist supported kinds** (single source of truth, `apps/backend/src/domain/supported-kinds.ts`): `rect`, `ellipse`, `diamond`, `sticky`, `text`. Все остальные tldraw shape types НЕ сериализуются на backend.
  - Frontend `to-patch.ts`: убран `s.type === "draw"` case, который создавал broken Node `{kind:"freeform"}`.
  - Frontend `kinds.ts:kindToTldraw`: убран `freeform→draw` mapping, теперь возвращает `null` для unknown kinds.
  - Frontend `from-canvas-state.ts:nodeToShape`: nullable — корраптный envelope при load gracefully skip'ает unknown nodes.
  - Frontend `App.tsx:replaceCanvasFromState`: удаляет только synced shapes (по `meta.canvasId`), не трогает local-only.
  - Backend `applyPatch`: defensive validation — `add/update node` с unsupported `kind` отдаёт 422 `unsupported node kind`.
- **tldraw `persistenceKey={`didraw-${room}`}`**: native IndexedDB persistence per-room — все типы фигур (draw/line/image/...) сохраняются локально и переживают reload в той же вкладке + multi-tab в одном браузере (через shared IndexedDB). Backend остаётся source of truth для supported types; unsupported живут локально.

### Known limitations

- **Cross-browser / cross-device sync** ограничен supported types — это архитектурное ограничение текущей dual-source модели (наш envelope + tldraw store). Roadmap: **Phase 3.0** (DRW-028) — tldraw-as-primary, domain-as-view: tldraw store становится primary persistence, backend хранит TLRecord-snapshot целиком; domain layer — read-only projection поверх shapes. После Phase 3.0 cross-browser работает для **всех** shape types автоматически.

### Tests

- `apps/backend/tests/patch.test.ts` — 5 новых кейсов: reject `add node {kind:freeform}`, `draw`, `image`; reject `update node` меняющий kind на unsupported; accept все 5 supported kinds.

**Test counts:** 314 pass (backend 226 + cli 26 + client 4 + domain 58). 1 pre-existing playwright conflict в root `bun test` — [DRW-023].

---

## 0.3.2 — 2026-05-16

### Fixed

- **Layout pin discipline (DRW-003):** при `scope=affected` ELK layered не учитывает pinned positions для placement новых disconnected affected nodes — ставил их в (0,0), snap → (10,10), что конфликтовало с pinned, тоже placed near origin. Добавлена displacement-логика в `layout.ts` после ELK + pin restore: affected nodes overlapping с pinned bbox перемещаются в `pinnedRight + spacing` с y-стэком (детерминированно по id).
- **Group bbox writeback (DRW-004):** `routes/domain.ts` group writeback писал только `{x,y}` (`postProcess` стрипал w/h), из-за чего Group.w/h оставались undefined. Теперь w/h берутся напрямую из `lr.positions[g.id]` (ELK output до postProcess).
- **Children coords в группе (DRW-005):** decision fixed via [ADR-0002](docs/decisions/0002-group-children-coordinates.md) — children всегда в **absolute** coords (`Group` остаётся canonical container-marker без координатной трансформации). После fix'а DRW-003/004 frontend корректно показывает children внутри group bbox.

### Tests

- `apps/backend/tests/layout-pin-discipline.test.ts` — 8 новых кейсов: pin discipline (AC1 user-pinned не двигается, AC2 unpinned свободно двигается, AC3 в трёх вариантах: batch, incremental с final layout, incremental без final layout); group bbox (w/h из ELK); group children внутри bbox (репро D5).

**Test counts:** 309 pass (backend 221 + cli 26 + client 4 + domain 58); 1 pre-existing playwright conflict в root `bun test` — отдельная задача [DRW-023].

---

## 0.3.1 — 2026-05-16

### Fixed

- **CLI multi-room:** `--room <id>` теперь принимается всеми domain командами (`define`, `connect`, `group`, `note`, `layout`, `delete`, `apply --stdin`, `context`). Раньше флаг игнорировался — все mutations шли в `default` room. Backend `/api/domain` уже корректно читал `?room=` через `resolveRoomId`; проблема была в CLI client: `clientFor(profile)` создавал `CanvasClient` без передачи room, а dispatcher не парсил `--room`. Default behavior unchanged (`default` room) — backward-compat. [DRW-009, DRW-010]

### Tests

- `packages/didraw-cli/tests/room-flag.test.ts` — 11 новых кейсов; явно убирает `CLAUDE_SESSION_ID` из env, чтобы `--room` был единственным путём маршрутизации (исключает env-fallback false positives). Покрытие: apply, define, connect, group, note, layout, delete, context + invalid-room id + изоляция параллельных rooms.

**Test counts:** 301 pass (58 domain + 213 backend + 4 client + 26 CLI).

---

## 0.3.0 — 2026-05-16

### Phase 2.2 — Sync hardening + user-arrows

**Round-trip:**
- User-drawn arrows in tldraw теперь персистятся в backend как `Edge` ops (B1). Bindings → `Endpoint{kind:"node",id}`; floating endpoints → `Endpoint{kind:"point",x,y}`. Style/label/dashed honored.

**Persistence:**
- `PersistedEnvelope` bumped schemaVersion 1→2: добавлено `opLog: OpLogEntry[]` (capped at `opLogMaxSize`). v1 envelopes читаются с empty opLog (lossy для существующих файлов; expected); первая write апгрейдит файл.

**WS sync:**
- Hello/replay protocol: client отправляет `{kind:"hello", lastVersion}` на reconnect; server отвечает `sync-ack` (in-sync), `replay` (delta) или `truncated` (gap exceeds opLog window — client refetches state).
- Legacy clients без hello получают initial state через старый GET path (compat preserved).
- Client seeds `lastReceivedVersion` from initial `getState()` to prevent duplicate replay on reconnect.
- `update edge` ops handled on receive side (cross-client style/label sync).

**No-silent-fail:**
- Rejected backend patches (422 на `/api/patch`) surface в frontend `ErrorBanner` (top-right toast, 5s TTL).

**Fixed (Phase 2.0 follow-ups):**
- Slug length capped (I1); rooms import explicit flushIfDirty (I2); 409 untouched test (I3); workspace isolation tests (I4); 409 import response carries `existingId` (I5); GET /api/rooms filename id validation (m1); envelope `lastTouched`/`elementCount` types (m3); WS upgrade validates `?room=` (m4); `evictIdle` uses `flushIfDirty` (m5); config test reset hook (m6).

**Fixed (Phase 2.1 follow-ups):**
- ~87 tsc-strict warnings cleared (I1); idempotency cache bounded LRU max 1000 (I2); two-phase domain bus.publish documented (m1); `nodeToCompact.role` optional для unknown nodes (m2); `connectionPropsForEdge` теперь применяется в `edgeToShape` (m3, dead export resolved).

**Refactoring (post-feature simplify pass):**
- 10 simplification commits: nested ternary → switch in `geoToKind`; `Array.entries()` for indexed iteration; `findGroupByName` helper; `inferUserMetadata` cast cleanup via discriminated narrowing; `VIEWPORT_TTL_MS` constant; `isSelected` helper + named context limits; `buildEnvelope` extracted; rooms import spread; `endpointEq` narrowing.

**Test counts:** 290 pass (58 domain + 213 backend + 4 client + 15 CLI). Backend tsc-strict warnings (src/) reduced from 104 → 9 (pre-existing).

---

## 0.2.0 — 2026-05-16

### Phase 2.1 — Agent v2 (domain-first)

**Shared:**
- New workspace package `@didraw/domain` — SSOT for `Role`, `ConnectionKind`, `LayoutMode`, `rolePreset`, `connectionPreset`, name validation, `modeToElkOptions`.

**Backend:**
- New domain layer: `apps/backend/src/domain/{types,validate,compile,layout,layout-postprocess,context}.ts`.
- New routes:
  - `POST /api/domain` — typed actions (define/connect/group/note/layout/delete + apply batch + dryRun + idempotency); transactions atomic for domain mutations, best-effort for layout.
  - `GET /api/agent/context` — token-cheap domain summary (no geometry, ≤8KB for 100 elements); supports `?since=N` delta filter.
  - `POST /api/viewport` / `GET /api/viewport` — ephemeral per-room viewport storage (30-min idle wipe).
- ELK развёрнут на полную: compound containers (network/boundary → compound nodes), ports (computed sides → frontend anchors), pin (`meta.pinned` → app-level post-process; ELK layered ignores `elk.position`), affected vs all scope, orthogonal edge routing (bendpoints stored for forward-compat; render in v3.x).
- Post-process pipeline: snap-to-grid 10px + min-spacing 20px.
- `POST /api/patch` теперь делает inference на `source:"user"`:
  - update `x`/`y` → `meta.pinned=true`, `meta.position={x,y}` (full object, preserves unchanged axis).
  - update `style` → `meta.styleOwnedBy="user"`.

**CLI (BREAKING):**
- New domain commands: `define`, `connect`, `group`, `note`, `delete`, `apply --stdin`, `context`.
- `layout` command parameter renamed: `--algorithm dagre|elk-layered` → `--mode layered-lr|layered-tb|tree|pack|force` (the old "dagre" was misleadingly ELK force; new naming honest).

**Frontend:**
- `role-render.ts` применяет `rolePreset(role)` поверх state; уважает `meta.styleOwnedBy === "user"`.
- Port-side из ELK → `normalizedAnchor` для arrow bindings; `isPrecise: true` when port side explicit.
- Viewport reporter — debounced (500ms) `POST /api/viewport` на camera change.

**Skill:**
- `/draw` cheat-sheet полностью переписан: инжектит `didraw context` вместо `state --compact`; добавлены Roles/Connection-kinds tables; раздел PatchOp удалён (агент его больше не видит).

**Deprecated:**
- `docs/handoff/mcp-launch-brief.md` — будет переписан в Phase 2.3 (MCP adapter поверх domain API).

**Deferred to Phase 2.2:**
- Preserve-order in `layout-postprocess` (currently snap-to-grid + min-spacing only).
- Bendpoint rendering (stored in `meta.routing.bendPoints`, currently ignored by tldraw renderer).
- `scope=ElementId` (subgraph layout around a specific element; currently treated as `"all"`).
- Playwright E2E smoke for §5.1 worked example.

---

## 0.1.0 — 2026-05-15

### Phase 2.0 — Persistence hardening

**Storage:**
- Workspace-scoped storage path (was hard-coded `default-project`). Resolution: `DIDRAW_PROJECT_DIR > CLAUDE_PROJECT_DIR > cwd`. Collision-resistant slug (`name-<sha1[0:8]>`) prevents same-basename folders colliding.
- Persisted envelope format: `{schemaVersion, roomId, version, lastTouched, elementCount, canvas, prompts}`. Single contract between storage and export.
- Room id validation: `/^[a-zA-Z0-9_-]{1,64}$/`. Invalid ids rejected with 422 (no silent mangle).

**Daemon-safe rooms API:**
- `GET /api/rooms` — listing with envelope metadata (version, elementCount, lastTouched).
- `POST /api/rooms/:id/archive` / `/restore` — move to `.archive/` and back.
- `POST /api/rooms/:id/export` — write envelope + `exportedAt` to disk.
- `POST /api/rooms/import` — restore from file with `as`/`force` options.
- `DELETE /api/rooms/:id` — hard delete with `{confirm:true}` body.

All ops use `flushIfDirty + evict + filesystem op` pattern, so daemon's autosave never overwrites a fresh archive/delete/import.

**CLI (BREAKING):**
- Removed top-level `didraw list`, `didraw export`, `didraw rm`.
- New `didraw rooms` subcommand group: `list`, `archive`, `restore`, `export`, `import`, `rm`. All commands go through HTTP via daemon (not direct filesystem ops) — autosave and pending writes flush before the operation.

**Skill:**
- `/draw` cheat-sheet injects `didraw rooms list` at startup so AI sees existing schemas before deciding default-vs-resume.

---

## 0.0.1 — 2026-05-15

> Первый relesable cut: MVP-canvas + AI-workflow через Bash CLI + persistent watcher.
> Документ описывает поведение версии `0.0.1`. Сверяйтесь с следующими разделами для дальнейших версий.

### Added

#### Backend (`apps/backend`)
- `CanvasState + PatchOp` REST/WS API: `GET /api/state`, `POST /api/patch`, `GET /api/prompts`, `POST /api/prompt`, `POST /api/prompt/:id/{resolve,dismiss}`, `POST /api/layout`.
- Multi-room storage в `~/.claude/projects/<slug>/canvas/<room>.json` (per spec §3.5; см. known issue P3 если запускаешь без `CLAUDE_SESSION_ID`).
- Runtime profiles: `release` (8787, embedded UI), `dev` (8788, Vite HMR), `debug` (release + verbose). Параллельная работа без конфликтов.
- WS hub с `prompt-created`, `prompt-resolved`, `prompt-removed`, `ai-activity`, `patch` event kinds.
- `DELETE /api/prompt/:id` (точечно) и `DELETE /api/prompts` (purge всех non-pending) — добавлены в этой версии.
- AI-activity routes: `POST /api/ai/start`, `POST /api/ai/stop`, `GET /api/ai/activity`. Авто-clear через 5 минут.
- Cascade-delete для groups, graceful shutdown через autosave, deep-merge для `style`/`meta`, echo-guard через `clientOpId`.
- 50 unit/integration тестов.

#### CLI (`packages/didraw-cli`)
- Lifecycle: `daemon ensure|start|stop|status`, `open <room>`, `list`, `export`, `rm`, `clear`.
- Data: `state [--compact] [--since N]`, `patch --stdin`, `layout --algorithm elk-layered`, `prompts list|resolve|dismiss|delete|purge`.
- AI badge: `ai start --actor X --task Y`, `ai stop`, `ai status`.
- Versioning + update: `version`, `update [--check] [--channel stable|nightly|dev]` с sha256 + atomic swap + restart.
- `--profile dev|release|debug` резолвится централизованно в `index.ts` через `process.env.DIDRAW_PORT ??= portFor(profile)`.
- 7 integration тестов.

#### Client (`packages/didraw-client`)
- HTTP wrapper `CanvasClient` с методами `getState`, `applyPatch`, `getPrompts`, `resolvePrompt`, `dismissPrompt`, `deletePrompt`, `purgePrompts`, `layout`, `clear`, `aiStart`, `aiStop`, `aiActivity`, `getVersion`, `health`.
- 4 unit-теста (включая roundtrip prompts delete/purge).

#### Frontend (`apps/frontend`)
- tldraw 5.x editor + `@tldraw/mermaid` 5.0.0 для browser-side mermaid импорта (server-side не работает per ADR-0001).
- Service-layer chrome (per spec §3.8): top-right version+room badge, AI-activity badge сверху-по-центру, prompt drawer слева, update banner.
- **PromptInput по `⌘K`/`Ctrl+K`** (toggle, не modifier-hold; раньше конфликтовал с tldraw drag).
- **Auto-center camera** на shapes, добавленных AI (zoomToBounds union'а новых node ids).
- **Camera persistence per room** — позиция и zoom сохраняются в `localStorage` (`didraw:camera:<room>`).
- **Echo-guard**: подписка `editor.store.listen` с `source: "user"` + `mergeRemoteChanges` для AI-side обновлений — не зацикливается.
- **Style roundtrip**: `nodeToShape` пробрасывает `style.color/fill` в tldraw `props.color/fill`; `onPatch` для `update` мерджит `set.style`; `shapeToNode` читает обратно; `diffToOps` отправляет diff цвета/заливки.
- **AI-activity badge** на UI: периодически polling каждые 10с + при focus, плюс WS-events.
- **Prompt drawer**: × на каждой карточке (DELETE prompt), 🗑 N в шапке (purge non-pending) с confirm.
- dev-only `window.__editor` hook для programmatic e2e/отладки.

#### Skill (`.claude/skills/draw/SKILL.md`)
- Cheat-sheet с auto-injection: `didraw state --compact` и pending prompts через `!`-команды в frontmatter.
- Документация для всех CLI-команд включая `ai start|stop|status` и dev-CLI fallback для stale release-binary.

#### Persistent watcher pattern
- Запуск через Claude Code Agent tool с `subagent_type=general-purpose, model=sonnet, run_in_background=true` и system-prompt'ом, описывающим polling-loop pending prompts → patch + resolve.
- В этой версии: ad-hoc launch из родительской сессии, не stand-alone CLI (см. backlog: `didraw watch`).

### Fixed
- **sendPatch error swallowed** — теперь возвращает типизированный `PatchResult = {ok:true,version} | {ok:false,error}`; снапшот двигается только при `ok:true`, иначе retry на следующем тике.
- **Mermaid arrow labels пустые** — раньше читались из `(s as any).props?.text`; теперь через `renderPlaintextFromRichText(editor, props.richText)`.
- **Edge selection отдавал не тот id** — selection mapping теперь `fromEdgeShapeId(id) ?? fromShapeId(id)`, edge prefix отрезается корректно.
- **Esc не закрывал PromptInput** — `onKeyDown` обрабатывает Escape до `stopPropagation`.
- **Truncated diff не сигналился** — `/api/state?since=N` возвращает `{truncated:true}` если opLog window expired.
- **Patch invariants** — `update` для edge re-validates endpoints, `delete` для group cascade-cleans children.
- **CLI port routing** — data-команды теперь идут на профиль-resolved port.
- **Style игнорировался при рендере** — backend хранил, frontend mapper выкидывал; теперь roundtrip полный.

### Limitations (см. также `docs/handoff/known-issues.md`)
- **tldraw 5.x не разделяет stroke и fill цвета** — один `props.color` управляет и обводкой и заливкой; backend хранит шире (`style.stroke`), но рендер унифицирован.
- **User-initiated arrows не round-trip'ятся** — рисованные пользователем стрелки видны локально, но не доходят до backend (B1).
- **Inline DSL-парсер для prompts отсутствует** — без активного watcher'а pending копится без эффекта; нужен LLM-watcher (≥3с latency).
- **Watcher one-shot** — каждый запуск лимитирован (~5 мин в текущем рецепте); stand-alone `didraw watch` daemon — backlog.
- **MCP push-канал** — не реализован (B2, Phase 2.1).

### Tests
64 unit/integration: 50 backend + 4 client + 7 cli + 3 backend autosave/persistence. Frontend e2e через Playwright (golden.spec.ts) запускается отдельно.

### Build
Single-binary через `bun build --compile`: `release/didraw-{darwin-arm64,darwin-x64,linux-x64}`. Frontend assets вшиты через `import ... with { type: "file" }` + generated manifest.

---

## Unreleased

(Пусто. Используйте раздел при подготовке следующего cut'а.)
