# shemma — Backlog

> **Что это.** Список независимых задач для будущих спринтов. Каждая задача — самостоятельная: можно делать в одиночку, без других открытых items этого файла. Дополнения приветствуются по мере находки багов.
>
> **Порядок не фиксирован.** Приоритет определяется в момент взятия задачи — зависит от текущей необходимости.
>
> **Workflow.** Брать задачу → создавать ветку `fix/<short-name>` или `feature/<short-name>` от `main` → реализация → merge `--no-ff` → bump version по SemVer → tag без префикса `v` (например `0.3.1`). Phase-уровневые задачи требуют brainstorm → spec → plan цикла до execution.
>
> **Где новые баги фиксируются.** Добавлять в раздел "Discovered bugs" по ходу тестирования. Обновлять файл в feature/fix ветке вместе с фиксом, либо отдельным коммитом в `main` если задача только зафиксирована.

---

## Discovered bugs

> _Заполняется по ходу интенсивного тестирования. Каждая запись: краткое описание + steps to reproduce + ожидаемое vs фактическое + severity (critical/major/minor)._

### D1 — Version badge показывает `v0.3.0` вместо `0.3.0`

- **Severity:** minor (cosmetic, inconsistency с новой tag policy).
- **Repro:** Открыть frontend на dev (`bun run dev` → http://localhost:5173/), глянуть top-right.
- **Expected:** Badge `0.3.0` (без префикса `v`) — соответствует numeric-tag policy ([[feedback-gitflow-semver-tags]]).
- **Actual:** Badge `v0.3.0`. Frontend (вероятно `chrome/RoomBadge.tsx` или `transport/version.ts`) добавляет `v` префикс.
- **Suggested fix:** Удалить `v` из template'а в UI; показывать чистый semver.
- **Files:** `apps/frontend/src/chrome/RoomBadge.tsx` (или `transport/version.ts` — выявить точно перед фиксом).

### D2 — `/favicon.ico` 404

- **Severity:** minor (cosmetic; не ломает функциональность, но засоряет console).
- **Repro:** Открыть frontend, посмотреть Network — `GET /favicon.ico → 404`.
- **Expected:** Favicon отдаётся (любой — shemma логотип или нейтральный).
- **Actual:** 404 в console errors каждой загрузки.
- **Suggested fix:** Положить `apps/frontend/public/favicon.ico` (или `.svg`); Vite автоматически отдаст.
- **Files:** `apps/frontend/public/` (создать), `apps/frontend/index.html` (опционально `<link rel="icon">`).

### D3 — AI `define` + layout пин'ит узлы через `meta.position` → overlap при последующих define

- **Severity:** **CRITICAL** — ломает основной AI workflow для домена.
- **Repro:**
  1. `shemma define service api --label "API Gateway"` (зум 335%, узел в (10,10)).
  2. `shemma define datastore db --label "PostgreSQL"` — узел db ставится в (10,120), api остаётся в (10,10) (ok так далеко).
  3. `shemma define service worker; define queue queue; connect api queue; connect queue worker; group worker,queue --as boundary --name async-side`.
  4. `shemma layout --mode layered-lr --spacing loose`.
  5. Curl `GET /api/state` → почти все узлы (api, worker, queue) в координатах **(10,10)**. Только `db` в (10,120). Визуально 3 узла перекрываются в одной точке.
- **Expected:** Layered-lr раскладка разносит узлы по horizontal lanes; группа async-side обрамляет worker+queue; нет overlap'а.
- **Actual:** Backend записывает `meta.position: {x:10,y:10}` в КАЖДЫЙ AI-defined node при первом layout pass (`apps/backend/src/routes/domain.ts:250`, "Per spec §3.6.4: meta.position carries last layout-known coords"). Последующий ELK layered ignore'ит `elk.position` → app-level pin post-process читает `meta.position` как pin marker → НЕ двигает узел. Узлы зависают в (10,10).
- **Корневая причина:** Двусмысленность `meta.position`: spec §3.6.4 называет его "layout cache", CLAUDE.md invariant — "user-owned pin marker" (вместе с `meta.pinned`). Layout-postprocess (или pin-respect code) трактует `meta.position` как pin **без проверки `meta.pinned === true`**.
- **Suggested fix:**
  - Вариант A (recommended): layout-postprocess respect'ит pin ТОЛЬКО при `meta.pinned === true` (и тогда uses `meta.position` для координат). AI-defined узлы без `meta.pinned` свободно двигаются.
  - Вариант B: AI domain action НЕ ставит `meta.position`; только user-edit через `/api/patch` источник=user ставит pin pair.
  - В любом случае: добавить регрессионный тест "define 3 nodes + layout → no two nodes share (x,y)".
- **Files:** `apps/backend/src/routes/domain.ts:248-256`, `apps/backend/src/domain/layout-postprocess.ts`, `apps/backend/tests/routes-domain.test.ts` (новый тест).
- **Related:** D4, D5 — все три проблемы каскадируют от этого корня.

### D4 — Group bbox (w/h) после `group` action — `null`

- **Severity:** major (визуально группа не отрисовывается как контейнер).
- **Repro:** После cascade от D3 — `curl /api/state | jq '.canvas.groups'` показывает `{x:180, y:160, w:null, h:null}`. На frontend визуально нет рамки/fill вокруг детей group.
- **Expected:** Group имеет рассчитанный bbox: bounding box над всеми children + padding.
- **Actual:** w/h = null. Frontend, видимо, не рендерит группу.
- **Suggested fix:** При компиляции `group` action либо при layout pass рассчитывать bbox от children. Учесть pin (если все дети pinned — статичная bbox; если двигаются — bbox follow).
- **Files:** `apps/backend/src/domain/compile.ts` (group case), `apps/backend/src/domain/layout-postprocess.ts`.
- **Related:** D3 (если pin'ятся дети — bbox не пересчитан).

### D6 — Frontend retries rejected patch вместо stop-on-422 (loop runaway)

- **Severity:** **CRITICAL** — порождает 27000+ ошибок 422 за минуту при первой rejection.
- **Repro:** В chrome-devtools `editor.createShape({type:"arrow",...})` без `markHistoryStoppingPoint` → frontend пытается отправить patch с дубликатом существующих node-id → 422 → retry → 422 → ... loop.
- **Network panel:** 15637 requests + 27820 console errors за минуту.
- **Expected:** После 422 frontend пишет в ErrorBanner и НЕ retry'ит ту же mutation; ждёт следующего store change.
- **Actual:** Каждый WS message и/или store tick re-вычисляет diff (baseline ≠ server state) и снова шлёт rejected ops.
- **Suggested fix:** В `transport/api.ts:sendPatch` после 422 — bump `lastReceivedVersion` или reset diff baseline на текущий server state (re-fetch + replaceCanvasFromState). Также добавить error throttle (no более N retry/sec).
- **Files:** `apps/frontend/src/transport/api.ts`, `apps/frontend/src/canvas/to-patch.ts` (baseline reset), `apps/frontend/src/App.tsx`.
- **Related:** W3 (нет frontend tests на to-patch) — этот баг должен был бы покрываться unit-тестами на baseline reset.

### D7 — Программный `createShape` без `markHistoryStoppingPoint` не триггерит patch send

- **Severity:** major (тестовая обстановка).
- **Repro:** `editor.createShape({type:"arrow",...}); editor.createBindings([...])` → frontend listener не отправляет `add edge` op на backend. С `markHistoryStoppingPoint` перед createShape — отправляет правильно.
- **Expected:** Любое изменение в editor.store → diff → patch send (если source !== "remote").
- **Actual:** Listener привязан к history mark, а не к raw store change. Программные mutations без mark игнорируются.
- **Suggested fix:** Либо документировать (это intended — фильтр noise), либо listener'у дополнить event = store.listen('document') + diff vs prev baseline regardless of history mark.
- **Files:** `apps/frontend/src/App.tsx` (где подписка).
- **Workaround:** для tests / smoke использовать `editor.markHistoryStoppingPoint("...")` перед мутацией.

### D10 — CLI `apply --room <id>` и body `"room":...` игнорируются — всё идёт в `default`

- **Severity:** **CRITICAL** для multi-room flows.
- **Repro:**
  1. `shemma apply --stdin --room second <<< '{"actions":[{"kind":"define","role":"service","name":"X"}]}'` → response 200 + applied successfully.
  2. `shemma rooms list` → нет комнаты `second`. Все mutations попали в `default` (виден affected list с старыми шейпами default'а).
  3. Тот же эффект без `--room` (когда `"room"` положили в body JSON).
- **Expected:** `--room <id>` или body.room меняет target room для apply; rooms list показывает новую комнату.
- **Actual:** CLI `apply` не парсит `--room`, body.room игнорируется HTTP-route `/api/domain` (или body.room не передаётся в route'-router). Всё пишется в default.
- **Suggested fix:** Проверить в `packages/shemma-cli/src/index.ts:apply` — передаётся ли `--room` как `?room=<id>` query param. Проверить в `apps/backend/src/routes/domain.ts` — читается ли `query.room` для маршрутизации.
- **Files:** `packages/shemma-cli/src/index.ts`, `apps/backend/src/routes/domain.ts`.
- **Workaround:** Использовать `rooms import` для создания новой комнаты. Define/connect не имеют `--room` опции и привязаны к default.

### D11 — Все CLI domain команды (`define`, `connect`, `group`, ...) не поддерживают target room

- **Severity:** **CRITICAL** для multi-room AI workflows.
- **Repro:** `shemma --help` не показывает `--room` для define/connect/group/note/layout/delete. Команда `define service X` всегда пишет в default.
- **Expected:** Все domain команды должны принимать `--room <id>`, по умолчанию = `default`.
- **Suggested fix:** Добавить `--room` опцию во все domain dispatcher branches в `packages/shemma-cli/src/index.ts`. Передавать в HTTP request как `?room=<id>`.
- **Files:** `packages/shemma-cli/src/index.ts`, `packages/shemma-client/src/index.ts` (HTTP wrapper).
- **Related:** D10.

### D8 — Polling `/api/version` каждые ~5ms

- **Severity:** major (CPU + network spam).
- **Repro:** Открыть Network panel → виден поток `GET /api/version`, тысячи запросов в минуту.
- **Expected:** Polling на разумной частоте (раз в 10-30 секунд достаточно для update banner).
- **Actual:** Огромный rate (≥ 200 req/sec).
- **Suggested fix:** `setInterval(checkVersion, 30000)` или вообще через WS message kind `version-update`. Текущая реализация в `apps/frontend/src/transport/version.ts` — найти и проверить interval.
- **Files:** `apps/frontend/src/transport/version.ts`, `apps/frontend/src/chrome/UpdateBanner.tsx`.

### D5 — Children node coords при rendering в группе — absolute или relative?

- **Severity:** major.
- **Repro:** Continued from D3 — `async-side` group в (180, 160), children `worker`/`queue` в (10, 10). Frontend визуально показывает worker/queue в (10,10), НЕ внутри группы.
- **Expected:** Либо backend хранит absolute coords для children (тогда они должны быть updated при group), либо frontend учитывает parent group offset при render.
- **Actual:** Расхождение между backend storage и frontend interpretation. Spec неоднозначен.
- **Suggested fix:** Принять решение в ADR — рекомендую absolute coords для children (`Group` — это только контейнер-marker, без coord transform). Тогда layout должен ставить worker/queue в absolute (180+padding, 160+padding) после group action.
- **Files:** ADR new, `apps/backend/src/domain/{compile,layout-postprocess}.ts`, `apps/frontend/src/canvas/from-canvas-state.ts`.
- **Related:** D3, D4.

---

## Test debt

### B-T1 — Frontend unit tests для `to-patch.ts` (B1 arrow detection)

- **Source:** Phase 2.2 review W3.
- **Priority:** Important.
- **Effort:** M (1-2 дня).
- **Why:** B1 detection (`arrowToEdge`, `endpointFor`, `endpointEq`, arrow ветки в `diffToOps`) сейчас валидируется только manual smoke + backend integration test (который seedит nodes напрямую). Регрессия в endpoint extraction (terminal "start" vs "end") или binding snapshot пройдёт незамеченно.
- **Scope:**
  - Поднять `bun test` для frontend (новый `apps/frontend/tests/` + root script);
  - Fake `TLShape` + `TLArrowBinding` фикстуры;
  - Assertion'ы на ops, выдаваемые `diffToOps` для типовых пар (prev, next): новый arrow с двумя bindings; arrow без bindings; перемещение endpoint; смена dashed; удаление arrow.
- **Acceptance:** `bun run test` запускает frontend suite; покрытие arrow path хотя бы по 6 кейсам выше.
- **Files:** `apps/frontend/tests/to-patch.test.ts` (new), `apps/frontend/package.json` (test script), root `package.json` (workspace test glob).
- **Dependencies:** нет.

### B-T2 — tsc-strict в `apps/backend/tests/*`

- **Source:** Phase 2.2 review S8.
- **Priority:** Minor.
- **Effort:** S (½ дня).
- **Why:** 67 `noUncheckedIndexedAccess` warnings в test файлах. Bun test их не валидирует, поэтому функционально OK. Чисто для cleanliness.
- **Scope:** Пройти по тестам, добавить `!`-assertions или `if-guard` narrowing аналогично Phase 2.1 fix в `src/`.
- **Acceptance:** `cd apps/backend && bun run tsc --noEmit` — 0 errors.
- **Files:** `apps/backend/tests/*.test.ts` (по необходимости).

---

## Bug fixes / minor improvements (Phase 2.2 follow-ups)

### B-F1 — `pushOpLog(room, entry)` helper

- **Source:** Phase 2.2 review S1.
- **Priority:** Minor.
- **Effort:** S.
- **Why:** Cap-splice (`if (r.opLog.length > config.opLogMaxSize) r.opLog.splice(...)`) дублируется в 4 routes (patch, layout, domain). Уменьшит шанс забыть splice в новом роуте.
- **Scope:** Вынести в `apps/backend/src/rooms.ts` (или `types.ts`) функцию `pushOpLog(room: RoomState, entry: OpLogEntry, max: number)`; заменить 4 call site.
- **Acceptance:** Тесты остаются green; код-сайт сократился.
- **Files:** `apps/backend/src/rooms.ts`, `apps/backend/src/routes/{patch,layout,domain}.ts`.

### B-F2 — Убрать legacy `{kind:"hello", version:0}` initial WS frame

- **Source:** Phase 2.2 review S2.
- **Priority:** Minor.
- **Effort:** XS.
- **Why:** Сервер всегда шлёт `version: 0` независимо от реального `room.version`; frontend игнорирует (`ws.ts:84`). Бесполезный артефакт.
- **Scope:** Удалить `ws.send({kind:"hello", version:0})` из `apps/backend/src/index.ts:websocket.open` (или заменить на actual version с lookup `await rooms.get(room)`).
- **Acceptance:** `bun run test` green; WS handshake тесты остаются проходящими.
- **Files:** `apps/backend/src/index.ts`.

### B-F3 — Унифицировать `findGroupByName`

- **Source:** Phase 2.2 review S3.
- **Priority:** Minor.
- **Effort:** S.
- **Why:** Два разных `findGroupByName` (`routes/domain.ts` vs `domain/compile.ts`) с разной семантикой матчинга — граничные случаи рендерятся непредсказуемо.
- **Scope:** Унифицированный matcher в `apps/backend/src/domain/finders.ts` (или в `@shemma/domain`); оба сайта используют его.
- **Acceptance:** Один источник правды; добавить тест на граничный кейс (`meta.name="A"` + `label="B"`).
- **Files:** `apps/backend/src/domain/finders.ts` (new), `apps/backend/src/routes/domain.ts`, `apps/backend/src/domain/compile.ts`.

### B-F4 — `ErrorBanner` `MAX_VISIBLE` 5 → 3

- **Source:** Phase 2.2 review S4.
- **Priority:** Nit.
- **Effort:** XS.
- **Why:** Spec §5.1 говорит "последние 3 errors", код хранит 5. Либо снизить, либо обосновать.
- **Scope:** `MAX_VISIBLE = 3` в `error-bus.ts`, обновить spec если decision изменился.
- **Files:** `apps/frontend/src/state/error-bus.ts`.

### B-F5 — Schema-валидация `OpLogEntry` в `envelope.parseFull`

- **Source:** Phase 2.2 review S5.
- **Priority:** Minor.
- **Effort:** S.
- **Why:** Corrupt envelope (manually edited / data corruption) приведёт к runtime errors при serve. Защита дешёвая.
- **Scope:** В `parseFull` пройтись по `opLog[]`, валидировать `typeof e.version === "number"`, `Array.isArray(e.ops)`; некорректные entries отбрасывать + warn.
- **Acceptance:** Test на malformed envelope → не throws, opLog отфильтрован.
- **Files:** `apps/backend/src/envelope.ts`, `apps/backend/tests/envelope.test.ts`.

### B-F6 — Pause patches во время truncated-recovery

- **Source:** Phase 2.2 review S6.
- **Priority:** Minor.
- **Effort:** S.
- **Why:** Между `getState()` resolve и `replaceCanvasFromState(fresh)` могут прилететь новые WS patches → применяются → затираются. Самовосстанавливается на следующей операции, но визуальный flicker.
- **Scope:** Флаг `recoveringTruncated` в App.tsx; на `truncated` → set, await `getState()`, apply, unset. Patches во время recovery — буферизовать или дропать.
- **Files:** `apps/frontend/src/App.tsx`, возможно `apps/frontend/src/transport/ws.ts`.

### B-F7 — Обновить spec Phase 2.2 §3.1: `opLogMaxSize` default

- **Source:** Phase 2.2 review S7.
- **Priority:** Nit.
- **Effort:** XS.
- **Why:** Spec говорит 200, реальный код использует 50. Расхождение документации.
- **Scope:** Либо обновить spec, либо bump default до 200 (для местного use 50 разумно — несколько минут disconnect window).
- **Files:** `docs/superpowers/specs/2026-05-16-di-draw-phase2-2-sync-hardening-design.md` или `apps/backend/src/config.ts`.

### B-F8 — Omit `style:{dashed:false}` в arrow add op

- **Source:** Phase 2.2 review S9.
- **Priority:** Nit.
- **Effort:** XS.
- **Why:** Frontend генерирует `style:{dashed:false}` даже для solid arrows. Полу-явное состояние; уменьшит payload и шум в `meta.styleOwnedBy` inference.
- **Files:** `apps/frontend/src/canvas/to-patch.ts`.

### B-F9 — `update edge` endpoint-move (from/to bindings)

- **Source:** Phase 2.2 review fix W1, частично закрыт.
- **Priority:** Important (для full B1 UX).
- **Effort:** M.
- **Why:** Сейчас `update edge` в onPatch обрабатывает только style/label/color. Cross-client изменение endpoint (drag из одного шейпа в другой) не отображается на receive-side. Документировано TODO в `App.tsx`.
- **Scope:** В onPatch `update edge` branch: если `op.set.from` или `op.set.to` — удалить старые bindings, создать новые. Учесть `kind:"point"` (free endpoint, no binding).
- **Acceptance:** Manual smoke: client A двигает endpoint → client B видит. Backend integration test.
- **Files:** `apps/frontend/src/App.tsx` (onPatch handler), возможно extract в `apps/frontend/src/canvas/apply-edge-update.ts`.

---

## Future phases (roadmap-level)

> Каждая phase — отдельный brainstorm → spec → plan → execute цикл по [[feedback-plan-approval-gate]]. Версия — MINOR bump по SemVer.

### P-2.3 — MCP adapter v1 → 0.4.0

- **Trigger:** brainstorm.
- **Effort:** L (1-2 недели).
- **Why:** Тонкий MCP-adapter поверх `POST /api/domain` (не raw `/api/patch`), чтобы LLM-клиенты (Claude/Codex/corporate) работали с canvas через Model Context Protocol без CLI-обёртки.
- **Hints:** см. устаревший `docs/handoff/mcp-launch-brief.md` как стартовую точку. Tools surface: define/connect/group/note/layout/delete/context (отражение domain actions). Resource: `shemma://room/<id>/state`. Transport: stdio + HTTP/SSE.
- **Dependencies:** none (текущий `/api/domain` уже готов).

### P-2.4 — Import registry → 0.5.0

- **Trigger:** brainstorm.
- **Effort:** L.
- **Why:** Registry-based импорт из Mermaid / SVG / D2 / Miro JSON / image. Pluggable архитектура — каждый формат отдельный importer.
- **Hints:** registry shape — `Importer { name, accepts(blob), parse(blob): DomainActions[] }`. Frontend для image (AI vision), backend для текстовых. Idempotency: повторный import не дублирует.
- **Dependencies:** Mermaid импорт частично в ADR-0001 — пересмотреть, мигрировать в registry.

### P-2.5 — Export registry → 0.6.0

- **Trigger:** brainstorm.
- **Effort:** L.
- **Why:** Симметрично 2.4 — canvas → Mermaid / Miro REST / Figma REST / SVG / PNG / PlantUML.
- **Hints:** registry shape — `Exporter { name, produce(canvas): blob }`. Roundtrip-stability: import → export ≈ original. Lossy преобразования документировать в каждом exporter'е.
- **Dependencies:** в идеале после 2.4 (общая registry-инфраструктура), но не строго.

### P-2.6 — Multi-LLM docs → 0.7.0

- **Trigger:** brainstorm.
- **Effort:** M.
- **Why:** Документация и skill-инстансы для не-Claude клиентов (Codex AGENTS.md, Cursor .cursorrules, corporate LLM).
- **Scope:** extract shared cheat-sheet в `docs/llm/cheatsheet.md`; per-LLM artifacts; onboarding flow.
- **Dependencies:** none.

### P-3.x — Direction-level

> Без декомпозиции до spec'а. Roadmap отметки из CLAUDE.md.

- **Custom shapes** — domain extension к tldraw `Shape` registry (свои node-типы помимо rect/ellipse).
- **Drawing-as-first-class** — ink/scribble → domain, не просто tldraw chrome.
- **«Untangle» layout** — Cola/fCoSE force-directed как альтернатива ELK layered.
- **Multi-user collaboration** — CRDT/OT (Yjs?) поверх WS hello/replay фундамента (2.2).
