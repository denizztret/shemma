# DRW-116 — Singleton daemon + spaces registry + multi-gallery (Design)

**Version:** 0.3 (draft)
**Date:** 2026-05-21
**Status:** awaiting approval
**Tag at release:** `0.22.0` (proposed MINOR; phase-level reorg)
**Backlog ref:** DRW-116
**Spec convention:** этот документ — design (spec), не implementation plan. План — отдельным документом после approval (см. [[feedback-plan-approval-gate]]).

**Changelog:**
- **v0.3 (2026-05-21):** second review pass. Lock protocol re-flavoured к mkdir-based (POSIX advisory locks через fd inheritance не safe — process-owned, не fd-owned; mkdir atomic + retry чище). `storageLayout: "direct"` added для `SHEMMA_STORAGE_DIR` shim. `§5.2` now references canonical resolver (no hardcoded path). MCP resolver adds `default` space fallback step (closes contradiction со `§6.4`). `§7.3` wording fixed: single-column = full-width whichever mode (gallery OR room). API inventory table rewritten с accurate routes from codebase grep (включая `/api/health`, `/api/ai/activity`, `/api/prompt/:id/...`, `/api/rooms/purge-archive`).
- **v0.2 (2026-05-21):** first review pass. Per-record `storageLayout` для корректной legacy resolution. Singleton lock — explicit fd-handoff (later corrected in v0.3). MCP `space` reverted to optional (schema-level), explicit resolver pre-validation. CLI direct registry access via `@shemma/spaces` shared package + daemon fs-watch. Compression off (`.json`, not `.json.br`) per current persistence. API surface — middleware-enforced for all `/api/*`. Privacy — DTO split (public vs internal). Lock keyed by port not profile (release/debug share 8787). Multi-gallery URL — explicit per-column tuple `?cols=...` syntax. `lastUsedAt` write-debounced.
- **v0.1 (2026-05-21):** initial draft.

---

## 1. Цель и driver

Сегодня shemma реализует **«daemon-per-CWD»**: каждый запуск `shemma daemon start` привязывает single backend к одному storage path (resolved через `--storage` > `SHEMMA_STORAGE_DIR` > `<cwd>/.shemma` > legacy `~/.claude/projects/<slug>/canvas`). Это даёт три практических проблемы:

1. **Zombie daemons.** Closing CC-сессию / terminal не убивает daemon — он переживает родителя как detached process. Накапливается N daemon'ов в фоне.
2. **Port conflicts.** Второй `shemma daemon start` для другого проекта на том же profile падает на EADDRINUSE (одноразово видно в логах, дальше silent fail).
3. **No multi-project view.** Открытая в браузере страница shemma может видеть только rooms того storage, на который указывал стартовавший daemon. Чтобы посмотреть рядом два проекта — нужно kill + cd + start, и даже тогда нельзя сравнить рядом.

DRW-116 устраняет эти три проблемы одним архитектурным сдвигом: **singleton system-wide daemon, spaces registry on-disk, composite `(spaceId, roomId)` route на каждом запросе**. Daemon перестаёт «принадлежать» какому-то одному проекту — он держит реестр всех известных spaces и обслуживает любой по идентификатору в request'е.

**Key insight от user'а (brainstorm 2026-05-21):** в каждой mutation/subscription/URL **обязательно несутся ОБА ID** — `spaceId` и `roomId`. Никакого global "active space" в daemon'е нет; routing полностью parameter-driven. Это решает multi-gallery, AI-write disambiguation, и shareable URL'ы одной механикой.

