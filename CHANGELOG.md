## 0.21.12 — 2026-05-22 — DRW-126 `/api/health` is space-aware (P0.2 storage rift fix)

PATCH for the second P0 from the 2026-05-22 MCP feedback. `shemma_health` used to report the daemon-default fallback storage (`~/.claude/projects/<slug>/canvas`) regardless of which space the agent was actually targeting; `shemma_rooms_list(space=X)` resolved per-space (`<space>/.shemma/canvas`). Two responses for the same daemon, one of them lying.

### Root cause

`/api/health` is in `SPACE_ALLOWLIST`, so the global space middleware skipped it. The route handler returned `storageDir`, a value captured by closure at daemon startup from `resolveLegacyStorageDir(profile)`. No optional `?space=` path existed, and the MCP tool never threaded one through.

### Fix

- `apps/backend/src/routes/health.ts` now handles `?space=<id>` itself:
  - Valid registered → `resolveStorageRoot(record, profile)` plus `space: <id>` and `fallback: false` fields in the response.
  - Malformed id (fails `SPACE_ID_PATTERN`) → 400 `invalid_space_id`.
  - Unknown id (no registry record) → 404 `space_not_found`.
  - No `?space=` → legacy closure storage plus `fallback: true` so callers can tell that path is global, not a specific space's data dir.
- `CanvasClient.getHealth(opts: { space? })` threads the param into the URL and parses the new optional `space` / `fallback` fields.
- `shemma_health` MCP tool accepts `space?: string`. Resolution goes through the shared `resolveSpaceOrError` (composite-key invariants per spec §3 + §8.3). Description updated to spell out the fallback-vs-resolved semantics.

### Tests

- `apps/backend/tests/drw-126-health-space-aware.test.ts` — 5 cases:
  - no `?space=` → fallback storage + `fallback: true`.
  - valid registered space → per-space storage roots inside the space path, not claude-projects.
  - malformed space → 400 `invalid_space_id`.
  - unknown space → 404 `space_not_found`.
  - cross-check: `health(space=X).storage` agrees with `rooms_list(space=X).dir`.
- Existing `apps/backend/tests/routes-health.test.ts` still passes (no behaviour change without `?space=`, just the new additive `fallback: true` field).
- Full monorepo suite: still green (CLI 203 + backend 511+5 + MCP 193 + client/domain ≈100s, 0 fail).

### Verification

`shemma_health(space="ios").data.storage` will now match the actual per-space storage dir `<ios-path>/.shemma/canvas/` — same value as `shemma_rooms_list(space="ios").data.dir`. `shemma_health()` (no space) still works and now carries `fallback: true` so agents can detect they're looking at the daemon-wide default rather than a specific space.

---

## 0.21.11 — 2026-05-22 — DRW-128 envelope snapshot stamps runtime version (was hardcoded "0.10.0")

PATCH one-liner — every room JSON snapshot used to carry `shemma.shemmaVersion: "0.10.0"` regardless of the running daemon, because `apps/backend/src/envelope.ts` held a const literal `SHEMMA_VERSION = "0.10.0"` from the project rename in 0.10.0 and never bumped it since. The schema layer (`ENVELOPE_SCHEMA_VERSION = 3`) was correct; only the product-version stamp was stale.

### Fix

- Removed the hardcoded const. `buildV3()` now stamps `VERSION.version` from `apps/backend/src/version.ts` (which already resolves via `process.env.SHEMMA_VERSION` → `gitDescribe()` → `pkg.version-dev` chain — see DRW-119 / 0.21.8 + 0.21.9).
- Renamed the literal `"0.10.0"` survivor to `LEGACY_FALLBACK_VERSION` and kept it strictly on the parse path: when a legacy envelope arrives without `shemma.shemmaVersion` or `didraw.didrawVersion`, we use this historical floor (the file was clearly written pre-0.10) instead of fabricating the current runtime version.

### Tests

- `apps/backend/tests/envelope-v3.test.ts` — 3 new cases:
  - `serialize` stamps with `VERSION.version`, not `"0.10.0"`.
  - `parseFull` on a legacy envelope (no `shemma` key) falls back to `"0.10.0"`.
  - `parseFull` preserves an explicit `shemmaVersion` round-trip.
- Full backend suite: 511 tests, 0 fail.

### Verification

Source-mode serialize emits `shemmaVersion: "0.21.11"` (or `git describe` output for in-flight commits). No more frozen-in-time `0.10.0` in saved files going forward.

---

## 0.21.10 — 2026-05-22 — DRW-125 CLI silent noop: thread `--space` + symmetric exit codes

PATCH fix for the most damaging surface bug from the 2026-05-22 MCP feedback. Domain CLI commands (`define / connect / group / note / layout / delete / apply / context`) silently swallowed backend errors: `✔ ok` on stdout, exit 0, nothing actually written. Two compounding causes:

### Root cause

