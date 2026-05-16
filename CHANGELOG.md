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
