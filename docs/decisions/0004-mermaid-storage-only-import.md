# ADR-0004: Mermaid storage-only import — Node-side path без браузера

**Date:** 2026-05-22
**Status:** Proposed (draft для approval gate; не реализуем до approve)
**Related:** [ADR-0001](0001-mermaid-import-location.md), DRW-127, DRW-124 (umbrella)

## Context

### Текущее состояние

- `shemma_import_mermaid` (MCP) → `POST /api/agent/import-mermaid?room=<id>` → WS-фрейм в живой browser-таб → `window.shemmaImportMermaid(source)` → `createMermaidDiagram(editor, source)` (`@tldraw/mermaid`).
- Если ни один WS-клиент не подписан на (space, room) → backend возвращает **HTTP 503 + room_url** (см. `apps/backend/src/routes/import-mermaid.ts:51`).
- Агент в этом случае не может ничего сделать кроме «попроси юзера открыть таб» — что нарушает SLA для headless / cron / cross-device сценариев и для случаев когда tab банально перезагружают между операциями.

### Что изменилось с ADR-0001 (2026-05-15)

ADR-0001 зафиксировал **frontend-only** на основании:
1. `@tldraw/mermaid.createMermaidDiagram(editor, text)` требует tldraw `Editor` instance (React + DOM mount).
2. `mermaid.parse(text)` возвращает `undefined` под jsdom — нет SVG layout engine, нет `getBoundingClientRect`, нет CSS layout.
3. `mmdc` через puppeteer работает, но возвращает SVG, а не tldraw shapes — лишний промежуточный слой.
4. Загрузка `@tldraw/mermaid` ~382 мс + блокирующий puppeteer → unfit для backend hot-path.

Эти выводы про **высокоуровневый mermaid API** **остаются в силе**. Новый вопрос: можно ли сделать **независимую** Node-side конверсию, минуя `@tldraw/mermaid` и `mermaid.parse()`?

### Проверка фактов (предварительная разведка)

- `@mermaid-js/parser@0.6.3` (транзитивно через `mermaid@11.12.2`) — **pure Node Langium-based parser БЕЗ DOM**. НО: его `parse(diagramType, text)` поддерживает **только** `info` / `packet` / `pie` / `architecture` / `gitGraph` / `radar` / `treemap` (см. `node_modules/.bun/@mermaid-js+parser@0.6.3/.../dist/src/parse.d.ts`). **Не покрывает `flowchart` / `graph TD/LR`** — то есть как раз тех диаграмм, которые мы рисуем на канвасе.
- Flowchart-парсер живёт **внутри** `mermaid` package: `node_modules/.bun/mermaid@11.12.2/.../mermaid/dist/diagrams/flowchart/parser/flowParser.js`. Это jison-generated артефакт, типизация `any` (private API). Открытый вопрос — работает ли он изолированно без DOM-инициализации mermaid-runtime (`flowDb.js` импортирует `MermaidConfig` и rendering helpers — потенциально тянет DOM).
- Текущий frontend import создаёт **сырые tldraw shapes** (`geo` / `arrow` / `frame`) с `meta.didrawName`, **не** domain actions с `role`/`connectionKind`. Domain context достаёт семантику через эвристики поверх `meta.role` (см. `apps/backend/src/domain/context.ts`).
- `POST /api/domain` (domain action API) **уже** делает auto-layout pass через ELK после batch'а (`apps/backend/src/routes/domain.ts:230-260`).

### Какие сценарии мы хотим разблокировать

1. Агент в headless сессии (cron, CI, scheduled) хочет залить схему без браузера.
2. Агент после ребута сервера / WS reconnect race хочет fallback'нуться без ждать тaba.
3. Cross-device: команда от агента на одном хосте, просмотр на другом (см. `feedback-product-vision-bidirectional`).
4. Massive batched seed (генерация N комнат для тестов / демо) без N открытых tab'ов.

## Considered options

### Option A — Bespoke flowchart parser → `/api/domain` actions

**Что:** написать собственный recursive-descent / regex-driven parser для строго ограниченного subset'а:
- `graph TD|TB|LR|RL|BT` / `flowchart TD|LR|...` (header).
- Node declarations: `id`, `id[Label]` (rect), `id(Label)` (round), `id{Label}` (diamond), `id((Label))` (circle), `id[[Label]]` (subroutine), `id[(Label)]` (cylinder/datastore), `id>Label]` (asymmetric).
- Edges: `-->`, `---`, `-.->`, `==>`, `--text-->`, `-->|label|`, `--label-->`.
- `subgraph name [Label] ... end` (nested OK).
- Опционально: `classDef` / class assignments → пробрасываем в `meta` для будущих стилей.

**Mapping → domain actions:**
- Cylinder `[(...)]` → `define { role: "datastore" }`
- Stadium / round-rect node → `define { role: "service" }` (default)
- Hex / asymmetric → `define { role: "external" }` (TBD via таблицу)
- `subgraph` → `group { as: "boundary", ids: [...] }`
- Edge → `connect { connectionKind: <inferred> }` (`-.->` → `dep`, `==>` → `sync` или `data` — обсудить).

