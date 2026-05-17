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