Цели phase'ы:
- Один daemon system-wide (per profile), 0 zombie процессов после закрытия всех консьюмеров.
- Registry известных проектов (`~/.config/shemma/spaces.json`) с auto-register on open + soft-delete.
- URL `?space=<id>&room=<roomId>` как контракт.
- Multi-gallery UI (split columns по умолчанию) — два проекта рядом без friction.
- AI tools пишут в explicit `space` (с fallback'ом на PID-tree CC сессии → CWD).
- Legacy `~/.claude/projects/<slug>/canvas/` continues to работать через auto-register в `default` space.

Non-goals:
- Hot profile switch (release ↔ dev ↔ debug на лету) — deferred.
- Cross-space drag/drop shape'ов — out of MVP.
- Remote / multi-device sync через space — out of MVP.

---

## 2. Что НЕ меняется

Сохраняем (контракт стабильный):

- **Backend stack** — Bun + Hono, single-binary release build, profile dimensions release/dev/debug.
- **Profile-port mapping** — release=8787, dev=8788, debug=8787. (Hot-switch deferred; параллельный release + dev продолжают работать.)
- **Per-room file storage** — каждая room хранится в одном `<room>.json` файле (FilePersistence, uncompressed). Изменения только в том, **где** этот файл живёт (теперь — внутри `<space.path>/.shemma/` для project layout или `<space.path>/` для legacy layout, см. §4).
- **Envelope format (v3 / Phase 3.0)** — структура room JSON не меняется. DRW-116 — про routing/discovery, не про data model.
- **Domain layer (`@shemma/domain`)** — Role/ConnectionKind/LayoutMode/presets остаются SSOT'ом; никаких domain breakage'ей.
- **MCP tool surface, бизнес-логика** — `define/connect/group/note/layout/delete` сохраняют semantics. Меняется только resolution: добавляется `space` параметр.
- **WS message format** — структура `StoreChangeBatch`, `board-focus` frames, hello/ack protocol остаются. Меняется query string при connect.
- **§3.8 UI design** — tldraw как primary, мы только service-layer. Spaces UI делаем через components/overrides, не position:fixed overlay (см. CLAUDE.md constraint).
- **CLI exit-code contract** — все существующие команды (`daemon/data/domain/rooms/g`) continue работать. Добавляем новые, не ломаем старые (см. §9.4).
- **Element identity / pin discipline / cascade-delete / atomic mutations** — все Phase 2.x/3.0 invariants сохранены.

---

## 3. Архитектурный invariant phase'ы

> **Composite key `(spaceId, roomId)` — primary route key для всех data operations.**

Из этого invariant'а выводится всё остальное:

- **URL.** Browser URL: `/?space=<spaceId>&room=<roomId>`. Для gallery view (rooms list): `/?space=<spaceId>&view=gallery`. Для landing (spaces list): `/`.
- **HTTP API.** Все data endpoints добавляют `?space=<spaceId>` поверх существующего `?room=<roomId>`. Пример: `GET /api/state?space=ios-app&room=adv-4276`.
- **WebSocket.** WS connect URL: `/ws?space=<spaceId>&room=<roomId>`. Subscription scoped to пара. WsHub:`Map<"${space}:${room}", Set<Sock>>`.
- **Storage resolution.** На каждый request: backend reads `space` query → lookup в spaces.json → derive room file path по `resolveRoomStorage(space, profile, roomId)` (см. §4.3). Никакого глобального `config.storageDir` больше нет.
- **MCP / domain actions.** Каждый tool call принимает `{ space, room, ... }`. Resolution: explicit > PID-tree CC session CWD → matching space > error/ambiguity report.
- **Mutations.** Op-log и version'ы scoped к `(space, room)`. WS broadcast — только subscribers того же composite key.
- **Daemon state.** Daemon hold'ит только три вещи в памяти: (a) spaces registry (read-through cache над `spaces.json`), (b) per-room runtime state (per-key cache, evict-able), (c) lockfile + activity counter. **Нет** одной "active gallery".

Этот invariant — primary review лens на каждое change в phase'е. Любая операция без явных `(space, room)` — bug или legacy-shim (см. §6.4).

**Privacy constraint (scoped):** absolute filesystem paths не должны утекать в **share-able contexts** — browser URLs, MCP tool errors (ambiguity payloads, отправляемые LLM), default CLI output. Они **остаются** в:
- `spaces.json` на disk (owned by user, mode 0644).
- Internal API responses к local daemon (`GET /api/spaces` отдаёт `path` — это OK, потому что отвечает только local-host UI).
- CLI с явным `--show-paths` или `--json` flag.

Реализация — **DTO split**:
- `SpacePublicDTO` = `{ id, label, lastUsedAt, orphaned, pathHint? }` — `pathHint` это truncated middle-ellipsis path (e.g. `~/.../ios`) **только** если client помечен local (см. §4.7).
- `SpaceLocalDTO` = `{ ...PublicDTO, path }` — full path; emit'ится из `/api/spaces` к localhost-bound HTTP requests; UI рендерит truncated, hover → full.
- MCP ambiguity errors, broadcast WS messages, log lines (level info+) → используют PublicDTO (без `path`).

URL, CLI args (после registration), MCP tool payloads, share-able links — оперируют **только short `spaceId` slug'ом**.

---

## 4. Spaces registry

### 4.1. Файл `~/.config/shemma/spaces.json`

Authoritative registry известных проектов. Расположение — `${XDG_CONFIG_HOME:-~/.config}/shemma/spaces.json`. Создаётся on-demand при первой регистрации space. Owned by user (mode 0644; dir 0755).

Backup-safe: daemon пишет через write-rename (`spaces.json.tmp` → `spaces.json`). Concurrent writes от нескольких CLI инвоций сериализуются через **advisory file lock** на `spaces.json.lock` (см. §5.1, тот же flavour что singleton lockfile).

### 4.2. Schema

```ts
// packages/shemma-spaces/src/types.ts (новый shared package)
export type SpaceId = string; // ^[a-z0-9][a-z0-9-]{0,62}$

export type SpaceStorageLayout = "project" | "legacy" | "direct";

export type SpaceRecord = {
  id: SpaceId;                       // canonical, short slug
  path: string;                      // absolute, fs.realpath-resolved at registration; semantics зависит от storageLayout
  storageLayout: SpaceStorageLayout; // "project": rooms в `path/.shemma/<profile-subdir>/`. "legacy": rooms в `path/<profile-subdir>/`. "direct": rooms в `path/` directly (no profile subdir) — для SHEMMA_STORAGE_DIR shim
  label?: string;                    // user-friendly display name; defaults to id
  createdAt: string;                 // ISO 8601
  lastUsedAt: string;                // ISO 8601, updated debounced (см. §4.7.2)
  legacy?: boolean;                  // true if auto-migrated from legacy global path (см. §10); UI badge marker
};

export type SpacesRegistryFile = {
  schemaVersion: 1;
  spaces: SpaceRecord[];             // unordered; sorted by lastUsedAt desc at read-time
};
```

**Поля решения:**
- `id` — short kebab-slug, generated from `basename(path)`, lowercased, alphanumeric+hyphen. Конфликт → suffix `-2`, `-3`, ... (см. §4.4).
- `path` — после `fs.realpath()`. Symlinks resolved at registration; later changes (rename, move) не отслеживаются — registry становится stale, user explicit'но re-registers (см. §4.5).
- `storageLayout` — **core resolver hint** (см. §4.3). Новые spaces от user'а — всегда `"project"`. Auto-migrated legacy spaces — `"legacy"`. Других значений в MVP нет; enum extensible через schema bump.
- `label` — display string в UI; user может переименовать через `shemma s rename <id> <new-label>` без изменения `id`.
- `lastUsedAt` — updated daemon'ом на любой data op (state read, mutation, WS connect). Disk flush debounced (см. §4.7.2). Используется для sort в spaces page.
- `legacy: true` — UI marker для badge "Migrated from legacy storage"; orthogonal к `storageLayout` (storageLayout — resolver hint; legacy — UI hint; обычно coincide).

### 4.3. Per-space storage layout

Storage path резолвится по `(space.storageLayout, profile)`:

**Layout `"project"`** (new spaces, `shemma <path>` registered):

```
<space.path>/.shemma/
├── canvas/            # release/debug rooms (one .json per room — uncompressed JSON, matches current FilePersistence)
│   ├── default.json
│   ├── adv-4276.json
│   └── ...
└── canvas-dev/        # dev profile rooms (separate set)
    └── ...
```

Storage root = `<space.path>/.shemma/<storageSubdir[profile]>/`.

**Layout `"legacy"`** (auto-migrated legacy spaces, см. §10):

```
<space.path>/             # пример: ~/.claude/projects/ios-b6273f30
├── canvas/               # release/debug rooms — existing files, untouched
│   ├── adv-4276.json
│   └── ...
└── canvas-dev/           # if dev was ever used
    └── ...
```

Storage root = `<space.path>/<storageSubdir[profile]>/`. **Note:** legacy paths уже содержат `canvas/` subdir directly, без `.shemma/` wrapper. Spec не перемещает files (см. §10.2).

Profile-зависимая subdir сохраняется (как сегодня в backend `config.ts:storageSubdir` — release/debug → `canvas`, dev → `canvas-dev`), чтобы параллельный dev/release не конфликтовал на одном space.

**File format note:** Phase 3.0 FilePersistence пишет uncompressed `<roomId>.json` (см. `apps/backend/src/persistence.ts`). Compression в scope DRW-116 НЕ входит — files остаются `.json`. Future compression (если будет) — отдельная задача.

**Layout `"direct"`** (auto-registered shim для `SHEMMA_STORAGE_DIR` env, см. §6.4 / §9.4):

```
<space.path>/             # storage root directly (whatever directory env points at)
├── adv-4276.json
├── default.json
└── ...
```

Storage root = `<space.path>/`. No profile subdir (current `SHEMMA_STORAGE_DIR` semantics не differentiate release/dev). Both release и dev share the same files. Это в основном transitional — нет ожиданий, что user runs обои profiles на одном `SHEMMA_STORAGE_DIR` simultaneously.

Resolver function (canonical):

```ts
function resolveRoomStorage(space: SpaceRecord, profile: Profile, roomId: string): string {
  const subdir = profile === "dev" ? "canvas-dev" : "canvas";
  let root: string;
  switch (space.storageLayout) {
    case "project": root = path.join(space.path, ".shemma", subdir); break;
    case "legacy":  root = path.join(space.path, subdir); break;
    case "direct":  root = space.path; break; // no profile subdir
  }
  return path.join(root, `${roomId}.json`);
}
```

### 4.4. ID generation и conflict resolution

Algorithm `generateSpaceId(path, existingIds)`:

1. `base = slugify(basename(path))` — lowercase, replace non-alnum с `-`, collapse multiple hyphens, strip leading/trailing hyphens.
2. Truncate до 32 chars.
3. Если `base` уже занят и `existingIds[base].path === path` (после realpath) — return `base` (idempotent registration).
4. Иначе append `-2`, `-3`, ... до first free.

Edge case: empty base (e.g. `/` или `~`) → fallback `space`. Reserved ids: `default` (для legacy migration, см. §10), `new` (для UI route). Если `slugify(basename(path)) === "default"` для non-legacy path — bump до `default-2`.

### 4.5. Symlinks

`fs.realpath()` вызывается **только в момент `spaceRegister(path)`**. Этот resolved path сохраняется в `space.path`. После регистрации:
- Если фактическая директория переехала / удалена → space становится "orphaned" (см. §4.6).
- Если symlink меняет target — мы продолжаем читать old target. Это by design (user должен явно re-register через `shemma s forget && shemma <new-path>`).

### 4.6. Soft-delete и orphan detection

Не вылетают сами. Garbage policy:
- `shemma s forget <id>` — removes record из spaces.json. На-disk files (`<path>/.shemma/`) не трогаются.
- Daemon на startup и периодически (каждые 5 минут) probes paths: если `path` не существует → mark в-memory `orphaned: true`, в UI greyed-out со cross-mark. На-disk record остаётся (могут смонтировать обратно).
- Manual cleanup: `shemma s prune` — removes все `orphaned`. Confirm prompt.

`SpaceRecord.orphaned` — derived, не сохраняется в json (computed at daemon startup + periodic). Это — derived state per spec [[feedback-no-redundant-state]] — пользователь хочет видеть актуальный fs.

### 4.7. CRUD API

Registry — single file `spaces.json`. **Two access paths:**

1. **HTTP API** (frontend, MCP, remote-ish callers): через running daemon. Returns DTO (public vs local-host, см. §3 privacy).
2. **Direct file access** (CLI, daemon startup, bootstrap): через shared `@shemma/spaces` package, `loadAndModify(fn)` helper with advisory lock на `spaces.json.lock`.

**Both paths read/write the same file.** Concurrent safety обеспечивается advisory lock. Daemon-CLI coherence — см. §4.8.

**HTTP surface** (returns DTOs, см. §3):

```ts
GET    /api/spaces                  → SpaceLocalDTO[]    // local-host only; remote → PublicDTO[]
GET    /api/spaces/:id              → SpaceLocalDTO | 404
POST   /api/spaces      { path }    → { space: SpaceLocalDTO, created: boolean }
DELETE /api/spaces/:id              → { ok: true }        // soft-delete from registry
PATCH  /api/spaces/:id  { label }   → { space }
```

POST `/api/spaces` returns `created: false` если path (after realpath) уже зарегистрирован (idempotent).

**Shared package surface** (`@shemma/spaces`):

```ts
export function loadRegistry(): SpacesRegistryFile;
export function loadAndModify(fn: (reg: SpacesRegistryFile) => SpacesRegistryFile): SpacesRegistryFile;
// Atomically reads, applies fn, writes back. Holds advisory lock for entire op.

export function registerSpace(path: string, opts?: { id?: SpaceId; storageLayout?: SpaceStorageLayout; legacy?: boolean }): { space: SpaceRecord; created: boolean };
export function forgetSpace(id: SpaceId): void;
export function renameSpaceLabel(id: SpaceId, label: string): SpaceRecord;
export function findSpaceByPath(absolutePath: string): SpaceRecord | undefined; // realpath match
export function listSpaces(): SpaceRecord[]; // sorted by lastUsedAt desc
```

CLI commands (см. §9) используют этот surface directly, без daemon. Daemon тоже использует тот же surface, plus fs-watcher для cache invalidation.

### 4.7.1. CRUD CLI commands (см. §9.3 для full surface)

```bash
shemma s list
shemma s add <path>
shemma s forget <id>
shemma s rename <id> <new-label>
shemma s prune
```

### 4.7.2. `lastUsedAt` write debounce

`lastUsedAt` обновляется на каждый data op (state read, mutation, WS connect). На hot path persistence:

- **In-memory** update — immediate (для UI ordering correctness).
- **Disk flush** — debounced. Daemon аккумулирует "dirty" set `Set<SpaceId>`; периодический flush (default every 10 seconds; tunable via `SHEMMA_SPACES_FLUSH_MS` env) пишет batch через `loadAndModify`.
- **Graceful shutdown** — final flush before exit.
- **Crash** — pending updates lost. Accepted (cosmetic metadata, не critical state).

CLI direct writes (через shared package) flush immediately (single-op semantics; никакого batching не нужно — это user-initiated, не hot path).

### 4.8. Daemon ↔ CLI consistency

Daemon holds in-memory cache of `SpacesRegistryFile`. CLI commands write directly to `spaces.json` без IPC.

**Coherence:**
- Daemon watches `spaces.json` через `fs.watch` (native FSEvents/inotify). On change event → reload through `loadRegistry()` → atomic swap in-memory cache.
- Debounce watch: 100ms (избегаем double-fire от write-rename pattern).
- На fs.watch fail (e.g. NFS) — fallback на periodic poll (every 5 seconds) с mtime check.

**Concurrency:**
- CLI и daemon both use `loadAndModify(fn)` for writes → advisory lock на `spaces.json.lock` сериализует.
- Lock timeout: 5 seconds. Если CLI не получает lock → error "Registry busy, retry". Если daemon batch flush не получает — log warning, next flush retry.

**Bootstrap order для `shemma <path>`:**

1. CLI registers space directly via `@shemma/spaces` (no daemon needed) → writes `spaces.json`.
2. CLI ensures daemon (`shemma daemon start --silent`) → daemon startup → reads `spaces.json` (fresh, includes new space).
3. CLI opens browser at `?cols=<id>` (см. §6.1).

Этот порядок гарантирует: CLI can register space на **empty system** (no daemon running yet), и daemon startup natively picks up registry.

---

## 5. Singleton daemon

### 5.1. Lockfile-based singleton — mkdir protocol

POSIX advisory locks (`fcntl(F_SETLK)`, `flock`) — **process-owned**, не fd-owned. Через `fork+exec` lock не наследуется child'ом; повторный `F_SETLK` в child while parent holds the same lock получает EAGAIN. Linux OFD locks (`F_OFD_SETLK`) — fd-attached, но non-portable (macOS не supports).

Используем **portable mkdir-based protocol** (тот же flavour, что `proper-lockfile` npm package). Atomic exclusive create directory + separate PID file inside для metadata.

**Files:**

- **Lock directory:** `~/.claude/.shemma-port-<port>.lock/` — atomic create flag. Existence = "daemon is/becomes alive on this port".
- **PID file (inside lock dir):** `~/.claude/.shemma-port-<port>.lock/daemon.pid` — written by **child** after server ready. Content single line JSON: `{"pid": 38677, "port": 8787, "startedAt": "...", "profile": "release"}`.

**Acquire flow** (на `shemma daemon start` / `shemma ensure`):

1. Parent calls `fs.mkdirSync(lockDir, { recursive: false })` — atomic exclusive create.
2. **Success:**
   - Spawn detached child (no fd inheritance needed — lock semantics — это просто existence of `lockDir`). Pass env `SHEMMA_LOCK_DIR=<lockDir>` чтобы child знал куда писать PID file.
   - Parent enters healthcheck loop:
     - Poll for `daemon.pid` file inside `lockDir` (max 5s, 100ms intervals).
     - Если файл появился — GET `http://localhost:<port>/api/health` с 500ms timeout.
     - 200 OK → parent exit 0 "daemon started (pid=N port=P)".
   - Timeout без healthz pass → parent `rmdir`'нет `lockDir` recursively (cleanup), kills child, fails loud "daemon failed to start; check `~/.claude/.shemma-<profile>.log`".
3. **EEXIST** (mkdir fails because dir already exists):
   - Read `daemon.pid` file.
   - **Если PID file absent** — это "acquire-in-progress" другого parent'а ИЛИ stale (crashed parent). Wait 5s polling for PID file. Если появляется — proceed к healthz check. Если нет — assume stale → `rm -rf lockDir` + retry mkdir ONCE.
   - **Если PID file есть:** `process.kill(pid, 0)` + GET `/api/health` с 500ms timeout.
   - Both succeed → exit 0 "reusing existing daemon".
   - Either fails → stale. `rm -rf lockDir` + retry mkdir ONCE. Если second mkdir тоже fails → fail loud (race с третьим acquirer'ом — пусть он win'нет).

**Child (daemon) startup:**

1. Read `SHEMMA_LOCK_DIR` env (set by parent).
2. Bind port. На EADDRINUSE → fatal error (shouldn't happen, потому что lock holds; но defensive).
3. Init storage, registry, etc.
4. Start HTTP server. `/api/health` returns 200 after ready.
5. **Atomic write** PID file: write `daemon.pid.tmp` → `rename` to `daemon.pid` inside lockDir.
6. Register SIGTERM handler:
   - Stop accept, drain in-flight requests, flush registry.
   - `rm -rf SHEMMA_LOCK_DIR` (lockDir + PID file).
   - Exit 0.

**Race analysis:**

- **Concurrent parents A and B starting fresh:** A wins `mkdir(lockDir)`. B gets EEXIST, no PID file yet (A hasn't spawned child or child hasn't written PID). B waits 5s polling. Child от A writes PID. B sees PID → does healthz → succeeds → "reuse". OK.
- **Parent crashes mid-acquire (after mkdir, before child writes PID):** lockDir orphaned without PID. Next parent sees EEXIST + no PID → waits 5s → still no PID → stale → `rm -rf` + retry. OK.
- **Child crashes mid-startup (lockDir + maybe partial PID file):** atomic rename means PID file либо complete либо absent. На complete без alive child — `kill(pid, 0)` fail → stale → cleanup. OK.
- **Two parents both try `rm -rf` after detect stale:** rmdir non-atomic for non-empty dir, но `rm -rf` retry-friendly. Worst case both attempt; one wins; other's mkdir retry succeeds; race resolves naturally.

**Implementation choice:**

Prefer library `proper-lockfile` (npm), works in Bun via Node compat — handles mkdir + retry + stale + cross-platform out-of-the-box. If incompatible — minimal native implementation в `packages/shemma-lockfile/src/index.ts` (≤100 LOC). Decision deferred к plan phase.

**Release flow** (graceful shutdown):

- Child SIGTERM handler — см. step 6 above.
- Если child SIGKILL'нут (force kill) — lockDir остаётся stale → next start cleans up via PID-check.

**No POSIX `fcntl`/`flock` calls anywhere.** Это portable + simple + understood в Node/Bun community.

### 5.2. Storage больше не bound на startup

Сегодня в `apps/backend/src/config.ts` лениво вычисляется `storageDir` один раз (singleton proxy) из `SHEMMA_STORAGE_DIR` env или default `~/.claude/projects/<slug>/canvas`. **Это удаляется.**

Новая модель:
- Daemon на startup читает `spaces.json` в `SpacesRegistry` (in-memory) — это его only persistent context.
- `SHEMMA_STORAGE_DIR` env **deprecated** (см. §9.4 для legacy behavior).
- На каждый request: middleware reads `space` query → `spacesRegistry.findById(spaceId)` → returns `SpaceRecord` или 404 → derive room file path через **canonical `resolveRoomStorage(space, profile, roomId)`** (см. §4.3). Resolver учитывает `storageLayout` (project/legacy/direct), никаких hardcoded path concat'ов в config.
- Per-room FilePersistence instances cached в-memory с TTL (e.g. 5 min idle → flush+evict). Cache key: `(spaceId, roomId)`.

### 5.3. Auto-shutdown idle

Daemon tracks **active subscribers** (open WS connections). Counter:
- `+1` на каждый WS connect.
- `-1` на disconnect (close или ping timeout).
- Timer: если counter == 0 в течение **30 минут**, daemon initiates graceful shutdown.

Tunable: `SHEMMA_IDLE_SHUTDOWN_MS` env (default 1_800_000 = 30 min). `0` или `-1` отключает (для long-running setups, e.g. CI smoke).

Edge case: MCP-only usage (нет WS, но идут HTTP requests из CC sessions) — на каждый HTTP request к `/api/*` тоже bump'ится `lastActivityAt` (не counter, но timer reset). Idle = `now - lastActivityAt > threshold AND wsSubscribers == 0`.

### 5.4. Lifecycle commands

```bash
shemma daemon start [--profile=<release|dev|debug>]
  # acquire lock OR reuse existing; print pid+port

shemma daemon status [--profile=...]
  # show pid, port, uptime, subscriber count, last activity, registered spaces count

shemma daemon stop [--profile=...|--all]
  # graceful SIGTERM, wait, SIGKILL if needed

shemma daemon restart [--profile=...]
  # stop + start
```

Все idempotent. Backward compat — все эти команды уже существуют, behavior shifts только в storage handling (см. §9.4).

### 5.5. Profile параллелизм + port-based locking

**Port table:** release=8787, dev=8788, debug=8787 (release и debug **share port** by design, см. CLAUDE.md profile config).

Lockfile keyed **by port, not profile** (`~/.claude/.shemma-port-8787.lock`, `~/.claude/.shemma-port-8788.lock`). Это даёт:

- Один daemon на port — гарантия `EADDRINUSE` impossible (one-process-per-port enforced).
- Release ↔ debug — **mutually exclusive** (same port). Второй start пытается reuse first OR fails. Profile transition требует `shemma daemon stop --port=8787` first.
- Release + dev — могут параллельно (разные ports 8787 + 8788, два separate lockfiles).

Lockfile content includes `profile` для debugging — `shemma daemon status` shows которым profile запущен.

**Backward-compat note:** legacy PID-files `.shemma-<profile>.pid` оставлены as supplementary (не authoritative). Authoritative — lockfile. PID-files можно read для status display, но решение "daemon alive" — only через lockfile + healthz.

---

## 6. URL + API routing

### 6.1. URL syntax

**Single-column (canonical, single-space mode):**

| URL | Behavior |
|---|---|
| `/` | Spaces landing page (list + "Add new" form) |
| `/?view=spaces` | Same как `/` (explicit) |
| `/?space=<id>` | Equivalent `/?space=<id>&view=gallery` — rooms list для этого space |
| `/?space=<id>&view=gallery` | Gallery (rooms list) для space |
| `/?space=<id>&room=<roomId>` | Open room editor |

**Multi-column (multi-gallery mode):** explicit `cols` param с comma-separated tuples:

| URL | Behavior |
|---|---|
| `/?cols=A` | Equivalent to `/?space=A` (single column, gallery view) |
| `/?cols=A,B` | Two columns: A gallery, B gallery |
| `/?cols=A:r1,B` | Two columns: A с opened room `r1`, B gallery |
| `/?cols=A:r1,B:r2,C` | Three columns (MVP max): A→room r1, B→room r2, C gallery |

**Tuple grammar:** `spaceId[:roomId]`. Roomless tuple → gallery mode. Multiple tuples comma-joined.

**Why explicit `cols`:** избегает ambiguity ordered-pairing'а `?space=A&space=B&room=R` (которой column owns `room`?). Single canonical syntax: state machine per-column = `{ spaceId, mode: "gallery" | "room", roomId? }`. Parse rule трivial: split на `,`, для каждого split — split на `:`.

**Validation:**
- `spaceId` per regex (§4.4); `roomId` per current room validation regex (`^[a-zA-Z0-9_-]{1,64}$`).
- Unknown spaceId → render placeholder column "Space not found" + "Choose another" CTA. Не fail-page.
- Orphaned spaceId (path missing) → render "Space orphaned" placeholder.
- Cap N columns: max 3 в MVP (см. §7.1); >3 → ignore excess + toast warning.

Backward compat (см. §6.4): URL `?space=X[&room=Y]` continues работать (single-column mode). Old URL `?room=X` без `?space=` тоже работает (resolves to `default` space если present, иначе landing redirect).

### 6.2. HTTP API surface

**Enforcement strategy:** **route-level middleware** mounted на `/api/*` (за исключением explicit allow-list). Middleware extracts `space` query → validates regex → lookups в registry → attaches `c.set("space", record)` в Hono context → handler reads через `c.get("space")`. Handler НЕ должен заново читать `space` query.

**Middleware allow-list (no `space` required):**

- `GET /api/health`
- `GET /api/version`
- `GET /api/session`
- `GET|POST|DELETE|PATCH /api/spaces[/...]` (registry CRUD, см. §4.7)
- `GET /api/active-rooms` (aggregate across spaces; см. note ниже)
- `GET /api/export/miro/boards` (cross-space — это просто listing Miro target boards, не data op)

**All other endpoints under `/api/*` REQUIRE `space`.** Inventory ниже — accurate snapshot routes на момент 0.20.3 (через grep `apps/backend/src/routes/`):

| Method | Path | Other params (beyond `space`) | Notes |
|---|---|---|---|
| GET | `/api/state` | `room`, `since?`, `fmt?` | |
| POST | `/api/state/seed-schema` | `room` | |
| POST | `/api/domain` | `room` | atomic domain action |
| GET | `/api/agent/context` | `room`, `since?`, `viewport?`, `select?` | token-cheap projection |
| POST | `/api/agent/layout-selection` | `room`, `mode`, `spacing`, `scope` | |
| POST | `/api/agent/import-mermaid` | `room`, mermaid text | |
| POST | `/api/ai/start` | `room` | AI session lifecycle |
| POST | `/api/ai/stop` | `room` | |
| GET | `/api/ai/activity` | `room?` | activity status |
| POST | `/api/layout` | `room`, `mode`, `spacing` | direct layout |
| GET | `/api/prompts` | `room` | list |
| POST | `/api/prompt` | `room`, prompt body | create |
| GET | `/api/prompt/:id` | `room` | read |
| POST | `/api/prompt/:id/dismiss` | `room` | |
| POST | `/api/prompt/:id/resolve` | `room` | |
| GET | `/api/rooms` | (optional `includeArchived`) | list rooms in space |
| POST | `/api/rooms/import` | room manifest body | |
| POST | `/api/rooms/purge-archive` | (none) | bulk purge — **NOT under `:id`** |
| DELETE | `/api/rooms/:id` | | |
| POST | `/api/rooms/:id/archive` | | |
| POST | `/api/rooms/:id/restore` | | |
| POST | `/api/rooms/:id/rename` | `newId` | |
| POST | `/api/rooms/:id/duplicate` | `newId` | |
| POST | `/api/rooms/:id/duplicate-auto` | | auto-pick new id |
| GET | `/api/rooms/:id/export` | (format query?) | export room JSON |
| GET | `/api/rooms/:id/thumbnail` | | thumbnail image (PNG) — **GET, не POST** |
| GET | `/api/viewport` | `room` | |
| POST | `/api/export/miro` | `room`, board id, ... | export operation |

**Implementer note:** middleware enforces by default — middleware reads `space` query before handler runs, поэтому новые endpoints добавляемые in future phases автоматически inherit enforcement. Inventory выше может стать stale; truth-of-record — middleware + allow-list. Если новый endpoint legitimately cross-space → explicit opt-out via route flag (`.use(skipSpaceMiddleware)` или mount outside `/api/*`).

**`/api/active-rooms` semantic:** by default aggregates across all spaces (для MCP active-rooms-list usage). Optional `?space=<id>` filter — scoped to one space. Response items get extra `space: <id>` field когда aggregation mode.

**Validation:**
- `space` regex: `^[a-z0-9][a-z0-9-]{0,62}$`. Mismatch → 400 `{ error: "invalid_space_id" }`.
- Missing required `space` → 400 `{ error: "space_required" }`.
- Unknown `space` → 404 `{ error: "space_not_found", id }` (path **не** возвращается — privacy, см. §3).
- Orphaned space (path missing) → 503 `{ error: "space_orphaned", id, label }` (no path).

### 6.3. WebSocket subscriptions

WS connect: `/ws?space=<spaceId>&room=<roomId>`. Validation как §6.2.

WsHub keying:
```ts
// apps/backend/src/ws.ts
rooms: Map<string, Set<Sock>>;
// key = `${spaceId}:${roomId}`

attach(spaceId, roomId, sock);
detach(spaceId, roomId, sock);
publish(spaceId, roomId, msg);
```

Frame `board-focus` carries `space` поле в дополнение к `room`. ActiveRoomsTracker keys на пару.

### 6.4. Backward compat shim

Legacy URLs (`?room=X` без `?space=`) и legacy MCP calls (без `space`) поддерживаются через **default space resolution**:

1. Если в registry есть space с id `default` (создан migration'ом, см. §10) — резолвим туда.
2. Иначе — 400 с `{ error: "space_required", hint: "use ?space=... or register a space via 'shemma <path>'" }`.

Это даёт smooth migration: первый раз new daemon стартует над legacy storage → auto-creates `default` space → старые URLs continue работать.

**SHEMMA_STORAGE_DIR env:** deprecated, но в transitional period (до v0.23.0) если установлен — daemon на startup проверяет: если `default` space не зарегистрирован → auto-register с:
- `path = SHEMMA_STORAGE_DIR` (после realpath)
- `storageLayout: "direct"` — env points at directory containing `<roomId>.json` files **directly**, без `.shemma/` или `canvas/` wrapper (это match current `apps/backend/src/config.ts:107-133` semantics)
- `label: "Default (from SHEMMA_STORAGE_DIR)"`

Warning в logs: "SHEMMA_STORAGE_DIR is deprecated, prefer 'shemma s add <path>'. Auto-registered as space 'default' (layout=direct)."

CLI command `shemma open <room>` без явного space — resolve в (a) matching space по cwd → (b) default → (c) ambiguity error.

---

## 7. Multi-gallery UI

### 7.1. Default presentation — split columns

URL parsing produces `Column[]` (см. §6.1):

```ts
type Column =
  | { kind: "gallery"; spaceId: SpaceId }
  | { kind: "room"; spaceId: SpaceId; roomId: string };
```

Render:
- 1 column → full-width, single canvas или single gallery.
- 2-3 columns → equal-width side-by-side, vertical splitters, resizable mouse-drag.
- Splitter positions persisted в `localStorage` (key `shemma.splitter.{N}`, где N — column count).

Каждая column — independent instance:
- `kind: "room"` → tldraw editor + WS connection + room state.
- `kind: "gallery"` → rooms list для space (по `/api/rooms?space=...`).

**Mode transitions within column** (no full page reload):
- Click room в gallery column → column transitions to `kind: "room"`, opens room. URL updates (`pushState`) с `roomId` в соответствующем tuple.
- Click "back to gallery" button в room column → column transitions to `kind: "gallery"`. URL updates.

Cap: 3 columns max в MVP. >3 → UI shows только first 3 + toast "Max 3 columns in split view" (URL trim + history.replace).

### 7.2. Active gallery indicator

Один column в multi-gallery всегда **active** (фокус для keyboard shortcuts, потенциального drag-target):
- Visual: subtle border highlight (`outline: 2px solid var(--shemma-focus)`) on active column.
- Click anywhere в column → switches active.
- Initial active: first column (left).

Active state per-tab, не persisted (но `lastFocusedAt` per-space update'ится в registry).

### 7.3. Single-column degradation

Single-column mode (one column в `cols` parsing OR legacy single-space URL):
- **`?space=A`** или **`?cols=A`** → full-width single **gallery view** (rooms list для A).
- **`?space=A&room=R`** или **`?cols=A:R`** → full-width single **canvas** (room R editor для space A). Identical to current single-room UX.

No splitter в any single-column mode. Mode transition gallery↔canvas — внутри column (см. §7.1).

### 7.4. Resizable splitter

Drag handle: 6px wide, hover indicator, double-click → reset to 50/50.

Implementation: tldraw-friendly (не position:fixed overlay; reuses container flexbox). Service-layer per §3.8.

### 7.5. Spaces landing page и path entry

Landing page (URL `/`) рендерится при отсутствии `space` query param. Layout:
- Header: "Spaces" + count.
- List: registered spaces (sorted by `lastUsedAt` desc). Каждый row: `label`, `id` badge, `path` (truncated middle, full на hover), last-used relative time, actions (open / forget / reveal / rename).
- Add form: **text input field** для path entry + "Add" button. **Не системный file picker** — `<input type="file" webkitdirectory>` ограничен на browsers и не universal. Text input принимает absolute path (валидируется через POST `/api/spaces`).
- Empty state: prominent "Add your first space" + hint про CLI shortcut `shemma <path>`.

Path entry validation (client-side):
- Trim whitespace; expand leading `~` через known home path (передан backend в `/api/version` или env-сообщённом client config).
- Если empty → disable submit.
- Backend validates existence + permissions; client отображает ошибку inline.

### 7.6. Cross-gallery interactions (OUT of MVP)

Out of MVP:
- Drag shape from gallery A → gallery B.
- Synchronized scroll / zoom.
- Compare mode (overlay).

Future: см. §13 (potential phase 4).

---

## 8. AI/MCP write target

### 8.1. `space` arg в MCP tool schema — optional с resolver

Каждый MCP tool (write: define/connect/group/note/layout/delete/apply/import-mermaid; read: context/rooms_list/active_rooms/...) принимает `space` как **optional** argument в schema. Это критично: schema validation runs BEFORE handler logic, поэтому requiring `space` сломал бы fallback flow в §8.2.

```ts
// packages/shemma-mcp/src/tools/shape-define.ts
const schema = z.object({
  space: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(),
  room: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string(),
  // ...
});

async function handler(args) {
  const space = await resolveSpace(args.space);  // см. §8.2
  if (!space) {
    return ambiguityError();                     // см. §8.3
  }
  // proceed с (space.id, args.room)
}
```

Pre-validation resolver: schema accept'ает `space` undefined; handler runs `resolveSpace(args.space)` first; only после successful resolution proceed'ит к business logic.

### 8.2. Resolver: explicit → CWD-match → `default` fallback → ambiguity

```ts
async function resolveSpace(explicitId?: SpaceId): Promise<SpaceRecord | AmbiguityError> {
  // 1. Explicit wins
  if (explicitId) {
    const space = registry.findById(explicitId);
    return space ?? new AmbiguityError("space_not_found", { id: explicitId });
  }

  // 2. CWD-match
  const cwd = process.env.SHEMMA_MCP_CWD ?? process.cwd();
  const realCwd = await fs.realpath(cwd);
  const matches = registry.listSpaces().filter(s =>
    s.path === realCwd || realCwd.startsWith(s.path + path.sep)
  );

  if (matches.length === 1) return matches[0];

  // 3. Multiple matches → longest path (most specific)
  if (matches.length > 1) {
    matches.sort((a, b) => b.path.length - a.path.length);
    if (matches[0].path.length > matches[1].path.length) {
      return matches[0]; // unambiguous most-specific
    }
    return new AmbiguityError("space_ambiguous_match", { candidates: matches });
  }

  // 4. 0 matches → `default` fallback (legacy compat per §6.4)
  // Legacy spaces (auto-migrated) живут в `~/.claude/projects/<slug>` —
  // CWD от user'а в его actual project никогда не match'нет. `default` fallback
  // даёт smooth experience: old MCP scripts continue работать without explicit `space`.
  const defaultSpace = registry.findById("default");
  if (defaultSpace) {
    // emit warning в structured response: "implicit default space used"
    return defaultSpace;
  }

  // 5. No default, 0 matches → ambiguity
  return new AmbiguityError("space_required", { candidates: registry.listSpaces().slice(0, 10) });
}
```

CC session CWD set at MCP startup via `chdirToProjectDir` (current behavior, unchanged).

**`default` fallback is opt-out:** user может `shemma s forget default` (если auto-migration создал) чтобы disable. Без `default` в registry resolver fails cleanly с ambiguity error (требует explicit `space`).

### 8.3. Ambiguity error format

Returns **PublicDTO**-shape candidates (no `path` — privacy per §3):

```json
{
  "error": "space_required",
  "hint": "No space matches current cwd; pass `space` explicitly or register cwd via 'shemma <path>'",
  "candidates": [
    { "id": "ios-app", "label": "iOS App", "lastUsedAt": "2026-05-21T11:32:00Z" },
    { "id": "ios-dev", "label": "iOS Dev", "lastUsedAt": "2026-05-20T15:11:00Z" }
  ]
}
```

LLM получает enough context чтобы prompt'нуть user'а ("Какой space? ios-app или ios-dev?") или retry с explicit param. Полный path не leaked.

`space_not_found` — same shape, no candidates.
`space_ambiguous_match` — same shape with matched candidates only.

---

## 9. CLI surface

### 9.1. `shemma <path>` — register/open single space

Top-level positional: если первый arg — existing directory → treat as space path:

```bash
shemma ~/Projects/mads-sdk/ios
  # Auto-registers (idempotent), opens browser at ?cols=<id>
```

Equivalent к `shemma s add <path> && shemma open --space=<id>`, но one-shot.

Behavior (no daemon required for steps 1-2):
1. **CLI direct registry write** — via `@shemma/spaces` shared package:
   - Resolve path: `fs.realpath()`. Если не существует → error exit 1.
   - Check existing spaces.json: если path уже зарегистрирован (по realpath match) → reuse id. Иначе → generate id (§4.4), `loadAndModify` appends record с `storageLayout: "project"`. (см. §4.7 / §4.8 — CLI пишет файл напрямую, без daemon).
2. **Ensure daemon** (см. §5). Если уже running — reuse; иначе spawn. Daemon startup читает свежий `spaces.json` (включая только что added space).
3. **Open browser** at `http://localhost:<port>/?cols=<id>` (через `open` macOS / `xdg-open` linux).

**Boot order rationale:** registry writes — file-system level operation, не требует daemon. Это даёт работающий "empty system" flow: первый `shemma <path>` на свежей машине регистрирует space без зависимости от уже-running daemon.

### 9.2. `shemma <path1> <path2> [...]` — multi-gallery launch

```bash
shemma ~/Projects/ios ~/Projects/android
  # Registers both (idempotent), opens browser at ?cols=ios,android
```

Same flow для каждого path (CLI direct registry write — см. §9.1). Открывает один URL с `cols` tuple (см. §6.1).

Cap 3 spaces (UI limit, см. §7.1). CLI принимает до 3; >3 → error "Max 3 spaces per launch".

### 9.3. `shemma s` subcommands

```bash
shemma s list                       # JSON or table
shemma s add <path> [--id=<custom>] # explicit id override (must pass regex)
shemma s forget <id>                # soft-delete from registry
shemma s rename <id> <new-label>    # label change only
shemma s prune                      # remove all orphaned (confirm prompt)
shemma s reveal <id>                # show path in Finder/explorer
```

Все commands используют `@shemma/spaces` shared package directly (см. §4.7 / §4.8) — работают на empty system (no daemon needed). Если daemon running — pick'нет изменения через fs.watch.

Опционально: `--via-daemon` flag forces HTTP API path (для testing); default — direct.

### 9.4. Backward compat

Existing commands continue working:

| Command | Old behavior | New behavior |
|---|---|---|
| `shemma daemon start` | Bind storage from SHEMMA_STORAGE_DIR/cwd/.shemma | Acquire lock, no storage binding. SHEMMA_STORAGE_DIR — auto-register `default` space (with warning) |
| `shemma daemon stop` | SIGTERM | Same; releases lock |
| `shemma open <room>` | Open room в active storage | Resolve via §6.4: cwd → matching space → default; error if ambiguous |
| `shemma data state --room=<r>` | Read from active storage | Requires `--space=<id>` OR fallback `default` |
| `shemma data domain --room=<r>` | Same | Same shift |
| `shemma rooms list` | Active storage | Requires `--space` OR aggregate если omit'нут (returns flat list с extra `space` field) |
| `shemma --storage=<path>` | Bind daemon | **Removed.** Use `shemma s add <path>` instead. Deprecation warning if passed; auto-translate в `shemma s add` + ignore for daemon |

`--storage` flag-level removal: spec deprecates, но transitional shim переводит вызов на `shemma s add`. В 0.23.0 / 0.24.0 — full removal.

---

## 10. Migration plan

### 10.1. Legacy storage detection

`~/.claude/projects/<slug>/canvas/` и `~/.claude/projects/<slug>/canvas-dev/` — legacy storage path Phase 2.x. Daemon на first startup (no `spaces.json` yet) scan'ит `~/.claude/projects/` для `*/canvas/` directories с >0 `.json` files.

Для каждой найденной legacy dir:

1. Auto-register space с:
   - `id`: `default` для **первой** найденной (most-recent by mtime среди canvas dirs). Остальные — `legacy-<slug>` (slug — последний после-`-` hash; cap при ID collision — см. §4.4).
   - `path`: **`~/.claude/projects/<slug>`** (parent dir; не `originalPath`, который lossy). Это правильно резолвится с `storageLayout: "legacy"`:
     - Storage root = `~/.claude/projects/<slug>/canvas/` (release/debug) или `.../canvas-dev/` (dev). См. §4.3 resolver.
     - Existing files в этих dirs работают без перемещения.
   - `storageLayout`: `"legacy"` — **критично**, чтобы resolver не искал `.shemma/canvas/` subdir.
   - `label`: `"Migrated: <slug>"` (для UX clarity, что это auto-migrated).
   - `legacy: true` (UI badge marker).
2. **Не копируем и не перемещаем files** — legacy `canvas/` / `canvas-dev/` остаются in-place.

### 10.2. Physical relocation (out of MVP)

Spec MVP — register-only с `storageLayout: "legacy"`. Физическое перемещение files (legacy `~/.claude/projects/<slug>/canvas` → user's project `<originalPath>/.shemma/canvas` + storageLayout switch на `"project"`) — out of MVP.

Это destructive op, требует user consent + reverse slug lookup. Отдельная команда `shemma s migrate <id> [--to-path=<originalPath>]` в follow-up DRW-119 (см. §13).

В рамках MVP legacy spaces работают полностью функционально, просто их `path` остаётся в `~/.claude/projects/<slug>` (вне user's project dir). UI шейdows badge "Legacy" + tooltip "Storage в ~/.claude/projects (исторический путь). Run `shemma s migrate` to move."

### 10.3. Limitations (MVP)

- Reverse slug lookup не делаем — legacy slug → originalPath mapping lossy без stored meta. User видит label "Migrated: <slug>" + может `shemma s rename <id> "iOS App"` для clarity.
- Если user впоследствии запустит `shemma ~/Projects/<original-project>` для project, чьи rooms сейчас в legacy storage → второй space создаётся (`storageLayout: "project"`, empty `.shemma/` initially). User видит **два space'a** для одного project'a. Это by design — explicit re-registration требует explicit migrate (§10.2).

### 10.4. Migration triggering

Migration runs **once**, gated by absence of `spaces.json`:

1. Daemon startup: if `spaces.json` doesn't exist → run migration → save `spaces.json` (даже если 0 legacy found, create empty schema-v1 file).
2. Subsequent startups: skip (presence of `spaces.json` = migration done).

User opt-out: `SHEMMA_SKIP_LEGACY_MIGRATION=1` env — create empty `spaces.json` without scan.

---

## 11. Testing strategy

### 11.1. Backend unit + integration

Module-level tests (Bun test):
- `spaces-registry.test.ts` — load/save, id generation, conflict resolution, symlink resolve, orphan detection.
- `singleton-lock.test.ts` — acquire/release, stale lock recovery, concurrent acquire race (spawn 5 children, only 1 wins).
- `routing.test.ts` — middleware enforces `space` param, validates id format, 404 on unknown, 503 on orphaned.
- `persistence-cache.test.ts` — per-(space,room) FilePersistence cache, TTL eviction.
- `legacy-migration.test.ts` — scan `~/.claude/projects/` mock, auto-register default + legacy spaces, idempotency (rerun no-op).

Integration (HTTP, real daemon spawn):
- `multi-space-isolation.test.ts` — два spaces, mutation в A не виден в B, WS subscriptions properly scoped.
- `auto-shutdown.test.ts` — start daemon, no subscribers, fast idle timer (override `SHEMMA_IDLE_SHUTDOWN_MS=1000`), assert shutdown within 2s.

### 11.2. CLI integration

`shemma-cli` test suite расширение:
- `cli-spaces.test.ts` — `shemma s add/list/forget/rename/prune` через subprocess.
- `cli-top-level-path.test.ts` — `shemma <path>` flow (без `s`), `shemma <p1> <p2>` multi.
- `cli-backward-compat.test.ts` — old commands (`daemon start`, `data state --room=`) work с fallback resolution; warnings emitted на legacy flags.

### 11.3. Frontend

`apps/frontend/src/__tests__/` (Vitest или Bun test):
- `routing.test.ts` — URL parsing (`?space=A`, `?space=A&room=R`, `?cols=A,B`, `?cols=A:r1,B:r2,C`), edge cases (unknown id → placeholder column, >3 cols → trim).
- `spaces-page.test.ts` — landing renders list (sorted by `lastUsedAt`), add form text input, click открывает column URL.
- `multi-gallery.test.ts` — два gallery rendering, splitter resize + persist, active column toggle, mode transition gallery↔room within column.

Chrome-devtools MCP visual smoke (manual, не automated):
- Start daemon с двумя registered spaces.
- Open `/?cols=A,B`.
- Verify split renders, both gallery columns load, mutation в room из A не появляется в B.
- Resize splitter, drag, refresh — position persisted.

### 11.4. MCP

`shemma-mcp` test suite:
- `space-resolver.test.ts` — explicit > CWD-match (single, multi-longest, ambiguous, 0-match) > error.
- `tool-schema.test.ts` — `space` optional в всех schemas, resolver runs pre-handler, ambiguity error format.
- `legacy-resolver.test.ts` — calls без `space` на system с `default` legacy space → resolve OK.
- Integration with mock daemon (already есть pattern в Phase 2.x).

### 11.5. Test count baseline

Current (0.20.3): 932 tests / 0 fail.
Target after DRW-116: **~1050+ tests** (~120 new across all suites).

---

## 12. Risks + rollout

### 12.1. Risks

**R1 — Singleton lockfile platform variance.** `fcntl(F_SETLK)` semantics differ на NFS / FUSE volumes. **Mitigation:** detect non-local fs at lockfile dir (`fstatfs` magic numbers), warn user, fallback to PID-only check. Document `XDG_RUNTIME_DIR` як override.

**R2 — Legacy migration ambiguity.** Reverse slug lookup может assign wrong path → user open'нет space, не видит свои rooms. **Mitigation:** legacy spaces marked `legacy: true`, UI badge "Migrated from legacy storage; verify path", `shemma s rename` + future `migrate` для correction. User can `shemma s forget` to start fresh.

**R3 — Multi-gallery performance.** Two tldraw editors в одной странице — 2x memory, потенциально 2x WS connections и parsing. **Mitigation:** measure baseline (single canvas ~80MB heap по Phase 3.0 metrics), target <2x in multi (split avoids duplicate libs). Если измерения show >2x — degrade UX (warning toast при N>=2).

**R4 — Backward compat surface area.** SHEMMA_STORAGE_DIR users, scripts с `--storage`, MCP clients без `space`. **Mitigation:** explicit deprecation period — все legacy paths logged как warning (not error) до v0.23.0, потом hard removal. Release notes для 0.22.0 включают migration guide.

**R5 — Concurrent spaces.json writes.** Multiple CLI invocations / daemon write simultaneously. **Mitigation:** advisory lock on `.spaces.lock`, all writes through `loadAndModify(fn)` helper с retry on contention.

**R6 — Orphan accumulation.** Spaces.json grows without bound for user'ов, кто перемещает projects. **Mitigation:** `shemma s prune` команда + UI "X orphaned spaces" badge на landing → click → prune dialog.

**R7 — AI tool ambiguity → frustration.** Если MCP не может resolve space → throws ambiguity error → user отвлекается. **Mitigation:** ambiguity error message must include list candidates (см. §8.3); user-friendly LLM-prompt'able.

### 12.2. Rollout plan

Feature branch: `feature/global-daemon-spaces` from `main` at `0f8baff` (0.20.3 baseline).

Phases (внутри одной feature ветки, через subagent-driven-development):
1. **Foundation** (T1-T4): SpacesRegistry package + file I/O + tests. No daemon changes yet.
2. **Singleton lock** (T5-T7): lockfile flavour, integrate в daemon startup, tests.
3. **Routing migration** (T8-T12): middleware accepts `space`, all endpoints updated, WS keying changed, integration tests.
4. **Frontend routing** (T13-T16): URL parser, spaces landing page, single-space view migrated.
5. **Multi-gallery UI** (T17-T20): split columns, splitter, active state.
6. **CLI surface** (T21-T24): `shemma <path>`, `shemma s` subcommands, backward compat warnings.
7. **MCP `space` param** (T25-T28): schema updates, resolver, tests.
8. **Legacy migration** (T29-T31): scan + register + idempotency.
9. **End-to-end smoke** (T32): chrome-devtools manual smoke, fix surface.
10. **Release** (T33): code-simplifier pass → spec+quality review → release commit + tag `0.22.0` → merge `--no-ff` в main.

**Не делим на отдельные phase-releases** — это monolithic phase (user решил в brainstorm: "делать будем всё"). Только intra-phase task split для clarity.

### 12.3. Roll-back strategy

В случае critical post-release bug:
- Revert merge на main: `git revert -m 1 <merge-sha>` → tag `0.22.1` с revert.
- User'ы на 0.22.0: `shemma s` commands продолжают читать `spaces.json`, но daemon работает в old mode. **However:** rollback должен preserve `spaces.json` (не удалять) — files в `<path>/.shemma/` остаются intact (это просто на-disk JSON).
- Legacy migration **idempotent** — повторный run в 0.21.x не создаст dupes (нет `spaces.json` → re-creates).

Если problem в singleton lock — `SHEMMA_DISABLE_SINGLETON=1` env aborts lockfile flow (fall back to old multi-daemon model). Emergency escape hatch.

---

## 13. Open follow-ups (out of MVP)

Документируем как known deferrals — backlog tasks создаются после release 0.22.0.

- **DRW-117 (proposed):** Hot profile switch (release ↔ dev ↔ debug) без CLI restart.
- **DRW-118 (proposed):** Cross-space drag/drop shapes (gallery A → gallery B).
- **DRW-119 (proposed):** `shemma s migrate <id>` — physical legacy storage move + relink.
- **DRW-120 (proposed):** Tabs / floating windows для >3 spaces.
- **DRW-121 (proposed):** Remote space sync (cross-device, NAS).
- **DRW-122 (proposed):** Space-level permissions / read-only flag.
- **DRW-097 / DRW-115:** UI settings panel surface включает spaces management (см. existing tasks).

---

## 14. Approval gate

Per [[feedback-plan-approval-gate]] — этот spec **требует user approval перед plan writing**. Не запускать `superpowers:writing-plans` или execution автоматически.

Process:
1. User читает spec, оставляет comments/inline edits.
2. Spec обновляется в `v0.2`, `v0.3`, ... до approval.
3. После approval: status → "approved", дата approval'а зафиксирована в frontmatter.
4. Plan в `docs/superpowers/plans/2026-05-21-global-daemon-spaces-plan.md` после approval.
5. Execution через `superpowers:subagent-driven-development` после plan'а.

---

## 15. References

- [[di-draw-project]] — current state of shemma
- [[next-session-drw-116]] — session resume hint
- [[feedback-plan-approval-gate]] — workflow gate
- [[feedback-gitflow-semver-tags]] — branching policy
- [[feedback-subagent-coordinator]] — execution model
- Backlog: `backlog/tasks/drw-116-global-daemon-multigallery.md` — clarified vision capture
- Existing specs: `docs/superpowers/specs/2026-05-17-di-draw-phase3-0-tldraw-primary-design.md` (Phase 3.0 baseline)
- VS Code Recent Folders pattern: https://code.visualstudio.com/docs/editor/workspaces (referenced by user as inspiration)
- IntelliJ Recent Projects model: https://www.jetbrains.com/help/idea/manage-projects.html