**Pros:**
- Zero runtime deps (никакого mermaid runtime / jison / DOM).
- Полный контроль над scope: добавляем диаграмм-фичи только когда нужно.
- Output идёт через `/api/domain` → автоматически получаем atomic apply + auto-layout + naming discipline + pin discipline.
- Stable across mermaid version upgrades.

**Cons:**
- Maintenance: каждый новый mermaid feature (новый shape modifier, новый edge стиль) надо допиливать руками.
- Mermaid syntax имеет много corner cases (escape sequences, multi-line node labels, comments `%%`, frontmatter `---`); легко пропустить.
- Не bit-perfect с frontend импортом — могут быть мелкие визуальные отличия (другие default styles, другое layout positioning).

**Effort:** medium (parser + mapping + tests).

### Option B — Reuse mermaid `flowParser` jison module + custom AST walker

**Что:** загрузить `mermaid/dist/diagrams/flowchart/parser/flowParser.js` напрямую (НЕ через `mermaid.parse`), вызвать `flowParser.parse(text)` чтобы получить AST/SVG-free структуру, потом обойти её и сгенерировать domain actions.

**Pros:**
- Полный mermaid flowchart syntax «бесплатно».
- Гарантированный паритет с тем, что юзер привык писать.

**Cons:**
- **Private API** — `flowParser.d.ts` декларирован как `any`. Любой минорный апгрейд `mermaid` может сломать.
- **Не подтверждено что работает в чистом Node без DOM**: jison-парсер сам по себе чистый JS, но `flowDb` (state machine, куда parser пушит nodes/edges) импортирует config helpers и потенциально rendering utils. Нужен Phase 0 spike (5-15 минут на REPL): `import flowParser from '.../flowParser.js'; flowParser.parse('graph LR\nA-->B')`. Если падает — option B мёртв.
- Если работает — мы привязаны к internal layout mermaid 11.x.

**Effort:** small если spike passes; иначе сразу пропускаем.

### Option C — Hybrid: spike Option B; если работает — B, иначе A

**Что:** Phase 0 спайк на 30 минут, falsify-or-confirm Option B. Решение в spike-результате:
- B работает → используем B как primary parser, экономим maintenance.
- B падает → пишем A.
- В **обоих** случаях output идёт через `/api/domain`, MCP-tool API одинаковый.

**Pros:**
- Самый трезвый approach: не коммитимся к maintenance-heavy A пока не убедились что B unfeasible.
- Cost of spike мал.

**Cons:**
- Развилка в плане → две ветки имплементации в худшем сценарии (но во второй ветке мы просто берём A, которая уже описана).

**Effort:** spike (~30 мин) + либо B (small) либо A (medium).

### Option D — Headless tldraw (jsdom + `@tldraw/mermaid`)

**Что:** реализовать в Node полноценный jsdom environment, React, tldraw Editor instance, вызвать `createMermaidDiagram(editor, text)`, забрать получившиеся shapes из store.

**Pros:**
- Bit-perfect с frontend импортом.

**Cons:**
- ADR-0001 уже зафиксировал что mermaid.parse падает в jsdom (нет SVG layout); даже если решим эту проблему — heavy infra (jsdom + React + tldraw + mermaid bundle в Node + per-call init ~400ms).
- Принципиальный апгрейд риска: если кто-то поменяет tldraw / mermaid major — всё ломается.
- Противоречит spirit ADR-0001.

**Rejected** — не рассматриваем.

### Option E — `mmdc` puppeteer fallback с post-processing SVG → tldraw shapes

**Что:** запустить `mmdc` (как в ADR-0001 spike), получить SVG, парсить SVG и конвертить элементы в tldraw shapes.

**Pros:**
- Полная mermaid поддержка.

**Cons:**
- SVG → tldraw shapes — отдельный огромный конвертер с потерями (другая coordinate system, нет semantic info, кастомные styles потеряны).
- Chromium dependency на хосте + 1-2s overhead per call.
- Нет semantic roles (получаем geo+arrow shapes без `role: "service"` etc.) → теряем смысл domain layer.

**Rejected** — не рассматриваем.

## Decision (recommended)

**Option C (Hybrid)** с конкретным механизмом:

1. **Phase 0 spike** (≤30 мин): загрузить `mermaid/dist/diagrams/flowchart/parser/flowParser.js` напрямую, вызвать `parse('graph LR\nA-->B\nA-->C')`, проверить:
   - Работает ли без DOM-инициализации (нет throws).
   - Какой output (AST node tree? flowDb side-effects? оба?).
   - Стабилен ли API между minor-версиями mermaid 11.x (быстрый grep по changelog).
2. **Если B работает** → ADR-0004 финализируется в пользу Option B, импл идёт через mermaid flowParser.
3. **Если B падает** → ADR-0004 финализируется в пользу Option A, импл идёт через bespoke parser.

