# di.draw — Backlog

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

_Пусто._

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
- **Scope:** Унифицированный matcher в `apps/backend/src/domain/finders.ts` (или в `@didraw/domain`); оба сайта используют его.
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
- **Hints:** см. устаревший `docs/handoff/mcp-launch-brief.md` как стартовую точку. Tools surface: define/connect/group/note/layout/delete/context (отражение domain actions). Resource: `didraw://room/<id>/state`. Transport: stdio + HTTP/SSE.
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