1. **`clientFor` ignored `--space`.** `packages/shemma-cli/src/domain.ts` constructed `new CanvasClient({ baseUrl, room })` without threading the `--space` flag (it wasn't even parsed at the top level). `CanvasClient` defaults `space` to `"__legacy__"`, which fails `SPACE_ID_PATTERN` in `apps/backend/src/middleware/space.ts`, so the daemon always replied `400 {error: "invalid_space_id"}` regardless of what the user typed.
2. **Error detection keyed on `ok === false` only.** Middleware short-circuits return `{error: "..."}` with **no `ok` field at all`. Both `printAndExitOnFail` and `printResponse` checked `ok === false`, which `undefined` doesn't satisfy → the JSON envelope passed through, and human mode happily printed `✔ ok`.

The combination meant: even with `--space ios` typed explicitly, the flag was discarded, the backend rejected the request, and the CLI lied about success.

### Fix

- Top-level `--space <id>` flag in `packages/shemma-cli/src/index.ts`, mirroring `--profile` / `--json`. Stripped from argv before per-command parsing. `SHEMMA_SPACE` env honoured as fallback.
- `clientFor(profile, room, space)` in `packages/shemma-cli/src/domain.ts` now threads `space` into `CanvasClient`. All eight domain entry points (`define / connect / group / note / layout / delete / apply / context`) accept and forward it.
- New shared helper `isErrorEnvelope` (used by both `printResponse` and the new exported `responseHasError`) recognises both error shapes: `{ ok: false, error }` and `{ error }` without `ok`. False-positive guard for legitimate `ok: true` responses that nest the word "error" in a sub-field.
- `printResponse` routes well-known error codes (`invalid_space_id`, `space_not_found`, `space_required`) through `→` hints pointing at `shemma s list` and `--space <id>`.
- `printAndExitOnFail` uses `responseHasError` so JSON and human modes exit symmetrically.

### Validation

Live daemon repro (0.21.9 + fix via `bun packages/shemma-cli/src/index.ts ...`):

| Variant                                          | stdout                          | exit |
| ------------------------------------------------ | ------------------------------- | ---- |
| `define service x` (human, no --space)           | `✖ invalid_space_id` + 2 hints  | 1    |
| `--json define service x` (no --space)           | `{"error":"invalid_space_id"}`  | 1    |
| `define service x --space DOES_NOT_EXIST`        | `✖ invalid_space_id` + 2 hints  | 1    |
| `--json define service x --space di-draw`        | `{"ok":true,"version":1,...}`   | 0    |

Tests:
- `packages/shemma-cli/tests/ui.test.ts` — 12 new cases covering `printResponse` error envelopes, JSON-mode preservation, hint emission, false-positive guard, and `responseHasError` contract.
- `packages/shemma-cli/tests/drw-125-silent-noop.test.ts` — 6 integration cases with `enableSpaceMiddleware: true` in-memory server: human mode exit code + ✖ + hint, JSON mode exit code, invalid `--space`, valid `--space` round-trip, `SHEMMA_SPACE` env path. XDG isolation via tmpdir per `feedback-cli-tests-xdg-isolation`.
- Full monorepo suite: 1013 tests, 0 fail.

### Out of scope (still in DRW-124)

This patch fixes P0.1 only. P0.2 (storage rift, `shemma_health` not space-aware), P0.3 (Mermaid storage-only fallback), Q9 (URL-based MCP open + window reuse), Q10 (`SHEMMA_VERSION = "0.10.0"` envelope stamp), Q11 (`~/.claude/projects/...` orphan duplicates from legacy migration), and the remaining P1–P3 items remain tracked under DRW-126, DRW-127, DRW-128, and the umbrella DRW-124 notes.

---

## 0.21.9 — 2026-05-22 — DRW-119b fix: compiled binary version regression

PATCH hotfix for the regression introduced in 0.21.8. Compiled release binaries reported `0.21.8-dev` instead of `0.21.8` because the new `resolveVersion()` accessed `SHEMMA_VERSION` via a renamed local (`env.SHEMMA_VERSION` where `env = deps.env ?? process.env`), and `bun build --compile --define` does **purely textual** substitution of the literal token `process.env.SHEMMA_VERSION` — any rename defeats it.

### Evidence

Compiled 0.21.8 daemon `/api/version`:
```json
{"version":"0.21.8-dev","channel":"stable","gitSha":"18222ba","buildDate":"2026-05-22T09:00:13Z"}
```

`channel`, `gitSha`, `buildDate` got substituted (they read `process.env.X` literally). Only `version` fell through to the `pkg.version + "-dev"` fallback because the substitution target had been renamed.

### Fix

`resolveVersion()` now reads `process.env.SHEMMA_VERSION` as a literal at the production path. Tests inject via `deps.envVersion` (renamed from `deps.env`). Empty-string `envVersion: ""` is the explicit "no env" sentinel for tests that don't want to leak the host's actual `SHEMMA_VERSION`.

Verified via direct `bun build --define`:
```
const envVersion = deps.envVersion !== undefined ? deps.envVersion : "0.21.9";
```

Tests updated: 8 tests (1 obsolete dropped). All green.

### Lesson learned

`bun build --define KEY=VALUE` is `String.replaceAll(KEY, VALUE)`-style. Any indirection (`const env = process.env; env.X`) breaks it. When writing code that relies on `--define` substitution, keep the **literal token** verbatim on the production path. DI for tests must layer on top without renaming the substitution target.

---

## 0.21.8 — 2026-05-22 — DRW-119 `git describe` for dev/debug version display

PATCH versioning policy follow-up. Closes the gap introduced by the new "tags only at real releases" policy (2026-05-22): between releases, dev/source builds no longer show the stale `pkg.version` of the last shipped release. Compiled release binaries are unchanged.

### The problem

`apps/backend/src/version.ts` previously resolved version as:

```
process.env.SHEMMA_VERSION ?? pkg.version ?? "0.0.0-dev"
```

For compiled binaries `SHEMMA_VERSION` is baked in via `bun build --compile --define`, so they always report the right thing. But in dev/source mode (`bun packages/shemma-cli/src/index.ts daemon start`) — when there is no env var — the resolver fell back to `pkg.version`. After a release that field is the *just-shipped* version, so any subsequent commit on `main` (or a feature branch off it) reports the same number until the next release commit. With the new policy of *not* tagging every merge, this drift is now permanent until release.

### The fix

`resolveVersion()` now uses a 3-step fallback chain:

1. `SHEMMA_VERSION` env (release binary — wins immediately).
2. `git describe --tags --abbrev=7 --always --dirty` from the repo root.
3. `pkg.version + "-dev"` (non-git environments — CI artifacts, npm tarballs).

On a clean tag checkout `git describe` returns the bare tag (e.g. `0.21.7`). N commits past the tag → `0.21.7-5-gabc1234`. With uncommitted edits → `0.21.7-5-gabc1234-dirty`. So `/api/version` (and therefore the SharePanel chip and `shemma version`) now reports a precise position relative to the last release without us needing to tag every merge.

`gitDescribe()` is resilient: non-zero exit, missing git, or non-repo cwd → returns `null` → falls through to `pkg.version + "-dev"`. Compiled binaries are unaffected because the env-shortcut runs before `gitDescribe()`.

### Tests

`apps/backend/src/__tests__/version.test.ts` — 9 tests covering:

- `SHEMMA_VERSION` env wins over describe + pkg.
- Clean tag, ahead-of-tag, and dirty describe outputs are returned as-is.
- Empty env + `describe() → null` falls back to `pkg.version + "-dev"`.
- Empty-string `SHEMMA_VERSION` is treated as unset (falls through).
- `gitDescribe()` integration check on the real repo.

`resolveVersion()` is DI-friendly: tests inject `env`, `describe`, `pkgVersion` directly, so no `spawnSync` mocking.

### Out of scope

`packages/shemma-cli/src/lifecycle.ts` `printStartupBanner()` still reads `process.env.SHEMMA_VERSION` first and falls back to its own `pkg.version` (no `git describe`). Banner only renders during daemon startup — backend `/api/version` is the primary user-facing consumer (SharePanel chip, `shemma version`). CLI banner cleanup is a follow-up.

---

## 0.21.7 — 2026-05-22 — DRW-123 CLI test XDG isolation (stop leaking orphans into real registry)

PATCH test infra hardening.

### The bug

CLI subprocess tests spawn `bun CLI ...` with inherited `process.env`. `@shemma/spaces` resolves the registry path via `${XDG_CONFIG_HOME ?? ~/.config}/shemma/spaces.json`. Without XDG isolation, every `--storage <tmpdir>` / `shemma s add <tmpdir>` test path got registered in the **user's real** `~/.config/shemma/spaces.json` and stayed there as an `ORPHANED` entry after the tmpdir was deleted by the test cleanup.

Manifested as 5+ "Default (from --storage)" / "shemma-env-storage-*" / "custom-storage-*" / "shemma-banner-base-*" cards on the landing page after `bun test`.

### The fix

5 test files updated to create a per-test-file `xdg` tmpdir in `beforeAll`, pass `XDG_CONFIG_HOME=<xdg>` in every `Bun.spawn` env, and `rmSync` it in `afterAll`:

- `tests/banner.test.ts`
- `tests/daemon-storage-flag.test.ts`
- `tests/doctor.test.ts`
- `tests/storage-interactive.test.ts`
- `tests/zero-arg-open.test.ts`

Existing tests `cli-deprecation.test.ts` and `drw-116-smoke.test.ts` already had this pattern — pattern is now standard across CLI suite.

### Verification

```
$ bun packages/shemma-cli/src/index.ts s list --plain   # before tests
ID         LABEL    PATH                                  LAST USED
di-draw    di.draw  …etyakov_dv/Projects/sandbox/di.draw  2026-05-22
elkonizr            …tyakov_dv/Projects/sandbox/elkonizr  2026-05-22

$ bun test  # 1164 pass / 0 fail

$ bun packages/shemma-cli/src/index.ts s list --plain   # after tests
ID         LABEL    PATH                                  LAST USED
di-draw    di.draw  …etyakov_dv/Projects/sandbox/di.draw  2026-05-22
elkonizr            …tyakov_dv/Projects/sandbox/elkonizr  2026-05-22
```

Registry stays clean — no orphan ingress.

### Recorded as project convention

`feedback-cli-tests-xdg-isolation.md` memory — pattern is required for any new CLI subprocess test.

## 0.21.6 — 2026-05-22 — DRW-122 `--version` flag + SharePanel spacing

PATCH polish.

### `--version` / `-V` flag

Раньше `shemma --version` падал в zero-arg fall-through → `lifecycle.open()` запускал daemon и открывал browser. Лишнее side effect для тривиального query.

**Fix:** `packages/shemma-cli/src/index.ts` — flag handler перед zero-arg веткой, вызывает `cmdVersion()` и `return`. Симметрично `--help` / `-h`. Также работает `-V` alias.

### SharePanel spacing

Gap между `← Gallery` button и version chip был меньше чем gap между version chip и `room: <id>` chip (визуальный disbalance). Причина: gap внутри `RoomBadge` flex container = 4px, между `GalleryLink` и `RoomBadge` — natural tldraw spacing (~0–2px).

**Fix:** обернул `GalleryLink` + `RoomBadge` в SharePanel wrapper с `display: inline-flex; gap: 6`. Внутренний gap у `RoomBadge` тоже bumped 4 → 6 для consistency.

## 0.21.5 — 2026-05-22 — DRW-121 cwd-aware open: `shemma` resolves to space gallery

PATCH feature. Зеркальный fix для запуска из терминала: `shemma` без аргументов теперь резолвит cwd к зарегистрированному space и открывает gallery того space, а не legacy `?room=default` URL (который после DRW-120 redirect'ится на landing).

### New behavior

`shemma` zero-arg / `shemma open [<room>]` flow (полностью переписан `lifecycle.open()`):

1. **cwd инсайд зарегистрированного space** (exact path или поддиректория) → URL = `/?space=<id>` (gallery) или `/?space=<id>&room=<room>` если задан room arg.
2. **cwd НЕ зарегистрирован, но имеет `.shemma/canvas/`** → авто-регистрация как `project`-layout space + URL = `/?space=<new-id>`.
3. **cwd без всего** → URL = `/` (landing) — SpacesPage с возможностью Add a space by path.
4. **`--storage <path>`** (legacy compat) → регистрация как `direct`-layout space + URL = `/?space=<id>`.

Никаких больше `SHEMMA_STORAGE_DIR` env propagation в child daemon (singleton resolves per-space сам через middleware). Никаких "daemon-conflict" exits — singleton не конфликтует с самим собой.

### Test plan

| Command | cwd | URL |
|---|---|---|
| `shemma` | `~/Projects/sandbox/di.draw` (registered) | `?space=di-draw` |
| `shemma` | `/tmp/<empty>` | `/` (landing) |
| `shemma open default` | `~/Projects/sandbox/di.draw` | `?space=di-draw&room=default` |
| `shemma --storage /tmp/foo` | any | `?space=<auto-id>` (direct-layout) |

Verified manually after restart.

### Removed (dead code)

- `lifecycle.ts`: `promptForMissingStorage` + `isInteractive` (interactive 3-option prompt больше не нужен — landing берёт на себя UX).
- `lifecycle.ts`: `_resolveOpenStorage` test-only export (использовался legacy tests).
- Импорты `start` (вместо него `ensureSilent`), `getRunningDaemonStorage`, `createInterface`, `resolveStorageForOpen`, `OpenStorageResolution`.

### Test changes

- `tests/zero-arg-open.test.ts` полностью переписан: drop conflict-detection / canvas-dev / `?room=` URL assertions; добавлены 4 теста под новый контракт (landing fallback / auto-register / room threading / --storage legacy).
- `tests/storage-interactive.test.ts` обновлён: non-TTY без `.shemma/` больше не fail-fast, а opens landing.
- `tests/banner.test.ts` обновлён: `storage:` row теперь показывает space-path (не synthesized `canvas-dev` subdir).

## 0.21.4 — 2026-05-22 — DRW-120 first-run UX hotfix (SHEMMA_STORAGE_DIR orphan + legacy URLs)

PATCH bugfix. После 0.21.3 release всплыли два связанных регресса при первом запуске:

### Issue 1 — Recursive `default` orphan space

`shemma` zero-arg → `lifecycle.open()` всегда экспортит `SHEMMA_STORAGE_DIR=<cwd>/.shemma/canvas` для child daemon (legacy compat path). Backend на старте видит эту env и auto-регистрирует путь как space `default` с layout `direct` — даже если cwd уже зарегистрирован как `project`-layout space. Получается nested orphan вида `di-draw/.shemma/canvas` рядом с настоящим `di-draw`.

**Fix:** `apps/backend/src/index.ts` — перед `registerSpace` проверяем что путь не лежит внутри уже зарегистрированного space (`listSpaces().find(s => storageDirAbs === s.path || startsWith(s.path + sep))`). Если внутри — skip + warn log "SHEMMA_STORAGE_DIR points inside registered space 'X' — skipping auto-register".

### Issue 2 — Legacy `?view=gallery` / `?room=` без `?space=` → listRooms 400

Pre-DRW-116 bookmarks (`/?view=gallery` или `/?room=default`) рендерили `<Gallery space={LEGACY_SPACE_ID} />` / `<App space={LEGACY_SPACE_ID} />`. После DRW-116 backend middleware regex-rejects sentinel `__legacy__` (`SPACE_ID_PATTERN.test("__legacy__")` = false) → 400 `invalid_space_id` → "Failed to load rooms: listRooms 400".

**Fix:** `apps/frontend/src/main.tsx` — если URL содержит legacy params (`?room=` / `?view=gallery`) без `?space=`, через `history.replaceState(null, "", "/")` зачищаем и рендерим SpacesPage. User видит чистую landing вместо broken Gallery.

### Issue 3 — Path display: `/Users/<username>/...` вместо `~/...`

В SpacePickerPanel (landing + Open Space dialog) пути отображались абсолютные (`/Users/tretyakov_dv/Projects/sandbox/di.draw`). Менее читаемо + раскрывает username.

**Fix:** новый shared helper `tildify(abs, home)` в `spaces/format.ts`. Применён в SpacePickerPanel rows; SpacePathButton (Gallery header) переключён с локального `prettyPath` на `tildify`.

### Out of scope (отложено)

- Полный rewrite `lifecycle.open()` для pure-space world (auto-register cwd как project-layout space + open `?space=X` URL вместо legacy `?room=`). Pre-existing legacy code path, не блокер. См. DRW-120 follow-up.

## 0.21.3 — 2026-05-22 — simplify pass: dead code, dup helpers, design-tokens, race fix

PATCH cleanup. xhigh-effort `/simplify` over DRW-117 + DRW-118 diff. Fixed all Critical + Important findings, deferred Minor.

### Removed dead code

- `apps/frontend/src/styles.css`: `.multi-col / .col / .splitter-bar` rules (MultiColumnLayout deleted in 0.21.1 but CSS left behind).
- `apps/backend/src/routes/spaces.ts`: local `revealCommand()` helper — replaced by shared.
- `apps/frontend/src/spaces/api.ts`: duplicate `getSession` / `expandHomePath` (mirror of `transport/session.ts`) — single source of truth in transport.
- Dynamic `await import("./api")` in `SpacePickerPanel.forget()` — replaced with top-level static import.

### Shared helpers extracted

- `packages/shemma-spaces/src/reveal.ts` → `platformRevealCommand()`. Used by both backend `/api/spaces/:id/reveal` and CLI `shemma s reveal`.
- `apps/frontend/src/spaces/api.ts` → `probeSpacePathApi()`, `getSpaceApi()`, `revealSpaceApi()`. All `/api/spaces*` traffic now goes through wrappers (no inline `fetch` in components).
- `apps/frontend/src/gallery/SpacePathButton.tsx` — extracted from `Gallery.tsx` header IIFE.

### Design tokens

`apps/frontend/src/design-tokens.ts` got: `bgPage`, `bg`, `backdrop`, `dangerBg/Border/Text`, `successBg`, `badgeBg/Border/Text`. All inline color literals в `SpacePickerPanel.tsx` / `OpenSpaceDialog.tsx` / `SpacesPage.tsx` заменены токенами (соответствие §3.8).

### State / robustness

- `SpacePickerPanel`: collapsed `listError` + `status:error` into one `Status` union with explicit `loading` / `submitting` states. Submit disabled until first refresh completes (race fix: ранее submitPath мог отработать с пустым `spaces` списком пока list ещё грузится).
- `useEffect` cleanup flag в `SpacePickerPanel` (mirrors Gallery pattern) — no more setState-after-unmount.

### Version sync

5 внутренних `package.json` всё ещё были `0.22.0` после 0.21.x renumber. Теперь все 8 packages на `0.21.3`.

### Tests

1167/0 fail. `apps/frontend/src/transport/session.test.ts` обновлён для нового `ok` check + `home` field.

## 0.21.2 — 2026-05-22 — DRW-118 restyle SpacesPage landing in card design

> **Renumber 2026-05-22:** теги `0.22.0` / `0.22.1` / `0.22.2` переименованы post-hoc в `0.21.0` / `0.21.1` / `0.21.2` — заполняем пропущенный 0.21.x gap (изначально DRW-116 маркировался как 0.22 потому что pre-1.0 MINOR с breaking changes; решили вернуть monotone progression). Release-коммиты с сообщениями "release: 0.22.X" остались в истории как artifact, теги `0.21.X` указывают на те же commits. Local-only repo — bookmarks не сломались.

PATCH UX fix: post-0.21.1 коррекция. Landing `/` рендерил `SpacesPage` в legacy bullet-list стиле — голый `<ul>`, кнопки браузера-default, никаких отступов. Переписано под тот же card-стиль что у `OpenSpaceDialog`.

### Changes

- Новый shared компонент `SpacePickerPanel` — инкапсулирует list + path-input form + state (status, confirm-init, error). Используется и в `OpenSpaceDialog`, и в `SpacesPage`.
- `SpacesPage` — centered card на bg-fill page с header "shemma · Spaces" и тем же body что у dialog'а. Forget action вынесен в правую часть row'а.
- `OpenSpaceDialog` — тонкий wrapper над `SpacePickerPanel` (backdrop + close button).
- Удалён `AddSpaceForm.tsx` (заменён единым path-input в panel).
- Badge'и `LEGACY` / `ORPHANED` рядом с label для visibility.

## 0.21.1 — 2026-05-22 — DRW-117 simplify spaces UI: drop multi-column, add Open Space switcher

PATCH UX fix: post-0.21.0 коррекция. Multi-column `?cols=A,B,C` URL-syntax + `MultiColumnLayout` оказались over-engineering — реальный сценарий это переключение между галереями, не side-by-side comparison. Возвращаемся к single-gallery view с быстрым switcher-диалогом.

### UX changes

- **URL grammar упрощён.** Поддерживаются: `/` (landing — список всех spaces), `?space=<id>` (gallery того space), `?space=<id>&room=<id>` (room в этом space). `?cols=` удалён полностью.
- **Gallery header** теперь показывает путь _текущего_ space (через `GET /api/spaces/:id`), а не daemon CWD. Путь кликабельный — открывает папку в Finder/Explorer/xdg-open через новый `POST /api/spaces/:id/reveal`.
- **"Open Space" button** рядом с path → modal со списком зарегистрированных spaces (клик = switch) + path-input снизу. Path-input:
  - existing space → switch;
  - path с `.shemma/canvas/` → register + switch;
  - path без `.shemma/` → confirm "initialize?" → register + switch;
  - missing path → inline error.
- **Legacy `?room=`** route без `?space=` сохранён (рендерит App / Gallery с `LEGACY_SPACE_ID`).

### Removed

- `MultiColumnLayout`, `SplitterBar`, `column-transitions.ts`, `widths.ts` и их тесты (`__tests__/column-transitions.test.ts`, `__tests__/widths.test.ts`, `__tests__/transitions-roundtrip.test.ts`).
- `Column`-aware ветка в `parseShemmaUrl` (теперь возвращает discriminated union `landing|gallery|room`).
- `onRoomOpen` / `onBackToGallery` / `RoomCard.onOpen` props — больше нет in-place column transitions.

### New backend endpoints

- `POST /api/spaces/:id/reveal` — spawn OS reveal command (`open` / `xdg-open` / `explorer`). 404 если space не зарегистрирован или path исчез.
- `POST /api/probe-space-path` — резолвит абсолютный путь + проверяет наличие `.shemma/canvas/`. Используется Open Space dialog для confirm-init UX.

### Migration

- Старые `?cols=` URL'ы (если кто-то их сохранил) теперь резолвятся как `landing` view (params вообще не парсятся). Live URL bookmarks `?space=` / `?room=` не затронуты.

## 0.21.0 — 2026-05-22 — DRW-116 singleton daemon + spaces registry + multi-gallery

MINOR feature: переход от per-project daemon (отдельный port для каждой папки) к глобальному singleton daemon с composite-key `(spaceId, roomId)` и spaces registry в `~/.config/shemma/spaces.json`. Legacy `~/.claude/projects/*/canvas/*.json` мигрирует автоматически на первом старте; default space сохраняет совместимость для клиентов, которые ещё не присылают `?space=<id>`.

### Breaking changes

- **Port now shared между release и debug profiles** — оба профайла используют `8787` (был раздельный `8788` для debug). Dev profile остаётся на `8788` (Vite HMR). Старая конфигурация `SHEMMA_PROFILE=debug` со старым port не пробрасывается.
- **mkdir-lock формат** изменён: PID-handshake + metadata file внутри `~/.shemma/run/<profile>.lock/`. Старые `.pid` файлы игнорируются (graceful → создаётся новый lock).
- **`SHEMMA_STORAGE_DIR` deprecated** — переменная всё ещё работает (auto-registers как space `default` + warning в stderr), но новые установки должны использовать `shemma s add <path>`.
- **`--storage <path>` CLI флаг deprecated** — аналогично, auto-translates в space registration + warning.

### Added

- **Singleton daemon** с mkdir-lock-based PID handshake (`@shemma/lockfile` shared package). `shemma daemon status` читает metadata, idle-shutdown (30 min default) graceful flush'ит room cache + releaseLock.
- **`@shemma/spaces` package** — file-backed registry с `proper-lockfile` concurrency, id-gen с storage layouts (`direct` / `claude` / `shemma`), `DebouncedTouch` для `lastUsedAt` updates на data-op activity.
- **`/api/spaces` CRUD** с local/public DTO split — public DTO без абсолютных путей (privacy на frontend и MCP).
- **`spaceMiddleware`** на `/api/*` — enforces composite-key `(spaceId, roomId)` invariant (spec §6.2). Fallback на `default` space если `?space=` отсутствует. Allowlist: `/api/health`, `/api/version`, `/api/session`, `/api/active-rooms`, `/api/export/miro/boards`.
- **Per-space Rooms bundles** в backend — каждый space владеет собственным `Rooms` map + `SingleSpacePersistence` adapter, `RoomCache` singleton keyed по `(spaceId, roomId)`.
- **WS subscriptions scoped by `(space, room)`** composite key — concurrent `?space=A&room=X` и `?space=B&room=X` не пересекаются.
- **CLI top-level positional** — `shemma <abs-path>...` регистрирует spaces + открывает браузер на `?space=<id>`. `shemma s {list,add,forget,rename,prune,reveal}` subcommands для управления registry.
- **Frontend multi-column gallery** — spaces landing page, URL routing с `cols=` syntax, active column tracking, resizable splitter, within-column gallery↔room transitions.
- **MCP space-aware tools** — все tools принимают optional `space?: string`. Resolver: explicit > CWD > `default` > ambiguous (с error payload, который НЕ содержит абсолютных путей — privacy per spec §3 + §8.3).
- **Legacy migration** — на первом запуске daemon сканирует `~/.claude/projects/*/canvas/` и автоматически регистрирует найденные директории как `legacy-*` spaces, первый становится `default`. Idempotent (skipped когда `spaces.json` уже существует). Override через `SHEMMA_SKIP_LEGACY_MIGRATION=1`.

### Fixed (final review blockers)

- **C1:** `startServer` теперь автоматически передаёт `enableSpaceMiddleware: true` в production daemon. До фикса middleware был включён только в integration тестах — production daemon не enforced composite-key invariant.
- **W1:** `spaceMiddleware` fallback'ит на `default` space при отсутствии `?space=` (вместо 400) — спасает legacy клиенты, которые ещё не пересланы на новую query-string схему.
- **W2:** MCP `resolveSpace` ambiguity error больше не утекает абсолютные пути файловой системы в LLM context (только `id` + `label`).
- **W3:** `DebouncedTouch` подключён к `spaceMiddleware` через `onResolve` callback — `lastUsedAt` теперь обновляется при data-op activity, а не только при `registerSpace` / `s rename`. Flush в graceful shutdown chain.

### Tests

- **989 pass / 0 fail** across 5 packages (backend 498 + cli 67 + mcp 193 + spaces 17 + domain 42 + root + frontend 192). Baseline на старте фазы — 932 tests; добавлено 57 новых тестов (per-space isolation, middleware edge cases, MCP integration, legacy migration, smoke matrix, default fallback, privacy redaction).

### Affected (high-level)

- New packages: `@shemma/spaces`, `@shemma/lockfile`.
- Backend: `apps/backend/src/index.ts`, `apps/backend/src/middleware/space.ts`, `apps/backend/src/room-cache.ts`, `apps/backend/src/routes/_space-context.ts`, `apps/backend/src/routes/spaces.ts`, `apps/backend/src/migration/legacy-spaces.ts`.
- CLI: `packages/shemma-cli/src/index.ts` (top-level positional + `s` subcommands), `packages/shemma-cli/src/daemon.ts`.
- MCP: `packages/shemma-mcp/src/space-resolver.ts`, все tool handlers пробрасывают `space?: string`.
- Frontend: multi-column layout, spaces landing, URL parser/serializer.
- Docs: `docs/superpowers/specs/2026-05-21-global-daemon-spaces-design.md` v0.3, `docs/superpowers/plans/2026-05-21-global-daemon-spaces-plan.md` v0.2, `docs/manual-tests/drw-116-global-daemon-spaces.md`.

---

## 0.20.3 — 2026-05-21 — DRW-113 note schema backfill

PATCH fix: AI-generated note shapes (через `shemma_note` / `define role=note`) ломали `loadSnapshot` валидацию, потому что не включали required tldraw 5.x props. Canvas рендерился пустым для любой комнаты с note-shape — disk-данные были валидны, отбраковывал client-side schema validator.

### Fixed

- `apps/frontend/src/canvas/schema-placeholder.ts:backfillStoreRecords` теперь чинит `note.props.labelColor` (default `"black"`) и `note.props.textFirstEditedBy` (default `null`) — defaults мирят tldraw migrations `AddLabelColor` + `AddFirstEditedBy`. Идемпотентно: уже валидные notes не мутируются.

### Tests

- 3 новых unit-теста в `schema-placeholder.test.ts` (full backfill + partial backfill + idempotency). Frontend suite: 101 pass / 0 fail.
- Verified в браузере: room `adv-4276-allure-infra-v2` (42 shapes + 38 bindings, включая yellow sticky-note) теперь рендерится полностью, console чистая.

### Affected

- `apps/frontend/src/canvas/schema-placeholder.ts` (+22)
- `apps/frontend/src/canvas/schema-placeholder.test.ts` (+50)

Backend-сторона (root cause — `shemma_note` payload без required props) — отдельная задача DRW-114.

---

## 0.20.2 — 2026-05-20 — DRW-103 phase code-simplifier pass (-8 LOC)

PATCH chore: 3-agent /simplify review (reuse, quality, efficiency) на DRW-103 phase diff (0.19.0..0.20.1). Без изменений observable behavior.

### Refactored

- **Efficiency:**
  - `apps/backend/src/export/miro/builder.ts` O(A×N) → O(N+A): `buildArrowEndpointsIndex` строит endpoints map одним проходом, переиспользуется через `ConnectorBuilderCtx.endpointsIndex` вместо per-arrow store scan.
  - `apps/backend/src/export/miro/upload.ts`: `resolvePageBounds` cached в `Map<id, bounds>` (двойной вызов на shape устранён).
  - `expandFrameDescendants` O(N×depth) → O(subtree) через `buildChildrenIndex` (one-pass parent→children map).
  - `expandImplicitArrows` reuses `buildArrowEndpointsIndex` вместо собственного binding-scan.
  - `routes/export.ts`: `rebuildDidrawIndex` перемещён после dryRun guard (skip O(N) walk на preview-запросах).
- **Quality:**
  - Module-level constants: `TEXT_ALIGN`, `TEXT_VALIGN`, `ARROW_DASH` (вместо per-call object allocation в `buildShapePayload` / `buildConnectorPayload`).
  - `applyPositionAndParent` helper устраняет copy-paste из 4 `buildXxxPayload` return blocks.
  - `passAMap` manual merge → `new Map([...frameMap, ...itemMap])` spread.
  - `expandFrameDescendants` uses existing `isFrameLike` helper (inline duplicate check removed).
  - `shemma-cli/src/config.ts`: `assertSupportedKey` extracted из 3 copy-pastes.
  - Удалён redundant `?? undefined` на optional cast.
  - `apps/backend/src/config.ts`: убран duplicate `import * as path` (named imports `dirname`/`join`/`basename` уже доступны).
- **Comment hygiene:**
  - Удалены 9 task-ref комментариев (`DRW-088`, `DRW-103`, `§X.Y` spec refs) из `App.tsx`, `chrome/TldrawComponents.tsx`, `schemas.ts`. Task references принадлежат git log + CHANGELOG, не source.

### Не применено (judgement)

- `richTextToPlain` consolidation с `richTextToString` (domain/context.ts) — разная semantics (newline separator critical для Miro multiline).
- `mapHttpResponse` в MCP `export-miro.ts` — works as-is.
- `pass-a1/a2/b` stringly-typed phase prefix в `RunExportResult.error` — deferred (low impact).
- `nearestShapeColor` rename → `normalizeHex` — judgement call.

### Tests

- **756 pass / 0 fail** across 5 packages (backend 447 + cli 164 + mcp 145 + domain 67 + root 8). Frontend tsc clean.

### LOC

- **8 files changed**, +123 / -131 lines (−8 net).

---

## 0.20.1 — 2026-05-20 — Visual fidelity: text-align, arrow dash, implicit arrows

PATCH: live verify в Miro показал 3 разрыва visual fidelity vs shemma canvas (4-й — Miro caption position — fundamental limitation, документирован):

### Fixed

- **Text alignment** (`buildShapePayload`): экспорт читает `props.align` / `props.verticalAlign` и маппит в Miro `textAlign` + `textAlignVertical`. tldraw default `middle`/`middle` → Miro `center`/`middle`. Раньше Miro default `left`/`top` → текст в shapes съезжал в угол.
- **Arrow dash style** (`buildConnectorPayload`): экспорт читает arrow `props.dash` и маппит в Miro `strokeStyle`. `dashed → dashed`, `dotted → dotted`, `draw/solid → normal`. Также установлены `strokeColor: #1a1a1a` + `strokeWidth: 2.0` (Miro default opacity 0). Раньше dashed arrows импортировались как solid.
- **Implicit arrows** (`upload.ts` — `expandImplicitArrows`): после frame-children expansion, walk store bindings: для arrow где BOTH endpoint'а в expanded selection → добавляется в selection даже если tldraw mutex его исключил. Раньше: arrow внутри frame (соединяющий 2 frame children) пропадал из export — frame создавался с двумя disconnected shapes.

### Tests

- 1 new test "frame in selection without arrow between children → arrow auto-included" — verifies expanded arrow appears as connector. Backend total: **447 pass / 0 fail**.

### Known limitation (not fixed)

- **Miro caption position** — captions на connector в Miro inline (along the line). В shemma label рендерится поперёк (perpendicular). Miro REST API не поддерживает perpendicular caption orientation — fundamental SDK limitation, accept as-is.

---

## 0.20.0 — 2026-05-20 — Frame children auto-expansion (DRW-105)

MINOR: при export'е, если frame в selection — все его descendants автоматически включаются. Раньше tldraw Cmd+A frame-mutex исключал children → exported frame был пустым контейнером в Miro, а arrows с endpoints внутри frame skipped как cross-selection. Теперь frame export "just works" по intuitive expectations.

### Added

- **`expandFrameDescendants` helper** (`apps/backend/src/export/miro/upload.ts`) — recursive walk store для всех shapes с `parentId` chain leading к selected frame (`type === "frame"` или `meta.role === "boundary"`).
- Применяется в `runMiroExport` ДО `expandGroups` — first expand frame → leaves, then expand groups → individuals.
- Nested frames поддерживаются (frame-in-frame → recursively walks).

### Behavior change

- **Before 0.20.0:** `selection = ["shape:F"]` → exports только frame (Miro frame пустая); arrows c endpoints в frame children → `cross-selection-connector` skip.
- **After 0.20.0:** `selection = ["shape:F"]` → exports frame + all descendants; arrows resolve correctly.
- Backward compat: `selection` уже содержащий frame children — no double-count (Set-based dedup).

### Tests

- **2 new tests** в `upload.test.ts`: (1) single frame selection → 3 items (frame + 2 children); (2) nested frame → 3 items recursive walk. Backend total: **446 pass / 0 fail**.

### Affects

- Frontend Cmd+A in room с frame: теперь frame's children в export автоматом.
- MCP `shemma_export_miro` с selection включающим frame ID: same behavior.
- Curl с raw selection: same.

---

## 0.19.4 — 2026-05-20 — didrawName → shape id resolution в export route

PATCH: frontend визуальный тест exposed что `App.tsx` маппит `editor.getSelectedShapeIds()` через `getDidrawName` → отправляет `selection: ["api-gateway", "shape:xxx", ...]` (смесь didrawName + raw ids). Backend lookup `store[id]` fail'ил для имён → `itemsCreated: 0` несмотря на правильный selection в UI.

### Fixed

- **`routes/export.ts`** — resolve `didrawName → shape id` через `rebuildDidrawIndex(room.store)` перед передачей в `runMiroExport`. Pass-through если value уже shape id. Имена и raw ids принимаются одинаково (consistent с domain endpoint contract).

### Verified

- Live frontend test через chrome-devtools MCP: `Cmd+A` → `⌘⇧E` → modal flow loading → pick (M.Shemma default) → confirm → exporting → result.
- Result: ✓ Exported 3 items + 1 connectors, 1 skipped (cross-selection arrow с endpoint вне Cmd+A selection — tldraw frame-children-mutex).

---

## 0.19.3 — 2026-05-20 — Visible default borders на shapes

PATCH: после 0.19.2 visual verify в Miro показал что shapes импортируются без видимых границ — только labels на пустом фоне. Root cause: Miro REST v2 defaults `borderOpacity: 0` + `fillOpacity: 0` → визуально пустые элементы.

### Fixed

- **`buildShapePayload` defensive defaults** (`apps/backend/src/export/miro/builder.ts`): для geo shapes теперь устанавливаются `borderColor: "#1a1a1a"`, `borderWidth: "2.0"`, `borderOpacity: "1.0"`, `borderStyle: "normal"` по умолчанию. `fillOpacity: "1.0"` если `meta.fillHex` задан, иначе `"0.0"` (preserves shemma `fill: "none"` default).
- User-provided `meta.fillHex` / `meta.borderHex` остаются source of truth — overriding defaults.

### Verified

- Live re-export room "export-smoke" → board "M.Shemma": все 5 shapes сейчас visible (borderColor #1a1a1a, width 2, opacity 1).
- 42 affected tests pass (builder/upload/routes/integration).

---

## 0.19.2 — 2026-05-20 — Frame-child positioning hot-patch

PATCH: post-0.19.1 live export вернул `400: "new position is outside of parent boundaries"` для frame children. Root cause — Miro REST v2 child position уэз `relativeTo: "parent_top_left"`, не `parent_center` как предполагалось в `upload.ts` math.

### Fixed

- **Frame-child coord math** (`apps/backend/src/export/miro/upload.ts`): для shapes с `parentId` указывающим на frame в `frameMap`, `miroX/miroY` теперь = `childPageCenter − parentPageTopLeft` (не `childPageCenter − parentPageCenter`). Centroid translation НЕ применяется к child position — только к top-level items.

### Verified

- Live export room "export-smoke" → board "M.Shemma" (`uXjVHQqmFVo=`): 5 items (1 frame + 4 shapes inc. 2 frame children) + 3 connectors created, 0 skipped. Tracking persisted в `room.meta.miroExports`.
- 9 upload tests still pass (existing tests only assert `parent.id !== undefined`, not exact positions — coord-math test gap для followup).

### Spec

- §5.1 + probe.md updated: Miro child position `relativeTo: "parent_top_left"` documented с math reference.

---

## 0.19.1 — 2026-05-20 — Miro export hot-patch (live probe findings)

PATCH: live probe против реального Miro API (board `uXjVHQqmFVo=`) обнаружил 3 расхождения с SDK-derived assumptions в 0.19.0. Без этих fix'ов Miro export feature НЕ работает в production.

### Fixed (post-probe)

- **`/items/bulk` request body format** — endpoint ожидает raw JSON array `[...]`, а не `{data: [...]}` wrapper (`apps/backend/src/export/miro/client.ts:bulkItems`). Без fix: 400 на каждый bulk POST с error `"Unexpected type of value, expected of type [Object]"`. Response shape `{data: [...], type: "bulk-list"}` остаётся parsed correctly.
- **`BULK_CHUNK_SIZE` 50 → 20** (`apps/backend/src/export/miro/upload.ts`). Miro вернул `400: At most 20 items could be created with a single request` на bulk с 60 items. Все chunks > 20 fail'ились. Test fixture updated (51 shapes → 21 shapes, expect 20 skipped + 1 created).
- **`nearestShapeColor` упрощён до identity** (`apps/backend/src/export/miro/color-mapping.ts`). Live probe принял arbitrary hex `#abcdef` без enum-error — Miro REST v2 не ограничивает `style.fillColor` 17 preset'ами (initial SDK-source analysis был overconservative). Pass-through сохраняет original user colors instead of snap'а к ближайшему swatch. Sticky notes остаются limited 16 named enum (`nearestStickyColor` без изменений).

### Confirmed (без изменений)

- `metadata` / `appData` fields rejected by Miro REST v2 with 400 (`"Field [metadata] is not supported"`). Уже было исправлено в 0.19.0 post-review fix — tracking client-side only в `room.meta.miroExports`.

### Verified

- Probe file: `apps/backend/src/export/miro/probe.md` содержит full raw Miro responses + DECISIONS APPLIED section.
- Backend suite: **444 pass / 0 fail** (тесты адаптированы для нового bulk format + chunk size = 20).

### Files

- Modified: `apps/backend/src/export/miro/{client,upload,color-mapping,probe.md}.ts`
- Modified: `apps/backend/src/export/miro/{client,upload,integration}.test.ts` + `apps/backend/src/routes/export.test.ts` + `apps/backend/src/export/miro/color-mapping.test.ts` (property test rewritten — now asserts normalized `#rrggbb` format вместо ∈ `SHAPE_PRESETS`).
- Modified: spec §4.2 + §6.2 inline.
- Modified: `package.json`, `packages/shemma-cli/package.json`, `packages/shemma-mcp/package.json` → `0.19.1`.

---

## 0.19.0 — 2026-05-20 — Export selection → Miro (DRW-103)

MINOR feature: structural export выбранных shapes из tldraw canvas в Miro board через REST API v2. Hotkey, context menu, MCP tool, CLI config subcommand. Backend-proxy architecture (token остаётся в daemon, не в browser).

### Added (DRW-103)

- **Export selection → Miro:** structural export of shapes, sticky notes, text, frames, and connectors from tldraw canvas to a Miro board via Miro REST API v2.
  - Triggers: `⌘⇧E` (Ctrl+Shift+E) hotkey, "Export to Miro" context menu item (visible when selection ≥ 1), MCP tool `shemma_export_miro` for AI agents.
  - Auth: developer non-expiring token via new `shemma config set miro.token <token>` subcommand. Stored chmod-600 в `~/.config/shemma/config.json`. Token validates on set (GET /v2/boards 401 → reject; offline → warn + save).
  - Three-phase upload: Pass A1 (frames bulk) → A2 (non-frame items with `parent.id` from A1) → Pass B (connectors, throttled 10 concurrent). Partial-commit semantics: `room.meta.miroExports` writes after each phase + each A2 chunk, survives mid-flight failures.
  - Coordinate translation: page-space resolution (frame children walked bottom-up via parentId chain) → centroid normalised to Miro `(0, 0)`. Frame-children carry parent-relative positions in Pass A2.
  - Color mapping: nearest Miro preset (Euclidean RGB) для shape `fillColor` — 16 hex enum + `#ffffff` default. Sticky-note `fillColor` — 16 named colors (`yellow`, `cyan`, etc.). `borderColor` принимает произвольный hex.
  - Group expansion: `expandGroups` recursively drops `type: "group"` records и возвращает leaf descendants.
  - Connector anchoring: tldraw 5.x binding records (`typeName: "binding"`, `props.terminal`, `props.normalizedAnchor`) → Miro `startItem.snapTo` через 0.25/0.75 thresholds.
  - Tracking: `room.meta.miroExports[boardId]` records `elementId → miroItemId` mapping for future update/diff flows. Envelope schema extension `meta?: RoomMeta` — additive optional, **no `ENVELOPE_SCHEMA_VERSION` bump** (stays at 3).
  - Per-chunk Pass A2 error handling: validation errors (4xx other than auth/404/429) skip whole chunk with `reason: "validation-error"`, остальные chunks продолжают. Fatal errors (`MiroAuthError` / `MiroNotFoundError` / `MiroRateLimitError`) abort pass; tracking из preceding chunks сохраняется.

### Files (new)

- Backend export module: `apps/backend/src/export/miro/{client,builder,color-mapping,coords,rich-text,tracking,upload,probe.md}.ts`
- Backend routes: `apps/backend/src/routes/export.ts` (POST `/api/export/miro` + GET `/api/export/miro/boards` с 5-min TTL cache).
- CLI: `packages/shemma-cli/src/config.ts` — `shemma config set/get/unset miro.token`.
- MCP: `packages/shemma-mcp/src/tools/export-miro.ts` — `shemma_export_miro` tool.
- Frontend: `apps/frontend/src/canvas/{export-miro-modal.tsx,export-hotkey.ts}` — 5-phase modal (loading→pick→confirm→exporting→result/error) + ⌘⇧E hotkey.
- Manual E2E: `docs/manual-tests/drw-103-miro-export.md` — 9-section checklist (CLI lifecycle / boards endpoint / modal flow / Miro visual / tracking persistence / context menu / MCP / edge cases / probe verification).
- Spec + plan: `docs/superpowers/specs/2026-05-19-export-miro-design.md` v0.2 (1829 lines, 15 sections) + `docs/superpowers/plans/2026-05-20-export-miro-plan.md` v0.2 (5782 lines, 18 tasks).

### Files (edited)

- `apps/backend/src/{types,envelope,config,index}.ts` — `RoomMeta` / `MiroExportsMap` types, envelope `meta?` plumbing, config file I/O (`configFilePath`, `readConfig`, `writeConfig`, `readMiroToken`, `writeMiroToken`, `unsetMiroToken`), route registration.
- `apps/frontend/src/{App.tsx,chrome/TldrawComponents.tsx}` — hotkey wiring + modal state + context menu item.
- `packages/shemma-cli/src/index.ts` — `config` subcommand routing + help text.
- `packages/shemma-mcp/src/{server.ts,schemas.ts}` — tool registration + `ExportMiroArgs` zod schema.

### Known limitations

- **Miro `metadata`/`appData` payload fields:** Task 1 probe (SDK source analysis) showed Miro REST v2 `ShapeCreateRequest` does NOT accept these. Tracking lives exclusively client-side in `room.meta.miroExports`. Live verification deferred — see `scripts/probe-miro.sh` + manual checklist §9.
- **Miro frame nesting:** Miro frames cannot nest (1-level cap). Inner frames in shemma selection become regular Miro shapes.
- **Rich text → plain only:** ProseMirror richText flattens to plain text on Miro side (bold/italic/links lost in MVP).
- **Append-only:** re-export creates fresh Miro items; tracking entries overwrite with new `miroItemId` (old items remain orphaned in Miro). Rollback / update via PATCH out of scope.
- **Color fidelity:** shape `fillColor` snaps to nearest of 16 Miro presets; sticky-note `fillColor` to nearest of 16 named colors. `borderColor` accepts arbitrary hex (no snap).
- **Free-floating arrows:** arrows without bindings → skipped with `reason: "unsupported-type"`.
- **Cross-selection connectors:** arrow with endpoint outside selection → skipped with `reason: "cross-selection-connector"`.

### Tests

- 445 backend pass / 0 fail (was 321 baseline → +124 DRW-103 tests across 11 new modules + 1 integration test).
- 67 domain pass / 0 fail.
- 164 cli pass / 0 fail (+9 config tests).
- 145 mcp pass / 0 fail (+3 export-miro tests).
- 8 root pass / 0 fail.
- **Total: 829 pass / 0 fail** across 5 packages.

### Code-simplifier pass

Post-implementation simplification (-201 LOC across 15 implementation files): removed file-header comments, forward-looking notes, task-reference comments, dead branches; consolidated `attachTracking` helpers. Behavior preserved.

### Phase-end review fix

Review identified `attachTracking` in `builder.ts` populated Miro-unsupported `metadata`/`appData` fields contradicting spec §10.2 + probe finding. Fix: removed `attachTracking` + `TrackingField` / `TrackingMeta` / `buildTracking` + 4 builder ctx fields + `metadata`/`appData` from `MiroBulkItem`/`MiroConnectorPayload`. -130 LOC. Tracking now lives solely in `room.meta.miroExports`.

### Followups

- DRW-104 (proposed) — live Miro API probe verification (`scripts/probe-miro.sh`).
- DRW-105 (proposed) — streaming progress in export modal.
- DRW-106 (proposed) — reverse-lookup index for tracking (miroItemId → elementId).
- DRW-107 (proposed) — connector concurrency rewrite with clean semaphore.

---

## 0.18.9 — 2026-05-19 — Code simplifier pass на stabilization diff (-109 LOC)

PATCH chore: упрощение кода stabilization-серии 0.18.0..0.18.8 без изменения наблюдаемого поведения. Никаких behavior changes, никаких bug fixes — только дедупликация и dead-code removal.

### Refactored

- **`apps/backend/src/domain/layout.ts` (1053 → 964, -89 LOC).** 7 simplifications:
  - `resolveArrowEndpoints` helper заменил 3 копии find-2-bindings+resolve паттерна (`buildEdges`/`buildElkGraph`/`runLayoutSubgraph`).
  - Удалён мёртвый код в `runPassA`: `ccChildren` с багой `!isLayoutCandidate === false`, неиспользуемая `ccFiltered`, дублирующий `ccFilteredActual`.
  - Удалён duplicate `anchorFrameIds` scan в `runLayoutSubgraph` (562-572 сразу затирался `.clear()` на 593) + неиспользуемый helper `getAncestorContainers`.
  - Single pass для `containerIds`/`frameIds`/`shapeById` prebuild в `runLayout` (было 3 прохода) + `Map.get` вместо O(n) `find` в origin-preservation.
  - `directSelectedChildrenOf(parentId)` helper заменил 3 копии `filter(s => s.parentId === X)`.
  - `sizeFor(s)` helper заменил повторяющийся `passARes ? passARes.newW : origB.w` паттерн.
  - `buildElkGraph`: `filterToIds` параметр был всегда `undefined`, удалена subgraph-ветка с anchor flag detection.
- **`apps/frontend/src/App.tsx` (-20 LOC).** Два helper'а:
  - `maybeZoomToAffected(editor, ids, ref)` — module-level helper заменил два идентичных блока (Tidy hotkey + context menu) с viewport-containment check + setTimeout-guard.
  - `runMermaidImport(source, requestId, focus)` — local closure в primary `useEffect` заменил два дубля `onImportMermaid` handler (initial syncer + recovery syncer после `truncated` event).
- **`apps/frontend/src/canvas/mermaid-import.ts`.** Перенесён orphan JSDoc-блок (стоял над `isBoundsContained`, относился к `unionBoundsOf`).

### Архитектурные инварианты (сохранены)

- `isContainerShape(s)` = `frame OR (geo + meta.role === "boundary")`.
- Origin preservation: translation `(centroid_orig - centroid_elk)` только для top-level positions, НЕ children parent-relative.
- `childToTopContainer` строится walk'ом по ВСЕМ shapes (не только selected) — критично для tldraw selection mutex.
- Pin discipline, group bbox writeback, `scope='all'` legacy single-pass — нетронуты.

### Tests

- 321 backend pass / 0 fail. 93 frontend pass / 0 fail. 142 mcp pass / 0 fail. Total: 626 pass / 0 fail across 5 packages.

---

## 0.18.8 — 2026-05-19 — Bundle workflow/*.md в SFE (DRW-063)

PATCH: `shemma_get_instructions` падал с `{"ok":false,"code":"read-error","message":"ENOENT: no such file or directory, open '/$bunfs/root/workflow/overview.md'"}` в released binary. Root cause — `readFileSync(join(HERE, "workflow/..."))` работал в dev (файлы рядом с исходниками), но в SFE `bun build --compile` делает виртуальную ФС `$bunfs/root/...` и workflow/*.md не были embed'нуты.

### Fixed

- **DRW-063 — embed workflow markdown в SFE.** `packages/shemma-mcp/src/resources.ts`: удалён `readFileSync` + `dirname/fileURLToPath`. Добавлены 5 статических `import X from "./workflow/X.md" with { type: "file" }` — Bun-native pattern, позволяет `bun build --compile` embed'ить файлы в virtual FS. `loadWorkflowMarkdown` рефакторена в `async function` с `Bun.file(pointer).text()`.
- **Error path hardening.** Оба catch-блока (resource callback и tool handler) больше не leak'ают `$bunfs` путь. Ошибка теперь: `{ok:false, code:"instructions-unavailable", message:"workflow asset not bundled — please file an issue"}`.
- `tools/instructions.ts`: `loadWorkflowMarkdown(topic)` → `await loadWorkflowMarkdown(topic)`.

### Tests

- 142 shemma-mcp pass / 0 fail. Добавлен `describe("loadWorkflowMarkdown")` с `.each(WORKFLOW_TOPICS)` — все 5 топиков читаются и возвращают непустой markdown. Добавлен тест на error path (не leak'ает `$bunfs`).
- Smoke-test SFE binary: `initialize` + `tools/call shemma_get_instructions` → non-empty markdown (`# Shemma — agent overview\n\n...`), без ENOENT.

---

## 0.18.7 — 2026-05-19 — Hierarchical layout: childToTopContainer over all shapes (DRW-099 v3)

PATCH: после 0.18.6 user dogfood показал что при Tidy на полной диаграмме (5+ containers + cross-compound edges) layering продолжает идти в случайном порядке (Внешний consumer at top вместо bottom, Оркестрация at bottom вместо top).

### Fixed

- **DRW-099 v3 — cross-compound edge remap over all shapes.** При tldraw selection mutex (user селектит frame → его children НЕ в filterToIds), `selectedLeaves` пустой → `childToTopContainer` map пустой → cross-compound edges от child одного frame к child другого дропались в Pass B remap (`rawSrc` и `rawTgt` оба `null` после lookup). ELK layered получал граф БЕЗ edges между containers → arbitrary order disconnected nodes. Fix: `childToTopContainer` теперь строится walk'ом по ВСЕМ shapes; `ascendToTopContainer(id)` поднимается по `parentId` chain до встречи с одним из `topLevelSelectedContainers`. Cross-compound edges корректно remap'ятся → ELK layered даёт правильный порядок (sources at top, sinks at bottom для TD).

### Tests

- 321 backend pass / 0 fail (нет regression). Existing DRW-099 hierarchical тесты уже покрывают cross-compound edge remap — фикс работает для всех existing cases.

---

## 0.18.6 — 2026-05-19 — Hierarchical layout: origin preservation (DRW-099 v2)

PATCH: после 0.18.5 hierarchical multi-pass user feedback показал что Tidy "центрирует схему на доске с zoom" — диаграмма прыгает в (0,0) после layout, smart-zoom fire'ил т.к. affected уехали из viewport. Корень — origin preservation была отключена в DRW-099 v1 при наличии selected containers (известное ограничение).

### Fixed

- **DRW-099 v2 — origin preservation для hierarchical layout.** В `apps/backend/src/domain/layout.ts`:
  - Centroid считается по top-level selected anchor shapes: containers с `parentId=page` + bare leaves at root level (исключая pinned и anchor frames).
  - Translation `(centroid_orig - centroid_elk)` применяется ТОЛЬКО к top-level positions — children parent-relative coords не трогаются (они уже относительно своего parent'а, translation бы их сломала).
  - Anchor frames из translation исключены (их позиции override'ятся к original в Pass C).

### Tests

- 321 backend pass / 0 fail. Existing DRW-099 hierarchical тесты остались зелёными (frame.props.h checks, children bounds в parent-relative coords).

---

## 0.18.5 — 2026-05-19 — Hierarchical multi-pass layout (DRW-099)

PATCH: closes последний dogfood-обнаруженный layout-bug сессии 2026-05-19. После 0.18.3 (DRW-092 v3 anchor-frame-grow) + 0.18.4 (DRW-098 geo+role=boundary recognition) — base case nested compounds лучше, но на сложных диаграммах (Mermaid с 5+ subgraphs + cross-edges + smart-select-all) single-pass ELK с `INCLUDE_CHILDREN` всё ещё линеаризовал всю цепочку leaves через cross-compound edges (user Image #16).

### Fixed

- **DRW-099 — hierarchical multi-pass layout.** В `apps/backend/src/domain/layout.ts` для subgraph mode (scope='affected' + filterToIds) реализован user-предложенный иерархический алгоритм:
  - **Pass A** (`runPassA`): рекурсивный ELK на children каждого anchor container (frame / geo+role=boundary). Дети получают parent-relative coords. Container w/h растёт под содержимое.
  - **Pass B** (`runLayoutSubgraph`): flat ELK на top-level selected shapes. Selected containers с детьми обработанными в Pass A — leaf nodes с computed sizes. Cross-compound edges remap'ятся в container-to-container edges.
- **Не задеты**: `scope='all'` path (single-pass через INCLUDE_CHILDREN, как раньше). Pin discipline (DRW-003). Parent-relative coords (DRW-082). Group bbox writeback (DRW-004). DRW-092 v3 anchor frame grow. DRW-098 geo+role=boundary container detection.

### Tests

- 321 backend pass / 0 fail (+6 для DRW-099): two-container-cross-edge, mixed root selection (frame+bare), nested anchor frames recursive, cross-compound edge remap, scope=all regression, integration test.

### Known limitations

- Cross-compound edge между child одного selected container и child другого, где second container — anchor (не в selection): edge дропается в Pass B (acceptable trade-off).
- Origin preservation отключена при mixed selections с containers — containers сами определяют центр кластера.
- 3+ уровень nesting (frame в frame в frame): работает рекурсивно но не тестировался напрямую.

---

## 0.18.4 — 2026-05-19 — Layout: geo+role=boundary распознаются как container (DRW-098)

PATCH следующий за 0.18.3. User dogfood (Image #15): Mermaid-imported диаграмма с nested `subgraph` блоками после Tidy раскладывается в одну горизонтальную линию вместо layered tree.

### Fixed

- **DRW-098 (partial) — layout распознаёт geo+role=boundary как container.** DRW-084 hybrid B рендерит Mermaid subgraphs как `geo + meta.role="boundary"` shapes с children через `parentId` — это semantic containers, но НЕ tldraw `frame`. До этого fix'а `apps/backend/src/domain/layout.ts` проверял только `s.type === "frame"` для container detection → boundary geos и их дети оказывались на одном root level → ELK раскладывал всё линейно. Добавлен helper `isContainerShape` (matches `context.ts` DRW-084 logic): `frame OR (geo + role=boundary)`. Все frame-type checks в layout.ts заменены: frames partition, frameIds set, anchor detection, parent-relative conversion, group bbox writeback. Mermaid subgraphs теперь корректно работают как anchor frames в Tidy selection — children flow inside layered, boundary растёт под содержимое (v3 grow logic).

### Known limitations

- Cases где user удаляет boundary shape с детьми (stale parentId) — отдельная задача DRW-098 AC#1-#4 (ungroup path).

### Tests

- 315 backend pass / 0 fail. Existing frame tests cover behavior (помечены `type:"frame"` в fixtures — те же тесты now also exercise `geo+role=boundary` path implicitly через `isContainerShape`).

---

## 0.18.3 — 2026-05-19 — Tidy UX: smart zoom + frame anchor grows layered (DRW-096, DRW-092 v3)

Dogfood feedback PATCH из той же сессии что и 0.18.2. Два фикса по UX Tidy:

### Fixed

- **DRW-092 v3 — anchor frame использует layered, growth вместо clamp.** Initial DRW-092 импл (shipped в 0.18.0) использовал ELK `rectpacking` algorithm + `FIXED_SIZE` constraint для anchor frame — дети пакались в угол, теряли layered ranking и edge routing (Image #12 от user 2026-05-19: graph внутри frame теряет всю структуру). v3: anchor frame использует тот же layered algorithm что и outer (опции `opts`). Frame **растёт** до ELK-computed compound size (w/h обновляется в `batch.updated`), x/y остаётся original. Дети flow naturally inside. Дропнули ~50 LOC scale-clamp logic + `anchorSpacingPx` — больше не нужны.
- **DRW-096 — Smart zoom: skip когда affected уже видны.** Auto-zoom после ⌘⇧L / Tidy раньше срабатывал безусловно с `userHasManuallyPanned` guard'ом. User feedback: "иногда мешает". Новое поведение: zoom только если post-layout affected bbox **не целиком в текущем viewport** (helper `isBoundsContained` в `apps/frontend/src/canvas/mermaid-import.ts`). Если уже видно — камера стоит. Вырезает 80% случаев navy autozoom без потери "уехали из viewport → найди их".

### Tests

- 315 backend pass / 0 fail (test "anchor frame not updated" → "anchor frame stays put, grows to fit").
- 93 frontend pass / 0 fail (+4 для `isBoundsContained` helper).

### Known limitations

- Mermaid-imported диаграммы с nested `subgraph` блоками (`geo+role=boundary` через DRW-084 hybrid B) — после ручного ungroup / удаления boundary shapes children остаются со stale `parentId` и могут давать неожиданный layout (см. user Image #14). Отдельная задача в backlog.

---

## 0.18.2 — 2026-05-19 — Daemon crash hotfix: conflicting WS user-change batches (DRW-094)

PATCH critical: daemon крашился на normal user interaction. Frontend WS accumulator может склеить rapid create→delete (typically binding записи при быстром draw+undo arrow'а) в один user-change frame с одной и той же id в `added` И `removed`. `applyStoreChanges` Phase 3.0 sanity throw считал это logic bug → uncaught async exception → процесс daemon dies.

### Fixed

- **DRW-094 — Daemon crash on conflicting batch.** `apps/backend/src/store-ops.ts:applyStoreChanges` больше не throws при id одновременно в added и removed. Natural order операций (added → updated → removed) корректно даёт removed-wins → net-no-record (что соответствует "user сделал create затем delete за один tick"). `apps/backend/src/index.ts` WS user-change handler обёрнут в try/catch как defense-in-depth — любая будущая ошибка apply дропает frame с `console.warn`, daemon продолжает работать.

### Tests

- 315 backend pass / 0 fail (+1 net): тест "rejects batch with same id" заменён на "removed wins" + binding-specific сценарий.

### Repro

1. Открыть room с shapes.
2. Быстро нарисовать arrow между двумя shapes (создаёт binding).
3. Сразу undo / delete arrow.
4. Frontend WS frame содержит binding в added+removed → backend крашится.

После fix: batch применяется (binding remove'нут), daemon живёт.

---

## 0.18.1 — 2026-05-19 — Mermaid import: remove placebo ELK frontmatter prepend (DRW-093)

Honest-path PATCH: `prependElkFrontmatter` (DRW-084 AC#6) фактически не работал — `@tldraw/mermaid@5.0.0` не регистрирует `mermaid-layout-elk` loader, а `@mermaid-js/layout-elk` не bundled. Mermaid при отсутствии запрошенного loader'а silent degrade'ит на DAGRE, поэтому auto-prepend создавал ложное впечатление работающего ELK render. User dogfood 2026-05-19 (Image #4) показал DAGRE-style output — это и есть реальное поведение.

### Removed

- `prependElkFrontmatter()` + `ELK_FRONTMATTER` константа в `apps/frontend/src/canvas/mermaid-import.ts`. Source теперь проходит в `@tldraw/mermaid.createMermaidDiagram` as-is.
- Соответствующие тесты в `mermaid-import.test.ts` (3 теста на auto-prepend сценарии заменены 1 регрессионным тестом "source passes through unchanged").

### Docs

- `packages/shemma-mcp/src/workflow/draw-architecture.md` — новая секция "Layout engine: DAGRE only (DRW-093)" с явным указанием что Mermaid import = DAGRE, для ELK output после import — `shemma_layout` / `shemma_layout_selection` (наш elkjs pipeline).

### Tests

- 89 frontend pass / 0 fail (−3 placebo tests, +1 регрессионный).
- 314 backend + 136 MCP без изменений.

---

## 0.18.0 — 2026-05-19 — Tidy selection: настоящий subgraph mode + frame anchor container

Hot-fix следующий после 0.17.0 dogfood-сессии. Tidy в 0.17.0 был сломан в primary use case (partial reorg): ELK строил graph на ВСЕХ shapes и потом pin'ил non-selected, поэтому selected перекрывали non-selected; shapes внутри tldraw `frame` вылетали из него. Теперь — true subgraph filter + anchor-frame compound в одном fix-пакете. Закрывает DRW-091 + DRW-092.

### Fixed

- **DRW-091 — true subgraph mode.** `buildElkGraph` принимает optional `filterToIds?: Set<string>`; при subgraph mode в ELK input попадают только selected leaves + edges, у которых **оба** endpoint'а в filter set. Старый pin-trick (`scope='affected' && !affectedIds.has(s.id) → pinnedSet.add`) удалён — non-affected больше не присутствуют в graph вовсе. После ELK включена **origin preservation**: ELK output транслируется на `(centroid_orig − centroid_elk)` (или anchor by pinned, если в выделении есть `meta.pinned`-shape), чтобы выделенная группа осталась рядом со своим оригинальным местом. `batch.updated` содержит только shapes из `filterToIds`. Покрывает: AC#1/#2/#3/#4/#5/#6/#7 — overlap test (4 shapes: 2 в кучу слева selected, 2 справа non-selected — после layout без пересечения), mixed shape types (geo + note + image + frame).
- **DRW-092 — frame anchor container.** `buildElkGraph` автоматически детектирует **anchor frames** — frame, который НЕ в `filterToIds`, но имеет ≥1 ребёнка в filter set. Такой frame включается как ELK compound node с `FIXED_SIZE` constraint (`frame.props.w/h` → container bounds, `rectpacking` алгоритм внутри); сам frame в batch не пишется. Parent-relative конверсия для детей anchor frame теперь корректно использует ELK output frame pos, а не оригинал. `parentId` детей сохраняется. AC#1/#2/#3/#4/#5/#6.

### Tests

- 680 tests pass: +7 backend integration (`routes-layout-selection.test.ts`: overlap, mixed types, frame parent, origin preservation, subgraph filter) + 2 unit (`domain/layout.test.ts`: subgraph mode positions, anchor frame children parent-relative).
- TDD: 2 atomic commits (test-first + impl), затем code-simplifier pass (`refactor(layout): remove dead frameOrigPos, inline selectedFrameIds, ...`) -32 LOC при 314/0 pass.

### Implementation notes

- Anchor frame detection — внутри `buildElkGraph`, без расширения `LayoutHint` API. Route `/api/agent/layout-selection` не изменялся.
- Origin preservation отключена, если есть anchor frame: frame стоит на месте, ELK layout'ит детей внутри его bounds через compound + padding `[top=40,left=20,bottom=20,right=20]`.
- При overflow (если ELK всё же выдаёт детей больше frame.w/h при `FIXED_SIZE` — edge case) применяется post-ELK scale+translate clamp, сохраняющий взаимные пропорции.
- Pin discipline (DRW-003) и DRW-082 frame parent-relative coords для `scope='all'` не задеты.

---

## 0.17.0 — 2026-05-19 — Tidy selection: localized ELK на subgraph (UI + MCP twin)

Selection-aware версия layout: правый клик / ⌘⇧L на выделение → ELK прогоняется через `runLayout(scope='affected', affectedIds=selection)` — pinned shapes защищены, non-selected не двигаются. MCP twin `shemma_layout_selection` для AI workflows (post-import tidying, partial reorg). Закрывает DRW-088.

### Added

- **Backend `POST /api/agent/layout-selection`** (`apps/backend/src/routes/layout-selection.ts`). Body `{ids: string[], mode?, spacing?}`. Принимает оба формата ids: `shape:xxx` (tldraw raw) и `didrawName` (через `r.didrawIndex` lookup). Резолвит к `affectedIds: Set<TLShapeId>`, передаёт в существующий `runLayout` с `scope='affected'` — pin discipline (`isPinned()`) автоматом защищает `meta.pinned===true` shapes. **AC#8 auto-mode detect:** если у всех selected shapes `meta.mermaidSource` и source содержит `flowchart/graph TB|LR|RL|BT` директиву — derive mode (`layered-tb|lr|rl|bt`). Edge cases: empty ids → 200 noop hint; single id → 200 noop hint; all unresolved → 400. `unresolved: [...]` field в response для debug.
- **MCP tool `shemma_layout_selection`** (`packages/shemma-mcp/src/tools/domain.ts`). Args: `{ids?: string[], mode?, spacing?, room?}`. Empty `ids` = full-canvas layout (equivalent `shemma_layout`). Tool description явно инструктирует AI: "use after `shemma_import_mermaid` to tidy just-added group without disturbing existing user layout".
- **`CanvasClient.layoutSelection({ids, mode?, spacing?, room?})`** в `packages/shemma-client/src/index.ts`.
- **Frontend Tidy UI:** context menu item "Tidy selection" в `TldrawComponents.tsx` (виден при `selectedShapeIds.length >= 2`), ⌘⇧L / Ctrl+Shift+L hotkey через `makeTidyHotkeyHandler` factory (`apps/frontend/src/canvas/tidy-layout.ts`). Auto-zoom через `unionBoundsOf(editor, affectedIds)` → `editor.zoomToBounds(..., {animation:{duration:200}, inset:64})`, DRW-075 `userHasManuallyPanned` guard.
- **Atomic apply:** mutations идут через WS `store-change` frame → `editor.store.mergeRemoteChanges` (existing path) — одна tldraw history step.
- **Workflow docs:** новая секция "Tidy selection" в `packages/shemma-mcp/src/workflow/draw-architecture.md` с use cases.

### Tests

- 673+ tests pass: +6 backend integration (`routes-layout-selection.test.ts`: pinned не двигается, non-selected не двигается, empty ids → noop, single id → noop, unresolved → 400, mermaidSource → mode detect), +7 MCP tool (`domain.test.ts`: schema, endpoint URL, body shape, empty ids delegation), +8 frontend unit (`tidy-layout.test.ts`: fetch + hotkey factory + edge cases).
- TDD discipline: test-first per логический step, 7 atomic commits.

### Visual smoke

End-to-end через chrome-devtools на dev-profile (room `drw-088-smoke`): Mermaid import → ⌘⇧L → POST /api/agent/layout-selection → 200 → zoomToBounds. Скриншоты в `docs/screenshots/drw-088-*.png`.

---

## 0.16.0 — 2026-05-19 — Mermaid subgraphs как domain groups + auto-zoom на новый bbox

Доработка `shemma_import_mermaid` после dogfood-сессии: Mermaid `subgraph` теперь корректно попадает в `shemma_context` как `type:"group", role:"boundary"`, а после import viewport анимированно зумится на bbox новых shapes. Закрывает DRW-084 + DRW-086. Дополнительный AC: автоматический preprend ELK frontmatter (`---\nconfig:\n  layout: elk\n---`) на источниках без frontmatter — компактнее baseline.

### Added

- **DRW-084 — Mermaid subgraphs ↔ domain groups.** Стратегия hybrid B: subgraph остаётся `geo` shape (tldraw frame не принимает `fill` props, которые `@tldraw/mermaid` baseProps мержит во все shapes — стратегия A через `mapNodeToRenderSpec`→frame архитектурно невозможна без monkeypatch lib). В `apps/frontend/src/canvas/mermaid-import.ts` post-process: shape с children (heuristic — `geo` + есть `c.parentId === s.id`) получает `meta.role = "boundary"`. В `apps/backend/src/domain/context.ts` `deriveType` теперь распознаёт `type === "geo" && meta.role === "boundary"` как `"group"`; `childrenByFrame` использует helper `isContainerShape`. Auto-prepend ELK frontmatter через `prependElkFrontmatter()`.
- **DRW-086 — Auto-zoom после import-mermaid.** В `App.tsx onImportMermaid` после успешного `importMermaid` вычисляется union bbox новых shapes (`unionBoundsOf`) → `editor.zoomToBounds(bounds, { animation: { duration: 200 }, inset: 64 })`. DRW-075 guard: `userHasManuallyPanned` пропускает auto-zoom. Optional `focus: "new" | "fit-all" | "none"` parameter сквозной wire-up (MCP → backend → WS → frontend), default `"new"`.

### Tests

- 668+ tests pass (frontend +9, backend +1 integration + 5 route, MCP +6, transport +5).
- TDD: frontend mock-tests caught wiring + edge cases; backend integration test verifies geo+role → group conversion; smoke test через chrome-devtools — verify visual + viewport.

### Known compromises

- **AC#3 визуальный** — subgraph рендерится как `geo` rectangle с label inside, а не как tldraw frame с heading сверху. Frame-стратегия (A) требует monkeypatch lib (frame schema не принимает fill/dash/size). Отложено до апстрима в `@tldraw/mermaid` либо custom shape util.

### Internal

- Регрессия DRW-084 v1 (frame ValidationError) поймана на dev-mode smoke через chrome-devtools — confirmed: фронт-моки `createMermaidDiagram` не покрывают валидацию реального lib. Hotfix через `hotfix/drw-084-frame-validation-fix` ветку → merge в main.
- DRW-088 (Tidy command) теперь unblocked.

---

## 0.15.0 — 2026-05-19 — shemma_import_mermaid MCP tool

Feature: `shemma_import_mermaid` MCP tool — AI теперь может импортировать Mermaid-диаграммы прямо на canvas без участия пользователя. Реализована через WS command path (option b): backend пересылает frame в открытый browser tab, frontend вызывает `@tldraw/mermaid.createMermaidDiagram`, shapes возвращаются через store-change sync. **Append-only:** инструмент всегда дописывает shapes, никогда не стирает existing canvas state — preserve user's manual layout edits — это hard invariant. Закрывает DRW-083.

### Added

- **DRW-083 — `shemma_import_mermaid` MCP tool.** Новый инструмент с параметрами `source` (mermaid source, обязательный), `room?`, `clientOpId?`. Возвращает `{shape_ids, didraw_names, root_ids}` для downstream `shemma_connect` вызовов. **APPEND-only** — нет `mode` параметра, AI никогда не wipes canvas. Wipe-операции — отдельный будущий `shemma_clear_room` с user-confirmation.
- **Backend `POST /api/agent/import-mermaid`.** Endpoint принимает `{room, source, clientOpId?}`, проверяет наличие WS-subscriber в room (503 если нет), генерирует `requestId` (UUID), отправляет WS frame первому открытому subscriber'у, ждёт результат до 10s (timeout → `500 {error:"client did not respond"}`). На 503 response включает `room_url` — AI agent открывает URL в браузере и retry-ит.
- **WS message kinds `import-mermaid` + `import-mermaid-result`.** Добавлены в `WsMessage` (backend→client) и `WsClientMessage` (client→backend) union типы. `WsHub.sendImportMermaid()` + `WsHub.resolveImportMermaid()` для управления pending promises.
- **Frontend `onImportMermaid` callback** в `startStoreSync`. При получении `import-mermaid` frame вызывает callback (App.tsx → `importMermaid(editor, source)`), отправляет обратно `import-mermaid-result`. Frontend всегда append'ит — никаких preprocessing-шагов.
- **`CanvasClient.importMermaid({source, clientOpId?, requestId?})`.** HTTP-метод для MCP layer через `POST /api/agent/import-mermaid`.
- **`ImportMermaidArgs` Zod-схема** в `packages/shemma-mcp/src/schemas.ts` (`source`, `room?`, `clientOpId?`).
- **MCP tool description** явно инструктирует AI: APPEND-only; `shemma_context` перед вызовом; retry по `room_url` на 503.
- Workflow docs обновлены: `shemma_import_mermaid` теперь primary path; ⌘M modal — manual fallback. Добавлены секции "Edit, don't redraw" + "Handling no-client-connected error".

---

## 0.14.4 — 2026-05-19 — Frame children parent-relative coords

Bug-fix релиз: после 0.14.3 (containers с visible header) обнаружено что children в multi-frame схемах оказывались off-screen — tldraw хранит x/y child shape с parentId=frame как parent-relative, но ELK runLayout писал absolute page coords. Закрывает DRW-082.

### Fixed

- **DRW-082 — Frame children coords parent-relative.** В `apps/backend/src/domain/layout.ts:runLayout` — collectPositions через walk-with-offset возвращает абсолютные page coords для всех shapes (включая children внутри frame). Apply loop писал их as-is в `shape.x/y`, но tldraw для shape с `parentId=frame_id` интерпретирует `x/y` как **parent-relative** — при render положение становится `parent.x + child.x`, что давало double-offset. Integration frame случайно работал (frame достаточно широкий чтобы render-position попадал внутрь); UIView frame узкий — дети уезжали за границы. Fix: построен `frameIds` set из shapes с `type='frame'`; для shape с `s.parentId in frameIds` newX/newY вычисляются как `abs_position - parent_abs_position` (subtract frame's absolute position).

### Tests

- `apps/backend/tests/domain/layout.test.ts` — добавлен тест: 2 frames + 2 children каждый + cross-edge, для каждого child render-position `(parent.x + child.x, parent.y + child.y)` должна попадать в `[parent.x, parent.x + parent.props.w] × [parent.y, parent.y + parent.props.h]`. Покрывает случай multi-group схемы (типа InlineAdLoader с `integration` + `UIView`).
- Итого: 288 backend (+1) + 66 frontend + 116 MCP.

### Verification

Manual в комнате `inline-ad-v2` (7 нод + 2 frame groups + 7 связей через layered-lr): оба контейнера `integration` и `UIView` отрисовываются с visible header labels и **детьми внутри** (StoriesView + BannersView корректно в UIView frame'е); ранее UIView был визуально пустой. 0 console errors.

---

## 0.14.3 — 2026-05-19 — Layout spacing + containers + MCP group

Bug-fix релиз: после 0.14.2 (camera + labels) тест на референсной диаграмме InlineAdLoader выявил три проблемы — tight arrow spacing, отсутствие container groups через MCP, frame schema mismatch. Закрывает DRW-079, DRW-080, DRW-072.

### Fixed

- **DRW-079 — Layout spacing.** `packages/shemma-domain/src/layout-modes.ts`: пересмотрены `SPACING_PRESETS` (compact 30/15/50, **normal 60/30/100** — было 40/20/80, loose 100/50/180) под 220x80 default shapes. Добавлены layered-specific опции в `modeToElkOptions` для `layered-lr` / `layered-tb`: `elk.layered.spacing.nodeNodeBetweenLayers` (60/120/200), `edgeNodeBetweenLayers`, `edgeEdgeBetweenLayers` (12/20/32). Plus base `elk.spacing.edgeEdge` и `elk.spacing.edgeLabel` (6/10/14). Не применяется к non-layered modes (mrtree/rectpacking/force).
- **DRW-080 — Container groups с visible label.** `apps/backend/src/domain/compile.ts:makeFrameShape` — добавлен `color: "black"` в props (tldraw 5.x `TLFrameShapeProps` требует `color` через migration `AddColorProp`; без него `loadSnapshot` падал с `ValidationError`). `apps/frontend/src/canvas/schema-placeholder.ts:backfillStoreRecords` — backfill `color="black"` для legacy frame shapes. Frames с `props.name` отрисовываются как контейнер с заголовком сверху (нативный tldraw frame UI).
- **DRW-072 — MCP `shemma_group` теперь поддерживает `as`.** `packages/shemma-mcp/src/schemas.ts:GroupArgs` — добавлено optional `as: z.enum(["network", "boundary"])`. `packages/shemma-mcp/src/tools/domain.ts:groupCall` — пробрасывает `as` в action, default `"boundary"` если caller не указал. Раньше любой `shemma_group` падал с `group.as must be network|boundary`.

### Tests

- `packages/shemma-domain/tests/layout-modes.test.ts` — +4 теста (between-layers presence для layered, отсутствие у non-layered, edgeLabel scaling, normal ≥50).
- `apps/frontend/src/canvas/schema-placeholder.test.ts` — +2 теста (backfill color для frame + idempotent).
- `packages/shemma-mcp/src/tools/domain.test.ts` — +2 теста (default `as`, passthrough explicit).
- Итого: 631 backend (+5) + 66 frontend (+2) + 116 MCP (+2).

### Research (DRW-081 / DRW-067)

- **Auto-resize geo shape.** Public API для shrink-to-text в tldraw 5.x **отсутствует**. `editor.shrinkToFit` / `autoSizeShape` не существуют. `onBeforeUpdate` early-exits если richText/font/size unchanged. Текущий `triggerGrowY` (0.14.2 part D) фактически no-op из-за reference-equal props. Работоспособный hack — double-`updateShape` с искусственным изменением size — kludgy. **Mitigated** через увеличенные defaults (DRW-077 220x80). Для длинных multi-line labels рекомендуется Mermaid-first path (DRW-067).
- **Mermaid-first viable.** Существующий import (`window.shemmaImportMermaid`, ⌘M hotkey) использует `editor.createShape` корректно — tldraw hooks (включая growY) срабатывают. Imported shapes имеют `meta.didrawName` → domain-aware, `shemma_define/connect/layout` работают на mixed схеме. Hybrid workflow (Mermaid bulk + manual incremental) готов к документированию.

### Open issues

- **DRW-082** — Layout не respects группы при ELK pass: в схеме с 2+ frames, дочерние shapes одного из frames оказываются off-screen после `shemma_layout`. Воспроизведено в `inline-ad-final` с `integration` + `UIView`.
- **Note про MCP cache:** клиенты, открытые до релиза 0.14.3 (Claude Code, Codex), кэшируют MCP schemas от старой версии бинаря — `shemma_group` `as` field появится только после restart MCP session.

### Verification

Manual в комнате `inline-ad-final` (7 нод + 7 связей + 2 frame groups): containers `integration` и `UIView` рендерятся с visible header. Children integration внутри. Children UIView — backend coords корректные внутри frame, render position off-screen (DRW-082). 0 console errors.

---

## 0.14.2 — 2026-05-19 — UX: camera fit + label sizing

Bug-fix релиз: после 0.14.1 (arrow rendering восстановлен) выяснилось, что viewport не вписывает контент после AI-mutations и длинные labels вылезают за границы shape. Закрывает DRW-075 (camera fit) и DRW-077 (label overflow).

### Fixed

- **DRW-075 — Camera fit-to-content после AI mutations.** В `apps/frontend/src/App.tsx` добавлен debounced `scheduleAiZoom` (100ms): после каждой WS `store-change` с `source:'ai'` (от backend MCP/HTTP ops), если пользователь не делал manual pan — вызывается `editor.zoomToFit({ animation: { duration: 200 } })`. Detection user-gesture через `editor.store.listen({ source:'user' })`. **Гард** для programmatic camera ops: ref-флаг `inProgrammaticCameraOp` оборачивает каждый собственный `setCamera/zoomToFit` (initial restore + scheduleAiZoom), удерживается на 300ms (продолжительность animation) — без него первый programmatic fit засчитывался listener'ом как user gesture и блокировал последующие fits.
- **DRW-077 — Label overflow в geo shapes.**
  - `packages/shemma-domain/src/role-preset.ts` — default w/h для ролей `service` / `datastore` / `external`: **w 140 → 220, h 70 → 80**. Покрывает большинство реальных labels (≤53 chars).
  - `apps/frontend/src/App.tsx:triggerGrowY` — после `loadSnapshot` и на каждый WS AI-change для затронутых ids вызывает `editor.updateShape({ id, type:'geo', props })` (no-op patch). Это запускает `GeoShapeUtil.onBeforeUpdate` → `calculateGrowY` → `measureUnscaledLabelSize`. Без этого hook'и tldraw'а не срабатывают (они вызываются только из `editor.createShapes/updateShapes`, а не из `store.put` через `loadSnapshot` / `mergeRemoteChanges`).
  - Результат: shapes рендерятся в DOM как 240x87 (240 = 220 + tldraw padding; 87 = 80 + growY +7), длинные labels умещаются с переносом.

### Added

- `apps/frontend/src/transport/ws.ts` — опциональный коллбек `onAiChange(changedIds: Set<string>)` в `StoreSyncDeps`, вызывается из WS handler при `store-change` с `source:'ai'`. Используется фронтом для post-mutation growY/zoomToFit.

### Tests

- `packages/shemma-domain/tests/role-preset.test.ts` — добавлено 5 ассертов на новые defaults для service/datastore/external + verification что queue/actor не тронуты.
- Итого: 626 backend (+5) + 64 frontend (= 690 total).

### Verification

Manual в чистой комнате `madsight-v3`: 7 нод (включая длинные labels типа `repo: scenarios/*.json, fixtures/*.json` и `JSON-вердикт + AI-объяснение`) + 10 connections + `layered-lr` layout. Camera z=1.09 (fit на полный content bbox), 0 console errors, labels читаемы.

### Known limitations

- Длинные labels (60+ chars) всё ещё могут обрезаться — growY ограничен ~10-15px над defaults. Долгосрочное решение — custom ShapeUtil или DOM-based measure (отдельный backlog item, не входит в 0.14.2).
- Arrow label overlap при tight layered-lr — кандидат на улучшение в DRW-078 (taxonomy + edge spacing).

---

## 0.14.1 — 2026-05-19 — Arrow rendering fix (tldraw 5.x schema)

Bug-fix релиз для DRW-076 — стрелки domain `connection` не отрисовывались в tldraw UI, несмотря на корректный domain state. Root cause — три schema mismatch'а с tldraw 5.x в `makeArrowShape` / `makeArrowBindings` + `loadSnapshot` молча проваливался с `ValidationError`, который подавлялся в `mergeRemoteChanges`.

### Fixed

- **`apps/backend/src/domain/compile.ts:makeArrowShape`** — добавлен `elbowMidPoint: 0.5` (обязательное поле `TLArrowShapeProps` начиная с tldraw 5.0.0). Удалена строка `text: ""` (legacy v4-поле, в v5.x заменено на `richText`, которое уже выставляется).
- **`apps/backend/src/domain/compile.ts:makeArrowBindings`** — добавлен `snap: "none"` (обязательное поле `TLArrowBindingProps`, enum `ElbowArrowSnap = 'center'|'edge-point'|'edge'|'none'`, default из tldraw `arrowBindingMigrations.AddSnap`).
- **`apps/frontend/src/canvas/schema-placeholder.ts:backfillStoreRecords`** — backfill всех трёх полей для legacy rooms: инжект `elbowMidPoint` если отсутствует, strip `text`, инжект `snap='none'` для arrow bindings. Идемпотентно, не перезаписывает явно выставленные значения.

### Tests

- 618 baseline → **621 backend** (+3 в `domain-compile.test.ts` — assertions на новые поля и отсутствие `text`).
- 58 baseline → **64 frontend** (+6 в `schema-placeholder.test.ts` — backfill каждого поля, идемпотентность, passthrough).
- Manual verify в браузере: чистая комната (2 ноды + 1 connect) и комната с legacy-данными (7 нод + 10 connections с 20 bindings без `elbowMidPoint`/`snap` и с `text:""`) — обе рендерятся со стрелками, 0 console errors.

### Notes

- Этот фикс не regression 0.14.0 — баг pre-existing с момента upgrade на tldraw 5.0.0, просто не был пойман в QA. Phase 2.3 MCP-сервер сделал domain ops доступным AI-инструментам, что увеличило поверхность реального тестирования и поймало латентную несовместимость.
- Camera-fit при первом define (DRW-075) и label overflow в длинных метках (DRW-077) — **отдельные тикеты, не входят в 0.14.1**.

---

## 0.14.0 — 2026-05-18 — MCP install rewrite (Backlog.md-style)

MCP install flow переделан под подход Backlog.md: shemma больше не пишет конфиги клиентов сама, install происходит через родную CLI-команду каждого клиента (`claude mcp add`, `codex mcp add`, `gemini mcp add`, `kiro-cli mcp add`) или копипастом manual JSON config. CWD проекта приходит через `SHEMMA_CWD` env var (fallback — `process.cwd()`).

### Breaking

- **`shemma mcp install` команда удалена.** Используй родную CLI клиента (см. `docs/mcp.md` → Setup). Существующие 0.13.x entries в `claude_desktop_config.json` остаются valid если переписаны по migration (ниже).
- **`shemma mcp start --cwd <path>` flag удалён.** При попытке использовать — hard error с migration message: "the --cwd flag was removed in 0.14.0. Set SHEMMA_CWD env var instead." Конфиги клиентов, переехавшие с 0.13.x с unchanged `args: ["mcp","start","--cwd","/path"]`, **не запустятся** до migration.
- **`shemma update` output больше не содержит поле `mcpRefreshed`** (JSON) и строку `MCP config refreshed for: ...` (text). `shemma update` не редактирует чужие конфиги клиентов.
- **`detectInstalledMcpConfigs` и `refreshMcpConfigs` экспорты из `@shemma/cli` удалены** (internal symbols, теоретическая breaking surface для downstream consumers).

### Added

- **`SHEMMA_CWD` env var** — определяет project working directory для MCP-сервера. Резолвится `process.env.SHEMMA_CWD.trim() || process.cwd()`. `startStdio` вызывает `process.chdir()` для resolved path, гарантируя что subprocess spawns (`backlog`, `shemma open`) получают правильный cwd.
- **Graceful chdir fallback** — если `SHEMMA_CWD` указывает на несуществующий path, MCP-сервер выводит warning в stderr и продолжает с inherited cwd (room-resolver step "Backlog" просто вернёт пустой список).
- **Module-level `mcpNudgePrinted` guard** в `maybePrintMcpNudge` — теперь print строго один раз за процесс независимо от количества `ensureDaemon` вызовов.
- **`docs/mcp.md` — полностью переписан** под новый flow; включает Team install параграф.

### Changed

- **MCP nudge text** обновлён: вместо `shemma mcp install --client claude` показывает три client-команды (Claude Code / Codex / Gemini) + ссылку на docs/mcp.md.
- **`README.md` → `## MCP integration`** — переписан под Backlog.md-style (client guides блок + manual config + behaviour).

### Migration from 0.13.x

Если у тебя есть существующая MCP-установка `0.13.x`, после обновления до `0.14.0` запусти:

1. Открой конфиг своего MCP-клиента:
   - **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) или `~/.config/Claude/claude_desktop_config.json` (Linux).
   - **Codex**: `~/.codex/config.toml`.
2. Найди entry `mcpServers.shemma` (или `[mcp_servers.shemma]` для TOML).
3. Удали `--cwd` и абсолютный путь из `args`. Должно остаться:
   ```json
   "args": ["mcp", "start"]
   ```
4. Добавь `env.SHEMMA_CWD` (только для Claude Desktop и других GUI-клиентов — CLI-клиенты этот шаг могут пропустить):
   ```json
   "env": { "SHEMMA_CWD": "/absolute/path/to/your/project" }
   ```
5. Перезапусти клиента.

Альтернатива — снести entry и установить заново через нативный `mcp add` команды (для Claude Code / Codex / Gemini / Kiro). См. `docs/mcp.md` → Setup.

### Notes

- Phase 2.3 MCP-сервер core (tools, resources, prompts, room-resolver, auto-open) **не менялся** — это покрытый rewrite одного слоя (install + cwd resolution).
- Внутренний `--cwd` flag в `parseMcpStartFlags` теперь специально throw'ит targeted error (не silent ignore), чтобы недо-мигрированные configs ломались явно, а не "молча работали неправильно с $HOME cwd".
- Тестов: 611 baseline → **618 final** (net +7). Added 15: 2 parser (--cwd hard error + unknown flag) + 4 resolution (SHEMMA_CWD env) + 1 chdir happy + 1 ENOENT graceful + 5 nudge guard + 2 integration (ordering + real cwd). Removed 8: 1 replaced cwd-parse test + 2 snippet generators + 5 detect/refresh blocks.
- Sanity verified (2026-05-18) — isolated-HOME / project-scope tests без mutation реальных user configs: **claude mcp add** (project-scope, temp dir) → `.mcp.json` корректный, без `--cwd`; **codex mcp add** (`HOME=$mktemp_d`) → `~/.codex/config.toml` создан с `[mcp_servers.shemma]`, без `--cwd`. Gemini/Kiro не verified локально (CLI не установлены).

---

## 0.13.1 — 2026-05-18 — README polish for 0.13.0 release

### Fixed

- **README.md** перенесён с Phase 1 формулировок: `Применимо к: 0.0.1 (2026-05-15)` → `0.13.0 (2026-05-18)`, removed `Features (0.0.1)` section title, добавлен MCP integration entry в Features list, MCP-aware AI workflow section (MCP > manual > watcher; Phase 2.4 указан для stand-alone watch).
- **Mermaid импорт** в README — упоминаются `⌘M`/`Ctrl+M` + toolbar button (фактическое поведение с DRW-053), оставлен программный путь через `window.shemmaImportMermaid` для DevTools.
- **Test count в README** — `64 unit/integration` → `611 unit/integration` (58 domain + 284 backend + 7 client + 152 cli + 110 mcp).
- **Release build examples** — версия `0.0.1` → `0.13.0` в строках `./scripts/build-release.sh`.
- **`WebSocket` message types** — добавлен `board-focus` в list message types.

### Notes

Этот патч-релиз содержит только docs-правки + version bump (`0.13.0` → `0.13.1` в `package.json` × 3 + `version.ts`). Никаких runtime изменений за пределами CLI/MCP `version` команды (которая теперь reports `0.13.1`).

---

## 0.13.0 — 2026-05-18 — Phase 2.3 MCP adapter

Shemma теперь работает как MCP-сервер для агентских клиентов (Claude Desktop, Codex, etc.) — typed tools, discoverable resources, auto-open browser, room-resolution chain включая Backlog "In Progress" task slug. Background-agent loop (UC-D) отложен на Phase 2.4.

### Added — backend prerequisites (UC-B/C)

- **WS `board-focus` message** — frontend tab emits `{kind:"board-focus", room, focused}` on focus/blur/beforeunload. Backend trusts `ws.data.room` (not client-supplied room), guards against cross-room spoofing.
- **`ActiveRoomsTracker`** (`apps/backend/src/ws/active-rooms.ts`) — in-memory per-room `Map<roomId, {clients, lastFocusedAt}>` with `onFocus/onBlur/onDisconnect/list`. Sorted by `lastFocusedAt` desc. Idle-timeout reserved for future (§17.2 OQ11: immediate removal accepted for v1).
- **`GET /api/active-rooms`** — JSON array of `{room, clientCount, lastFocusedAt}`. Wired through `WsHub.getActiveRooms()`.
- **`/api/health` returns `pid`** — required by spec §7.4 status resource.

### Added — `@shemma/mcp` workspace package

Тонкий adapter поверх `@shemma/client`. Stdio JSON-RPC entry (`startStdio`) + pure factory (`createShemmaMcpServer`). Domain enums sourced strictly из `@shemma/domain` (никаких local redeclarations).

- **Tools** (19): `shemma_define / connect / group / note / layout / delete / apply` (writes); `shemma_health / version / rooms_list / active_rooms / context / prompts_list / ai_activity_status` (reads); `shemma_open` (explicit browser open); `shemma_prompt_resolve / dismiss` (CMD+K canvas prompts); `shemma_ai_activity_start / stop`; `shemma_get_instructions` (workflow guide fallback).
- **Resources** (14): `shemma://workflow/{overview, read-context, draw-architecture, resolve-prompts, trust-model}` (markdown), `shemma://status / rooms / active-rooms` (JSON), 6 room templates `shemma://room/{room}/{context, context/geometry, prompts/pending, prompts/all, state/compact, state/full}`.
- **Prompts** (4): `shemma_draw_architecture`, `shemma_review_canvas`, `shemma_explain_canvas`, `shemma_resolve_canvas_prompts`.
- **Room resolver** (spec §5.1): chain `arg → server config → CLAUDE_SESSION_ID → single active → Backlog "In Progress" task slug → lastTouched → "default"`. Multiple active rooms или multiple In Progress tasks → typed error `{code:"ambiguous-room", candidates}`.
- **Auto-open policy** (spec §6.8): `never | once | always | confirm`, default `once`. `SHEMMA_NO_BROWSER=1` overrides to `never`. `shemma_open` ignores mode (всегда opens). Auto-open errors swallowed silently — never break the write.
- **Typed result shapes** (spec §9): `ShemmaMcpSuccess<T> = {ok:true, room?, roomSource?, version?, clientOpId?, idempotent?, data}`; `ShemmaMcpError = {ok:false, code, message, status?, clientOpId?, details?}`. `toolResult` wraps both. Codes: `daemon-unavailable | ambiguous-room | validation-error | domain-error | http-error | unexpected-error`.
- **`ensureDaemonSilent`** — pure helper для silent daemon-ensure (stdio JSON-RPC reserved; никакой stdout pollution).
- **Stdio purity** verified by `stdio-purity.test.ts` — server creation pisha zero bytes на stdout.

### Added — CLI `shemma mcp ...` subcommands

- `shemma mcp start [--profile|--cwd|--room|--base-url|--auto-open never|once|always|confirm|--no-auto-ensure]` — запускает stdio MCP-сервер. Lazy-imports `@shemma/mcp` (non-mcp invocations не платят).
- `shemma mcp install --client claude|codex [--scope user|project] [--print] [--force]` — генерирует `claude_desktop_config.json` или `~/.codex/config.toml`. Refuses overwrite without `--force`; сохраняет `.bak.<ts>` backup.

### Added — install/update integration

- **Auto-refresh MCP configs on `shemma update`** — после atomic binary swap CLI вызывает `refreshMcpConfigs(projectDir: cwd)`. Best-effort: failures не блокируют update. JSON output расширен полем `mcpRefreshed: string[]`. В human-mode дополнительный `uiSuccess` если что-то rewritten.
- **One-time MCP nudge on `daemon ensure`** — stderr подсказка `tip: run shemma mcp install --client claude (or --client codex)` если ни в одном detected клиенте нет shemma entry. Gated by `SHEMMA_NO_MCP_NUDGE=1`, suppressed in JSON-mode и в non-verbose paths.

### Added — frontend

- **`createBoardFocusBeacon({send, getCurrentRoom})`** factory (`apps/frontend/src/transport/ws.ts`) — emitFocus/emitBlur/notifyRoomSwitch. Integrated into `startStoreSync` (extends `StoreSyncDeps` с `room: string`). App.tsx wires `window.addEventListener('focus' | 'blur' | 'beforeunload')` с useEffect-scoped cleanup.

### Added — `@shemma/client`

- `CanvasClient.getActiveRooms()` — wraps `GET /api/active-rooms`.
- `CanvasClient.baseUrl` public getter — replaces private-field casts в MCP package.
- `CanvasClient.getHealth()` теперь возвращает `pid: number`.

### Added — docs

- README MCP section (install, manual config, tools/resources/prompts, behaviour).
- `.claude/skills/draw/SKILL.md` MCP nudge: prefer MCP tools over CLI bash invocations when available.
- 5 workflow markdown guides (overview, read-context, draw-architecture, resolve-prompts, trust-model) — served как `shemma://workflow/*` resources AND через `shemma_get_instructions` meta-tool (Backlog.md pattern для hosts без resource support).

### Tests

- **611 pass** (58 domain + 284 backend + 7 client + 152 cli + 110 mcp) — был baseline 461 (Phase 2.2). +150 новых тестов поверх Phase 2.3 work, включая stdio-purity smoke и 3-batched code-quality fix iterations.

### Spec + plan

- `docs/superpowers/specs/2026-05-17-di-draw-mcp-adapter-design.md` v0.4 — UC matrix A-M, backend prereqs §17 in-scope, Phase 2.4 background-agent sketch §18 out-of-v1.
- `docs/superpowers/plans/2026-05-18-phase-2-3-mcp-adapter-implementation.md` — 23 tasks, 3700+ строк, batched review policy (3-5 tasks per block).

### Out of v1 (deferred / known limitations)

- `shemma_room_suggest` tool (spec §5.1 marked optional).
- `SHEMMA_MCP_LOG` env var with stderr/file/off modes (§11.5) — stdout-purity достигнута, но extensible logging API отложен.
- `taskContext` + `otherProfiles` поля в `shemma://status` payload.
- Dynamic `autoOpen.openedRooms` reflection в status resource (currently hardcoded `[]`).
- Background agent loop — Phase 2.4.

---

## 0.12.3 — 2026-05-18 — Daemon spawn argv fix for compiled binary

### Fixed

- **`daemon start` from compiled binary** (DRW-060 follow-up) — `packages/shemma-cli/src/daemon.ts:start()` спавнил child с `[process.argv[1], "internal-server", ...]`. Для **bun source** это correct (argv[1] = script path), но для **compiled binary** argv[1] = first user arg (e.g. "daemon") → child получал `["daemon", "internal-server", ...]` → не находил `internal-server` cmd → exit'ил в `usage()` без binding на port. Health check fail. Fix: детектируем exec mode по `process.execPath` (`/bun(-[^/]+)?$/` → source) и passem argv[1] только в bun source mode.
- **Effect:** `shemma daemon start --profile release` from installed compiled binary теперь реально стартует server (раньше silently fails). `shemma update` auto-restart после swap работает end-to-end.

---

## 0.12.2 — 2026-05-18 — Robust daemon restart after self-update

### Fixed

- **`shemma update` post-swap auto-restart race** (DRW-060) — после successful `shemma update` (atomic binary swap) flow `stop(profile)` → `ensure(profile)` падал с `✖ shemma: SHEMMA_PORT is set but server not healthy on :8787` вместо запуска нового binary. Root cause: `packages/shemma-cli/src/index.ts` populates `process.env.SHEMMA_PORT = portFor(profile)` для каждого CLI-инвокa (чтобы внутренние `CanvasClient` calls hit нужный daemon), но `ensureDaemon` fast path трактовал любой выставленный `SHEMMA_PORT` как "externally provided — caller owns the server, only verify health, иначе exit(3)". После `stop()` daemon dead → health fail → `process.exit(3)`.
  - Введён marker `SHEMMA_PORT_AUTOSET=1` в `index.ts`: проставляется одновременно с `SHEMMA_PORT` когда CLI сам резолвит port из `--profile`. `ensureDaemon` fast path триггерит только если `SHEMMA_PORT` set И marker absent — externally-set semantics ограничены testing scenarios (in-process `Bun.serve` в `lifecycle.http.test`).
  - `cmdUpdate` explicitly `delete process.env.SHEMMA_PORT` + `SHEMMA_PORT_AUTOSET` перед `ensure()` — defensive layer, гарантирует чистый `status()` + `start()` path для нового binary независимо от inherited env.
  - `apps/backend/src/index.ts:Bun.serve` получил `reusePort: true` — освобождает порт от TIME_WAIT race при быстром stop→start cycle на macOS (~15s TIME_WAIT по умолчанию). Critical для update flow в одном process.
- **Tests** — `packages/shemma-cli/tests/daemon-ensure-fallback.test.ts` (3 subprocess test'а): fast path success при externally-set `SHEMMA_PORT` + healthy server, fast path exit(3) при externally-set + unhealthy, и marker-bypass при auto-set + healthy. CLI: 135 → 138 (+3).

---

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