**В обоих случаях** API одинаковый:
- MCP tool `shemma_import_mermaid` получает новый param `mode?: "auto" | "storage" | "browser"` (default `"browser"` для backward compat).
- Backend получает новый endpoint `POST /api/agent/import-mermaid-storage?room=<id>` (или extend существующий с `?mode=storage`) — принимает source, делает parse → domain actions batch → forward to `/api/domain` internal call.
- В `mode: "auto"` сначала пробуется storage path; если diagram type unsupported (sequenceDiagram / classDiagram / etc.) → fallback на browser path; если browser path тоже не доступен (нет WS client) → возвращается `unsupported_diagram_no_browser` с pointer'ом на `shemma_open(waitForClient: true)`.

### Поддерживаемые типы диаграмм (Phase 1)

- `graph TD|TB|LR|RL|BT`
- `flowchart TD|TB|LR|RL|BT`
- Subgraphs (nested supported)
- Node shapes: rect, round, stadium, diamond, hex, circle, cylinder, asymmetric, subroutine
- Edge types: `-->`, `---`, `-.->`, `==>`, with optional `|label|` или inline `--text-->`
- Edge label inference → `connectionKind`: `-.->` → `dep`, `==>` → `data`, всё остальное → `sync` (default), explicit overrides из label parsing (TBD).
- Cylinder node `[(Label)]` → `role: "datastore"`; остальное → `role: "service"` (default), с возможностью override через `classDef`.

### Не поддерживаемые (Phase 1 — return `unsupported_diagram`)

- `sequenceDiagram`, `classDiagram`, `stateDiagram`, `erDiagram`, `gitGraph`, `mindmap`, `pie`, `timeline`, `journey`, `quadrantChart`, `xychart`, `sankey`, `requirementDiagram`, `c4Context` etc.
- Сложные `classDef` styling beyond simple role override (storage mode игнорирует визуальные стили — pure semantic import).
- `subgraph direction` overrides внутри subgraph'а.
- Mermaid frontmatter (`--- title: ... ---`) — игнорируется (не критично).

## Consequences

### Plus

- Headless / cron / cross-device сценарии разблокированы.
- Storage-mode импорт даёт semantic shapes сразу через `/api/domain` (с правильными `role` / `connectionKind` / auto-layout) — лучше чем текущий frontend path, который пишет raw geo shapes.
- Уменьшение reliance на browser tab как critical path для базовых операций.

### Minus

- Дополнительная поверхность для багов: парсер subset'а Mermaid — известный отстой (corner cases, ambiguity).
- Mode mismatch: один и тот же `graph LR\nA-->B` может в storage / browser давать разный визуальный результат (shape sizes, default styles). Документируем.
- Test surface: per-diagram-type matrix.

### Neutral

- API additive (новый mode param, новый endpoint) — не ломает существующих интеграций. **MINOR** version bump (`0.22.0` candidate) при финальном release.
- ADR-0001 **не отменяется** — он остаётся валидным для full mermaid (sequenceDiagram etc.); ADR-0004 покрывает только flowchart-subset Node path.

## Validation

После approve и импл:
1. Unit tests на parser (per option A/B):
   - Happy path: `graph TD\nA-->B`, `flowchart LR\nA[Foo]-->B(Bar)`.
   - Subgraph: `subgraph X\n A\n B\nend\nA-->B`.
   - Edge styles: `-->`, `-.->`, `==>`, with/without labels.
   - Node shapes: rect, round, diamond, cylinder.
   - Unsupported: `sequenceDiagram\n...` → `{ok: false, code: "unsupported_diagram", supported_in_browser_mode: true}`.
2. Integration tests:
   - `shemma_import_mermaid({source: "graph LR\nA-->B", mode: "storage"})` → запись в room JSON БЕЗ открытого browser.
   - `mode: "auto"` без WS client → storage path выбран.
   - `mode: "auto"` с WS client + sequenceDiagram → browser path выбран.
3. Smoke test:
   - Реальный мной открытый room, agent делает storage import, потом я обновляю tab — вижу те же shapes.

## Connected work

- DRW-127 (this).
- DRW-124 — umbrella; storage path закрывает P0.3 + часть P2.5 (replace/merge mode).
- P2.5 (replace/merge mode) — natural extension: добавить `mode: "replace" | "merge" | "append"` орthogonal к storage/browser; default = `append` (текущее поведение).
- DRW-133 (waitForClient) — комплементарен: storage даёт fallback когда WS вообще не доступен, waitForClient даёт reliable browser path когда tab можно открыть.

## Approval gate

**Не реализуем до явного approve user'а на:**
1. Option C (spike-then-commit) vs strict A (skip spike, сразу bespoke).
2. Scope диаграмм Phase 1 (раздел «Поддерживаемые типы») — что добавить / убрать.
3. `mode` default: `"browser"` (backward compat) vs `"auto"` (опционально лучше UX).
4. Endpoint shape: новый `/api/agent/import-mermaid-storage` vs extend существующий через `?mode=`.
5. Финальный release version: `0.22.0` (MINOR, additive) vs `0.21.13` (если рассматривать как чистый bugfix). Рекомендация — MINOR из-за нового MCP param + endpoint surface.

После approval — обновить `next-session-drw-127.md` с финальным решением + написать plan.
