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
