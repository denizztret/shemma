# Export selection → Miro (Design)

**Version:** 0.2
**Date:** 2026-05-20
**Status:** draft v0.2 — user review pending
**Target release:** 0.19.0 (MINOR bump, новая фича)
**Tracking:** Backlog [[DRW-103]]
**Related:** [[feedback-product-vision-bidirectional]] (canvas local + share to Miro для stakeholder collaboration)

## Changelog

- v0.2 (2026-05-20) — revision pass по review feedback. Главные изменения:
  - §10.0 **новая под-секция**: envelope schema extension (`RoomMeta` ввод в `types.ts` + `envelope.ts`), без bump `ENVELOPE_SCHEMA_VERSION` (additive optional).
  - §5.1 переписан: убрана ссылка на ADR-0002 (это про domain Group, не tldraw frame); добавлен page-space resolution через `editor.getShapePageBounds()` либо bottom-up `parentId` walk перед bbox computation. Frame children в tldraw 5.x хранят `x, y` относительно parent frame.
  - §6 переписан: Pass A разделён на **A1 (frames only)** и **A2 (остальные items с уже известным `parent.id`)** двумя последовательными bulk POST. Mapping frame_id доступен между A1 и A2.
  - §10.2 + §13: Critical Open Question — verify Miro item `metadata` vs `appData` field name; blocks idempotency tracking story; добавлено как implementation phase task #1.
  - §13: 16 hex preset values для shape `style.fillColor` подняты до Critical; fallback path — borderColor-only mapping в 0.19.0 + defer fillColor в 0.19.1 (graceful degradation).
  - §7.5 **новая**: CLI sub-command `shemma config` — delegate в `packages/shemma-cli/src/config.ts`; error style consistent с `cmdDoctor`; `--json` mode; единый файл `~/.config/shemma/config.json` (schema-decision locked).
  - §7.6 **новая**: backend `config.ts` file I/O — `configFilePath`, `readConfig`, `writeConfig`, `readMiroToken`, `writeMiroToken`, `unsetMiroToken`. Token caching: read-once-per-request (без in-memory cache).
  - §14: MCP registration переведена на new-file pattern: `tools/export-miro.ts` (NEW) + `server.ts` EDIT; убран `tools/domain.ts` EDIT.
  - §5.5 переписан на tldraw 5.x binding API: отдельные `binding` records (typeName `binding`), `editor.getBindingsFromShape(arrowId)`; `normalizedAnchor` → `snapTo` mapping с порогами 0.25/0.75.
  - §11.2 расширены color-mapping tests: tie-breaking, case-insensitive, shorthand `#f00`, malformed input, property test.
  - §5.2.1 **новая**: group selection expansion через `editor.getShapeAndDescendantIds()`.
  - §5.1 added note: centroid → (0,0) — known limitation, Miro не auto-pans.
  - Minor: §3 diagram fix (context menu в `chrome/TldrawComponents.tsx`), §10.2 `shemmaVersion` через `VERSION.version`, §6.3 unified phrasing, §11.3 token validation moved to §11.2 unit.
- v0.1 (2026-05-19) — initial draft after brainstorm + research

---

## 1. Motivation

shemma — инструмент pair-coding с LLM через canvas: AI и пользователь рисуют в общем пространстве, видят результаты в реальном времени. Это ценно в рамках сессии, но **схемы живут дальше неё** — их нужно донести до коллег, stakeholder'ов, reviewers, которые работают в других инструментах.

Запрос пользователя (2026-05-19): «одна из главных задач — экспорт выбранной схемы (select on canvas + export from gallery)». Основной кандидат для stakeholder collaboration — **Miro**: широко распространённый whiteboard tool с развитым API и high adoption в командах.

### Почему SVG export недостаточен

tldraw предоставляет `editor.toSVG()` из коробки (доступен через Cmd+Shift+S в стандартном tldraw UI). Это растровое изображение в векторной упаковке — оно:

- **Теряет editability**: shapes в Miro становятся плоской картинкой, а не объектами, которые можно двигать, переименовывать, подключать к другим элементам.
- **Теряет структуру**: нет отдельных shapes, нет коннекторов, нет вложенности (frame → children).
- **Теряет фирменный стиль Miro**: stakeholder'ы не могут применить Miro-стили или подключить к своим диаграммам.

**Структурный export** (Path A, Miro REST API v2) сохраняет:
- Точные координаты и размеры каждого shape.
- Цвета (с nearest-preset маппингом для shapes, named-color маппингом для sticky notes).
- Текстовые метки.
- Коннекторы с привязкой к source/target shapes.
- Frame-контейнеры с дочерними элементами.

### Value для shemma как pair-coding tool

[[feedback-product-vision-bidirectional]] описывает di.draw как инструмент, где AI видит всё, что рисует пользователь, а пользователь — всё, что рисует AI. Miro export дополняет эту vision: **артефакты, созданные совместно с AI на canvas, могут быть переданы дальше в экосистему команды** без потери структуры.

Конкретные сценарии использования:
- Разработчик с AI спроектировал backend-архитектуру на shemma canvas → экспортировал в Miro-доску для review с tech lead.
- AI отрисовал domain model из кодовой базы → разработчик поделился в Miro для командного обсуждения.
- Pair-сессия завершилась набором схем → несколько выбранных shapes ушли в Miro для документирования.

---

## 2. Goal & non-goals

### 2.1 Goal

Реализовать **selection-based structural export из shemma canvas в Miro board** с 1:1 fidelity геометрии, структуры и содержимого. Export доступен через:
- Hotkey `⌘⇧E` при активной selection.
- Context menu item «Export to → Miro».
- MCP tool `shemma_export_miro` для AI-агентов.

Авторизация — через developer non-expiring token, хранящийся локально в `~/.config/shemma/config.json` (единый config-файл для всех services, см. §7.1). Управление токеном — через CLI `shemma config set miro.token <token>`.

### 2.2 Non-goals

| Non-goal | Причина |
|---|---|
| draw.io export | Отдельная задача (другой API, другое mapping). Архитектура export-модуля проектируется расширяемой (§3), но draw.io не входит в этот scope. |
| Excalidraw export | Аналогично draw.io — отдельная задача. |
| Bi-directional sync (Miro → shemma) | Отдельная phase candidate. Требует Miro webhooks + reverse import pipeline. |
| OAuth 2.0 full flow | Избыточен для local single-user tool. Developer non-expiring token достаточен. Если shemma когда-либо станет multi-user SaaS — OAuth добавят отдельным MR. |
| Реальный update существующих Miro items | Для обновления нужен PATCH к Miro API; в этом scope — только tracking table (metadata.shemmaId) для будущего update path. Повторный export создаёт новые items поверх (append-only). |
| Templated multi-board export | Слишком широкий scope. Один board per export. |
| Rollback при частичном успехе | Miro API append-only; созданные items остаются. User видит partial export + error. |
| Поддержка вложенных frame >1 уровня | Miro frames не поддерживают вложенность. Ограничение документируется, не эмулируется. |
| Full richText → Miro formatting | MVP: plain text. Rich conversion (bold, links, списки) — отдельное улучшение. |

### 2.3 Versioning

**0.19.0** — MINOR bump согласно SemVer pre-1.0 (см. [[feedback-gitflow-semver-tags]]). Breaking changes отсутствуют — исключительно новая функциональность:
- Новые HTTP endpoints `/api/export/miro`, `/api/export/miro/boards`.
- Новый MCP tool `shemma_export_miro`.
- Новая CLI-команда `shemma config set/get/unset miro.token`.

---

## 3. Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  USER / AI TRIGGERS                                                  │
│                                                                      │
│  ⌘⇧E hotkey / context menu → opens Export modal in frontend          │
│  MCP tool shemma_export_miro({ boardId, scope, dryRun })             │
│  (оба path идут через daemon HTTP API)                               │
└────────────────┬─────────────────────────────────────────────────────┘
                 │ POST /api/export/miro
                 │ { boardId, scope, room }
                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│  BACKEND DAEMON (:8787 release / :8788 dev)                          │
│                                                                      │
│  routes/export.ts                                                    │
│  ├── GET  /api/export/miro/boards   (board list, TTL cache 5 min)    │
│  └── POST /api/export/miro          (start export, returns result)   │
│         │                                                            │
│         ▼                                                            │
│  export/miro/upload.ts  (two-pass orchestrator)                      │
│  ├── read room state (rooms.load → TLStoreSnapshot)                  │
│  ├── export/miro/builder.ts  (domain → Miro payload per shape)       │
│  │   ├── export/miro/color-mapping.ts  (nearest hex preset)          │
│  │   └── richTextToPlain  (ProseMirror → string)                     │
│  ├── Pass A: POST /v2/boards/{id}/items/bulk (shapes/notes/frames)   │
│  │   → capture Miro item ids                                         │
│  ├── Pass B: POST /v2/boards/{id}/connectors × N (connectors)        │
│  └── export/miro/tracking.ts  (write room.meta.miroExports)          │
│                                                                      │
│  export/miro/client.ts  (Miro REST v2 HTTP wrapper + retry logic)   │
│  config.ts  (XDG config reader, miro.token)                          │
└──────────────────────────────────────────────────────────────────────┘
                 │ bearer token
                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│  MIRO REST API v2  (https://api.miro.com/v2/boards/{id}/...)         │
│  POST shapes / sticky_notes / text / frames / connectors             │
└──────────────────────────────────────────────────────────────────────┘

CONFIG:
  ~/.config/shemma/config.json  (chmod 600, единый файл для всех services)
  → { "miro": { "token": "...", "createdAt": "..." } }
  room.meta.miroExports: Record<boardId, Record<elementId, miroItemId>>
  (см. §10.0 envelope schema extension — `meta?: RoomMeta` опциональное поле)

PACKAGES/FILES:
  apps/backend/src/export/miro/   — новый модуль (client + builder + upload + tracking)
  apps/backend/src/routes/export.ts — новый route
  apps/backend/src/config.ts      — расширить (новые exports: configFilePath, readConfig, writeConfig, *MiroToken)
  apps/backend/src/types.ts       — `RoomMeta` type, `RoomState.meta?: RoomMeta`
  apps/backend/src/envelope.ts    — `EnvelopeV3.meta?: RoomMeta`, plumbing через buildV3/parseFull
  packages/shemma-cli/src/config.ts — shemma config sub-command (NEW file, delegate из index.ts)
  packages/shemma-cli/src/index.ts — switch-case `cmd === "config"` → delegate
  packages/shemma-mcp/src/tools/export-miro.ts — MCP tool (NEW file, one-file-per-tool pattern)
  packages/shemma-mcp/src/server.ts — registerExportMiroTool(server, deps)
  apps/frontend/src/canvas/export-miro-modal.tsx — UI modal
  apps/frontend/src/App.tsx       — ⌘⇧E hotkey + modal integration
  apps/frontend/src/chrome/TldrawComponents.tsx — context menu item «Export to Miro»
```

**Расширяемость под draw.io / Excalidraw:** `apps/backend/src/export/` является родительским модулем. Будущий `export/drawio/` или `export/excalidraw/` следует той же структуре (client + builder + upload + tracking). Frontend `ExportModal` поддерживает submenu «Export to → [Miro] [draw.io] [Excalidraw]»; в 0.19.0 доступна только строка Miro.

**Context menu integration** (C2 architecture cross-check): пункт меню «Export to Miro» добавляется в `apps/frontend/src/chrome/TldrawComponents.tsx` (рядом с уже существующим Tidy item, добавленным в DRW-088), а не в `App.tsx`. `App.tsx` содержит только hotkey-handler и lifecycle state модала. Это обеспечивает соответствие §3.8 service-layer pattern из CLAUDE.md.

---

## 4. Locked decisions

Все четыре решения приняты по результатам brainstorm + research (2026-05-19). Переоткрывать не нужно.

### 4.1 Auth: developer non-expiring token

**Решение:** developer non-expiring token из Miro developer settings, хранится в `~/.config/shemma/config.json` (единый файл, ключ `miro.token`, chmod 600). Backend daemon читает токен один раз per export request (см. §7.1 token caching). Нет OAuth flow, нет browser redirect, нет refresh tokens.

**Rationale:** shemma — local single-user tool. OAuth 2.0 с full flow (client_id + client_secret + redirect_url, refresh каждые 60 дней) добавляет существенную complexity ради multi-user сценария, которого у shemma нет. Developer non-expiring token получается однократно через Miro developer portal для своего аккаунта и не истекает — это оптимальное соотношение простоты и безопасности для desktop local-first tool.

Сравнение:
- OAuth full flow: ≥200 LOC (HTTP server для redirect callback, token store, refresh scheduler) — избыточен.
- Non-expiring developer token: ~30 LOC (file read + bearer header) — достаточен.

### 4.2 Color mapping: nearest-color по Euclidean RGB distance

**Решение:** автоматический mapping shemma hex → ближайший Miro preset через Euclidean distance по RGB. 16 hex presets для `shapes`, 16 named-color enums для `sticky_notes`. Helper `nearestShapeColor(hex)` / `nearestStickyColor(hex)` (~30 LOC) в `apps/backend/src/export/miro/color-mapping.ts`.

**Rationale:** Miro REST API принимает `style.fillColor` только из фиксированного набора preset hex-значений (для shapes) и named enum (для sticky notes). Произвольный hex невозможен. Альтернативы:
- **Показывать preview маппинга перед export** — UX overhead, тормозит workflow; цвета в Miro — не primary value export'а.
- **Использовать borderColor + прозрачный fill** — не передаёт fill intent пользователя.
- **Nearest-color auto-mapping** — минимальный friction, разумная fidelity для типичных palette (синие, зелёные, красные оттенки находят близкие аналоги).

`borderColor` принимает произвольный hex — проходит без маппинга.

### 4.3 Target board: per-export selection через modal

**Решение:** при каждом export пользователь выбирает целевую Miro board из списка (`GET /v2/boards?limit=50`). Last-used board отображается первой и является выбором по умолчанию. Backend кэширует список board'ов in-memory с TTL ~5 минут.

**Rationale:** фиксированная board в конфиге удобна для повторных export'ов, но неудобна при работе с несколькими проектами / командами. Modal с последней использованной board как default даёт быстрый happy-path (один клик «Export») и гибкость при смене контекста.

### 4.4 Idempotency: append-only + external id tracking

**Решение:** каждый export только создаёт новые items (append-only). Каждый Miro item получает поле `metadata.shemmaId = <element_id>` + `metadata.exportedAt = <ISO timestamp>` + `metadata.shemmaRoom = <roomId>` + `metadata.shemmaVersion`. Tracking-table записывается в room metadata: `room.meta.miroExports: Record<boardId, Record<elementId, miroItemId>>` (новое поле в `RoomMeta`, см. §10.0).

**Rationale:** update-on-re-export требует PATCH к Miro API (другой набор endpoints) и логики diff'а между canvas state и Miro state. Это значительно расширяет scope 0.19.0. Append-only семантика проста, не ломает ничего в Miro (пользователь всегда видит, что появилось). Tracking table создаёт foundation для update path в будущей задаче без архитектурного переделывания.

**Pending field name verification (Critical, см. §13 OQ#4):** research report не подтверждает имя поля `metadata` в Miro REST v2; возможный реальный API — `appData` (per-app scratchpad с другими quota constraints). **Это blocker для tracking story.** Implementation phase task #1: probe `POST /v2/boards/{id}/shapes` с обоими вариантами + проверить response shape. Если доступен только `appData` — document quota constraints (max ~32KB per app per item; одно приложение per token); payload `metadata` → переименовать в `appData` без других правок (структура одинаковая). Этот fix не меняет архитектуру §10, только сериализацию payload в `builder.ts`.

---

## 5. Domain → Miro mapping

### 5.1 Coordinate system translation

**tldraw coordinate space (5.x):**
- Начало координат — top-left страницы (page origin).
- Ось Y направлена вниз.
- Каждый shape имеет `x, y` (top-left corner) + `props.w, props.h` (ширина, высота).
- **Для shape без `parentId`** (top-level): `x, y` — абсолютные page-space координаты.
- **Для shape с `parentId === <frame_id>`** (ребёнок frame): `x, y` хранятся **относительно coordinate space родителя**, не absolute page-space. Это стандартное поведение tldraw 5.x (см. `docs/references/tldraw-cheatsheet.md` §"frame children parent-relative" + DRW-082 fix). Frame coordinate space — это локальная система с origin в top-left frame.

> **NB (revision v0.2):** в v0.1 ошибочно ссылались на ADR-0002 как обоснование "absolute coords". ADR-0002 описывает координатную модель **domain Group** (`Group.children: ElementId[]`, без `meta.parent`) — это shemma-domain абстракция, **не tldraw frame**. tldraw 5.x frame children всегда parent-relative. Эту разницу необходимо учитывать в page-space resolution ниже.

**Miro coordinate space:**
- Начало координат — центр доски (0, 0).
- Ось Y направлена вниз.
- `position.x, position.y` — center coordinates (центр shape на Miro board).
- `geometry.width, geometry.height` — размеры.
- Для item с `parent.id` — Miro принимает координаты в parent-relative space (Miro нормализует автоматически на сервере).

**Алгоритм перевода:**

**Шаг 0 — page-space resolution.** Перед bbox computation для каждого shape в selection необходимо получить абсолютные page-space `x, y`. Возможны два пути в зависимости от того, выполняется build на frontend или backend:

```typescript
// Path A (frontend builder, через tldraw Editor instance) — preferred:
//   editor.getShapePageBounds(shape.id) → { x, y, w, h } in absolute page-space.
//   tldraw walks parentId chain внутри.
const bounds = editor.getShapePageBounds(shape.id);
if (!bounds) continue; // shape удалён или невидим — skip
const absX = bounds.x;
const absY = bounds.y;
const absW = bounds.w;
const absH = bounds.h;

// Path B (backend builder, только raw store snapshot — без Editor):
//   bottom-up walk parentId chain, summировать offsets parent shapes.
function resolvePageBounds(
  shapeId: string,
  store: Record<string, RawShape>,
): { x: number; y: number; w: number; h: number } | null {
  const s = store[shapeId];
  if (!s) return null;
  let ax = s.x;
  let ay = s.y;
  let cur = s.parentId;
  // tldraw parentIds: "page:<...>" (top-level), "shape:<frameId>", ...
  while (cur && cur.startsWith("shape:")) {
    const p = store[cur];
    if (!p) break;
    ax += p.x;
    ay += p.y;
    cur = p.parentId;
  }
  return { x: ax, y: ay, w: s.props.w, h: s.props.h };
}
```

**Решение:** frontend инициирует export → frontend build delegate-ируется в backend через payload `{ shapes: ResolvedShape[] }`, где каждый `ResolvedShape` уже содержит page-space `x, y, w, h` + `parentId` (если есть) + props. Это позволяет переиспользовать `editor.getShapePageBounds` (надёжный API) и не дублировать walker-логику. MCP-tool path (без Editor instance) — использует Path B на backend.

**Шаг 1 — bounding box selection (всё в page-space):**

```typescript
const bbox = {
  x: Math.min(...resolved.map((s) => s.pageX)),
  y: Math.min(...resolved.map((s) => s.pageY)),
  x2: Math.max(...resolved.map((s) => s.pageX + s.w)),
  y2: Math.max(...resolved.map((s) => s.pageY + s.h)),
};
```

**Шаг 2 — centroid:**

```typescript
const centroidX = (bbox.x + bbox.x2) / 2;
const centroidY = (bbox.y + bbox.y2) / 2;
```

**Шаг 3 — top-left page-space → center Miro:**

```typescript
const miroX = (resolved.pageX + resolved.w / 2) - centroidX;
const miroY = (resolved.pageY + resolved.h / 2) - centroidY;
```

Centroid selection → `(0, 0)` на Miro board.

**Known limitation: Miro не auto-pans.** При создании items через API Miro **не центрирует viewport** на области created items. User увидит export в `(0, 0)` board area; для навигации в Miro UI — `Cmd+A` → `Frame It`, либо открыть board через `boardUrl` из result (опционально query-параметр `viewport=` если Miro поддерживает; на момент v0.2 spec — не verified). Это accept-as-known, не вынесено в Open Questions.

**Frame children в Miro payload.** Поскольку шаг 0 даёт нам абсолютные page-space координаты для **всех** shapes (включая frame children), centroid-translation применяется одинаково. Miro принимает `position` в координатах parent (если `parent.id` указан) — для frame children необходимо дополнительно **обратное преобразование** в frame-relative space:

```typescript
// Для shape с parent.id (frame child в Miro):
const miroFrameX = framePosition.x;          // уже translated к Miro centroid
const miroFrameY = framePosition.y;
const childAbsMiroX = (shape.pageX + shape.w / 2) - centroidX;
const childAbsMiroY = (shape.pageY + shape.h / 2) - centroidY;
const childRelX = childAbsMiroX - miroFrameX;
const childRelY = childAbsMiroY - miroFrameY;
// payload: parent.id = <miro_frame_id>, position = { x: childRelX, y: childRelY }
```

Pre-condition: `miro_frame_id` доступен **после Pass A1** (см. §6 two-pass split). Дети попадают в Pass A2 с уже resolved `parent.id`.

### 5.2 Shape kind mapping

| tldraw shape type | tldraw `props.geo` | Miro endpoint | Miro payload |
|---|---|---|---|
| `geo` (rectangle) | `rectangle` | `POST /shapes` | `shape: "rectangle"` |
| `geo` (ellipse) | `ellipse` | `POST /shapes` | `shape: "circle"` |
| `geo` (diamond) | `diamond` | `POST /shapes` | `shape: "rhombus"` |
| `geo` (triangle) | `triangle` | `POST /shapes` | `shape: "triangle"` |
| `geo` (trapezoid) | `trapezoid` | `POST /shapes` | `shape: "trapezoid"` |
| `geo` (pentagon) | `pentagon` | `POST /shapes` | `shape: "pentagon"` |
| `geo` (hexagon) | `hexagon` | `POST /shapes` | `shape: "hexagon"` |
| `geo` (octagon) | `octagon` | `POST /shapes` | `shape: "octagon"` |
| `geo` (star) | `star` | `POST /shapes` | `shape: "star"` |
| `geo` (cross) | `cross` | `POST /shapes` | `shape: "cross"` |
| `geo` (cloud) | `cloud` | `POST /shapes` | `shape: "cloud"` |
| `geo` (arrow-right) | `arrow-right` | `POST /shapes` | `shape: "right_arrow"` |
| `geo` (arrow-left) | `arrow-left` | `POST /shapes` | `shape: "left_arrow"` |
| `geo` (прочие) | — | `POST /shapes` | `shape: "rectangle"` (fallback) |
| `note` | — | `POST /sticky_notes` | `style.fillColor: <named>` |
| `text` | — | `POST /text` | `data.content` |
| `arrow` | — | `POST /connectors` | `startItem.id`, `endItem.id` |
| `frame` | — | `POST /frames` | `data.title`, `data.type: "freeform"` |
| `geo + meta.role === "boundary"` | — | `POST /frames` | Mermaid subgraph → Miro frame |
| `group` (tldraw composite) | — | (skip) | Нет визуального представления в Miro; children размещаются с теми же координатами |
| `draw`, `line`, `image`, `video`, `highlight` | — | (skip with warning) | Не поддерживается в Miro v2 structured export |

**Miro shapes — полный список 20 видов:** `rectangle`, `round_rectangle`, `circle`, `triangle`, `rhombus`, `parallelogram`, `trapezoid`, `pentagon`, `hexagon`, `octagon`, `wedge_round_rectangle_callout`, `star`, `flow_chart_predefined_process`, `cloud`, `cross`, `can`, `right_arrow`, `left_arrow`, `left_right_arrow`, `left_brace`, `right_brace`.

**Unsupported tldraw types** (draw strokes, line, image, video, bookmark, highlight, embed): пропускаются с предупреждением в result summary. User видит `skippedTypes: ["draw", "image"]` в toast по завершению export.

**Ограничение: frame nesting.** Miro frames не поддерживают вложенность (максимум 1 уровень). Если в tldraw selection содержится frame внутри frame, top-level frame становится Miro frame, inner frame становится обычным `shape: "rectangle"` без `parent.id`. Документируется как known limitation; warning в результате export.

### 5.2.1 Group selection expansion

tldraw 5.x поддерживает **group** shape — composite contains других shapes (визуально объединены, перемещаются вместе). В Miro нет прямого эквивалента: group сам не имеет visual representation, только children отображаются.

**Алгоритм expansion:**

```typescript
// Перед collection selection items'ов:
function expandGroups(
  editor: Editor,
  selectedIds: TLShapeId[],
): TLShapeId[] {
  const result = new Set<TLShapeId>();
  for (const id of selectedIds) {
    const shape = editor.getShape(id);
    if (!shape) continue;
    if (shape.type === "group") {
      // editor.getShapeAndDescendantIds returns Set<TLShapeId>.
      // For a group: returns the group itself + all descendants.
      const descendants = editor.getShapeAndDescendantIds([id]);
      for (const dId of descendants) {
        const ds = editor.getShape(dId);
        if (ds && ds.type !== "group") {
          result.add(dId);
        }
      }
    } else {
      result.add(id);
    }
  }
  return Array.from(result);
}
```

**Semantics:**
- Group shape сам **drop'ается** из export payload (no visual в Miro).
- Children экспортируются как обычные items.
- Если group вложена в group — рекурсивно через `getShapeAndDescendantIds`.
- Если group внутри frame: дети сохраняют `parentId === <frame_id>` (tldraw store), Miro `parent.id` указывает на frame.

**Backend path (MCP tool без Editor):** на raw store snapshot — итерация по `store` записям, для каждого `shape:group` собрать children через field `parentId === <group_id>` (scan all shapes), повторить рекурсивно. Не нужен Editor instance.

### 5.3 Color mapping

**Shapes (`style.fillColor`):**

Miro shapes принимают `fillColor` только из фиксированного набора 16 preset hex-значений. Точные значения этого набора необходимо проверить через enum в ответе Miro API (или OpenAPI spec).

> **Critical (revision v0.2):** 16 preset hex values — **blocker for color-mapping.ts implementation**. Без них nearest-neighbour алгоритм не имеет targets. Implementation phase task #1: пробить Miro API одним из путей:
> 1. `POST /v2/boards/<test_board>/shapes` с произвольным `style.fillColor` — Miro вернёт validation error со списком допустимых значений.
> 2. `GET /v2/boards/<id>/shapes` после ручного создания shapes разных цветов в UI — извлечь `style.fillColor` enum.
> 3. Miro OpenAPI spec download (`https://api.miro.com/openapi/v2.json` или аналог).
>
> **Fallback path (graceful degradation, _не_ default):** если probe затруднён к моменту implementation start —
> ship **borderColor-only mapping** в 0.19.0: `style.fillColor` остаётся undefined (Miro default — white или transparent fill), `style.borderColor` принимает произвольный hex и передаётся pass-through. Документировать как "Phase 1 color fidelity"; defer fillColor preset support в 0.19.1 follow-up. Это позволяет shipать 0.19.0 без blocker'а.

```
TODO(implementation phase task #1): verify exact 16 hex values for style.fillColor
via Miro OpenAPI spec / probe response / enum. Embed values in
SHAPE_PRESETS array в color-mapping.ts. Update color-mapping.test.ts fixtures.
```

Алгоритм маппинга:

```typescript
// apps/backend/src/export/miro/color-mapping.ts

type RGB = [number, number, number];

const SHAPE_PRESETS: Array<{ hex: string; rgb: RGB }> = [
  // TODO(implementation): заполнить из Miro OpenAPI spec
  { hex: "#ffffff", rgb: [255, 255, 255] },
  { hex: "#f5f6f8", rgb: [245, 246, 248] },
  // ... 14 остальных
];

function parseHex(hex: string): RGB {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function euclideanDistance(a: RGB, b: RGB): number {
  return Math.sqrt(
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
  );
}

export function nearestShapeColor(hex: string): string {
  const input = parseHex(hex);
  let best = SHAPE_PRESETS[0];
  let bestDist = Infinity;
  for (const preset of SHAPE_PRESETS) {
    const dist = euclideanDistance(input, preset.rgb);
    if (dist < bestDist) {
      bestDist = dist;
      best = preset;
    }
  }
  return best.hex;
}
```

**Sticky notes (`style.fillColor`):**

Miro sticky notes принимают named color enum. 16 значений: `gray`, `light_yellow`, `yellow`, `orange`, `light_green`, `green`, `dark_green`, `cyan`, `light_pink`, `pink`, `violet`, `red`, `light_blue`, `blue`, `dark_blue`, `black`.

Для каждого named color необходимо получить соответствующий hex-эквивалент (визуальный цвет Miro sticky note) и построить аналогичный nearest-match маппинг.

```
TODO(implementation): verify RGB approximations for 16 Miro sticky_note named colors
(gray, light_yellow, yellow, orange, ...) из Miro documentation или визуально.
```

**Border color:** `style.borderColor` принимает произвольный hex — pass-through без маппинга.

**Text color:** `style.color` принимает произвольный hex — pass-through.

**Quirk:** поле называется `style.color` (не `style.fontColor`) — см. §5.6 quirks.

### 5.4 Text content

tldraw хранит текст в shapes как `props.richText` (ProseMirror document JSON). Miro принимает plain string `data.content`.

**MVP: plain text extraction.** ProseMirror doc содержит `doc.content[]: { type: "paragraph" | "heading" | ..., content: [{ type: "text", text: "..." }] }`. Алгоритм:

```typescript
export function richTextToPlain(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const root = doc as { content?: unknown[] };
  if (!Array.isArray(root.content)) return "";

  const lines: string[] = [];
  for (const block of root.content) {
    const b = block as { content?: unknown[] };
    if (!Array.isArray(b.content)) continue;
    const line = b.content
      .filter((n): n is { type: string; text: string } =>
        typeof n === "object" && n !== null && "text" in n,
      )
      .map((n) => n.text)
      .join("");
    lines.push(line);
  }
  return lines.join("\n").trim();
}
```

Форматирование (bold, italic, links, code spans) теряется — это documented limitation для MVP.

### 5.5 Connector anchoring

> **Revision v0.2:** переписано на actual tldraw 5.x binding API. В v1 ошибочно говорилось про "arrow shape имеет bindings start/end" — на самом деле в tldraw 5.x **bindings — отдельные records** (`typeName: "binding"`), хранятся в `editor.store` или `EnvelopeV3.store.store`, не в props arrow shape. Reference: `docs/references/tldraw-cheatsheet.md` (line 123: "Arrow в tldraw 5.x — shape `type='arrow'` + опциональные `binding` records").

**tldraw 5.x binding structure:**

```typescript
// editor.store.allRecords() возвращает mixed shapes + bindings + assets.
type TLArrowBinding = {
  typeName: "binding";
  id: `binding:${string}`;
  type: "arrow";
  fromId: TLShapeId;   // arrow shape id
  toId: TLShapeId;     // target shape id (то, к чему привязан конец стрелки)
  props: {
    terminal: "start" | "end";
    normalizedAnchor: { x: number; y: number }; // 0..1, relative к target bounds
    isPrecise: boolean;
    isExact: boolean;
    snap?: "none" | "edge" | "center"; // tldraw 5.x: ElbowArrowSnap (см. DRW-076)
  };
};
```

Для одной arrow может существовать 0/1/2 binding records (по одной на конец). Free-floating arrow — `props.start/end` имеют form `{ type: "point", x, y }` (absolute coords) и **нет** binding records с `fromId === arrowId`.

**Collection алгоритм (frontend, Editor instance available):**

```typescript
function collectArrowEndpoints(
  editor: Editor,
  arrowId: TLShapeId,
): {
  start?: { toId: TLShapeId; normalizedAnchor: { x: number; y: number } };
  end?: { toId: TLShapeId; normalizedAnchor: { x: number; y: number } };
} {
  // tldraw API: editor.getBindingsFromShape(shapeId, bindingType?).
  // Returns bindings WHERE fromId === arrowId.
  const bindings = editor.getBindingsFromShape(arrowId, "arrow") as TLArrowBinding[];
  const result: ReturnType<typeof collectArrowEndpoints> = {};
  for (const b of bindings) {
    const endpoint = {
      toId: b.toId,
      normalizedAnchor: b.props.normalizedAnchor,
    };
    if (b.props.terminal === "start") result.start = endpoint;
    else if (b.props.terminal === "end") result.end = endpoint;
  }
  return result;
}
```

**Backend path (raw store snapshot, без Editor):**

```typescript
function collectArrowEndpointsFromStore(
  store: Record<string, RawRecord>,
  arrowId: string,
) {
  const result = { start: undefined, end: undefined };
  for (const id in store) {
    const r = store[id];
    if (r.typeName !== "binding") continue;
    if (r.type !== "arrow") continue;
    if (r.fromId !== arrowId) continue;
    const endpoint = { toId: r.toId, normalizedAnchor: r.props.normalizedAnchor };
    if (r.props.terminal === "start") result.start = endpoint;
    else if (r.props.terminal === "end") result.end = endpoint;
  }
  return result;
}
```

**normalizedAnchor → Miro `snapTo` mapping:**

```typescript
function anchorToSnapTo(
  anchor: { x: number; y: number },
): "top" | "right" | "bottom" | "left" | "auto" {
  // Quadrant thresholds (revision v0.2): 0.25 / 0.75 (более строго чем 0.2/0.8).
  // Это даёт более чёткое side-detection для anchors близких к углам.
  if (anchor.y < 0.25) return "top";
  if (anchor.y > 0.75) return "bottom";
  if (anchor.x < 0.25) return "left";
  if (anchor.x > 0.75) return "right";
  return "auto";
}
```

**Endpoint resolution в Miro payload:**

```typescript
// Pass B builder, per arrow:
const endpoints = collectArrowEndpoints(editor, arrowId);
// Both endpoints должны иметь binding + target должен быть в Pass A map.
if (!endpoints.start || !endpoints.end) {
  // Free-floating arrow или partial binding.
  skipped.push({ elementId: arrowId, reason: "unsupported-type" });
  return;
}
const startItem = passAMap.get(endpoints.start.toId);
const endItem = passAMap.get(endpoints.end.toId);
if (!startItem || !endItem) {
  // Cross-selection (one end attached to a shape outside selection).
  skipped.push({ elementId: arrowId, reason: "cross-selection-connector" });
  return;
}

const payload: MiroConnectorCreate = {
  startItem: {
    id: startItem,
    snapTo: anchorToSnapTo(endpoints.start.normalizedAnchor),
  },
  endItem: {
    id: endItem,
    snapTo: anchorToSnapTo(endpoints.end.normalizedAnchor),
  },
  shape: mapConnectorShape(arrow.props),
  // captions, style, ...
};
```

**Free-floating arrows** (без обоих bindings, либо arrow с `{ type: "point", x, y }` terminals): пропускаются с warning `reason: "unsupported-type"`. В Miro нет прямого эквивалента неприкреплённого коннектора без endpoint items. Append-only semantic — alternative path "создать orphan connector с absolute position" отвергнут, так как Miro REST v2 connector API требует `startItem.id` + `endItem.id` (не nullable).

**Cross-selection connectors** (arrow указывает на shape вне selection): пропускается с warning `reason: "cross-selection-connector"`. `skippedConnectors: N` включается в result summary.

### 5.6 API quirks (из research)

Критические отличия от ожидаемого поведения Miro REST API v2, выявленные в research:

| Quirk | Описание |
|---|---|
| `style.color` вместо `style.fontColor` | Поле для цвета текста называется `color`, не `fontColor`. Использование `fontColor` вернёт validation error или будет проигнорировано. |
| `borderWidth` минимум 1.0 | `borderWidth: 0` невалиден. Если нужна невидимая граница — использовать `borderStyle: "normal"` + `borderColor: "#ffffff"`. Минимально допустимое значение — `"1.0"` (string). |
| Board ID URL encoding | Board ID содержит символ `=` (base64 padding) → при подстановке в URL path необходимо кодировать: `boardId.replace(/=/g, "%3D")`. В `client.ts` реализуется автоматически. |
| Connector position — string percentage | `startItem.position.x/y` — строки в формате `"50%"`, `"100%"`, не числа. Floating-point недопустим. |
| `borderWidth` — строка, не число | `borderWidth` передаётся как строка `"2.0"`, не как число `2`. Аналогично `fontSize`. |

---

## 6. Three-phase upload protocol

> **Revision v0.2:** в v1 spec говорил про "single Pass A batch с frames first, затем children" — это **не работает**: `parent.id` для frame children резолвится из mapping ответа Pass A, а в одном bulk request mapping ещё **не доступен**. Решение: разбить Pass A на два последовательных bulk POST'а — **A1 (только frames)** и **A2 (всё остальное, frame children с уже известным `parent.id`)**.

Miro API не поддерживает batch создание коннекторов (`POST /v2/boards/{id}/items/bulk` не включает `connector` type). Поэтому upload выполняется в три фазы (две bulk + одна per-item).

```
Pass A1 — frames only
  │
  ├── Filter selection: только frame shapes (+ geo with meta.role === "boundary")
  │
  ├── Split на chunks ≤50 items (если frames > 50, что редко)
  │
  ├── POST /v2/boards/{boardId}/items/bulk
  │   Body: { data: [{ type: "frame", ... }, ...] }
  │
  └── Capture response → Map<elementId, miroFrameId> (frameMap)
      Update room.meta.miroExports[boardId] (partial commit для durability)

Pass A2 — non-frame, non-connector items
  │
  ├── Filter selection: shapes (geo) + sticky_notes + text — без frames, без arrows
  │   Для каждого shape с tldraw parentId === <frame_id>:
  │     - parent.id = frameMap.get(parentId)  ← resolved from A1
  │     - position = frame-relative (см. §5.1 child transform)
  │
  ├── Split на chunks ≤50 items
  │
  ├── POST /v2/boards/{boardId}/items/bulk
  │
  └── Capture response → Map<elementId, miroItemId> (itemMap)
      Merge с frameMap → passAMap (используется в Pass B)
      Update room.meta.miroExports[boardId]

Pass B — connectors
  │
  ├── For each arrow in selection:
  │   ├── Collect bindings (см. §5.5)
  │   ├── Resolve startItem.id, endItem.id from passAMap
  │   ├── Skip if endpoint missing (free-floating / cross-selection)
  │   ├── POST /v2/boards/{boardId}/connectors  (no bulk for connectors)
  │   └── Capture miroConnectorId → tracking
  │
  └── Throttle: max 10 concurrent requests (см. §6.3)
```

**Why two sequential A passes:**
- Один bulk POST не может одновременно создать frame и item с `parent.id = <тот же frame>`: response с `id` приходит только после успеха всего batch'а; payload строится клиентом до запроса.
- Three-phase отделяет creation от dependency resolution: A1 → frameMap → A2 (с parent.id) → passAMap → B (с startItem/endItem.id).
- Stable ordering: даже если Miro обрабатывает items в bulk в любом порядке, A2 не запустится пока A1 не вернёт frameMap.

**Partial commit semantic.** Tracking-table обновляется после **каждой** успешной фазы (A1, A2, B). Если A2 фейлится — items из A1 уже зарегистрированы в `room.meta.miroExports`; при retry user'у показано "0 new items in A1, N existing frames already in Miro" + продолжение с A2. Это foundation для future resumable export (out of scope 0.19.0, но архитектура не блокирует).

### 6.1 Pass A1 — bulk frames

Endpoint: `POST /v2/boards/{boardId}/items/bulk`.

Payload содержит только `MiroFrameItem`:

```typescript
interface MiroFrameItem {
  type: "frame";
  data: {
    title?: string;
    type?: "freeform";
  };
  style?: {
    fillColor?: string;
  };
  position: { x: number; y: number };
  geometry: { width: number; height: number };
}
```

Response Miro возвращает массив items в том же порядке, что и input payload. Mapping:

```typescript
const response = await client.post(`/v2/boards/${boardId}/items/bulk`, payload);
const items = response.data as Array<{ id: string }>;
const frameMap = new Map<string, string>();
payload.data.forEach((req, idx) => {
  frameMap.set(req.shemmaElementId, items[idx].id);
});
```

`shemmaElementId` — внутреннее поле builder'а (НЕ отправляется в Miro; используется в local correlation). Альтернатива — использовать `metadata.shemmaId` из ответа Miro (если field name verified, см. §4.4 / §13).

### 6.2 Pass A2 — bulk non-frame items

После завершения A1 frameMap готов. Pass A2 включает:
- `MiroShapeItem` (geo: rectangle, ellipse, ...) — с `parent.id = frameMap.get(parentId)` если ребёнок frame, иначе без `parent`.
- `MiroStickyNoteItem` — sticky notes.
- `MiroTextItem` — text shapes.

```typescript
interface MiroShapeItem {
  type: "shape";
  data: { content?: string; shape: string };
  style: {
    fillColor?: string;       // 16 preset hex (см. §5.3 fallback)
    borderColor?: string;     // arbitrary hex
    borderStyle?: "normal" | "dotted" | "dashed";
    borderWidth?: string;     // min "1.0"
    color?: string;           // text color, arbitrary hex
    fontSize?: string;        // dp
    textAlign?: "left" | "right" | "center";
  };
  position: { x: number; y: number };   // frame-relative если parent.id, иначе centroid-translated absolute
  geometry: { width: number; height: number };
  parent?: { id: string };              // miro frame id, resolved из A1 frameMap
}

interface MiroStickyNoteItem {
  type: "sticky_note";
  data: { content?: string; shape?: "square" | "rectangle" };
  style: {
    fillColor?: string;       // named enum: gray | light_yellow | ... (см. §5.3)
    textAlign?: "left" | "right" | "center";
  };
  position: { x: number; y: number };
  geometry: { width: number; height: number };
  parent?: { id: string };
}

interface MiroTextItem {
  type: "text";
  data: { content: string };
  style: { color?: string; fontSize?: string };
  position: { x: number; y: number };
  geometry: { width: number };
  parent?: { id: string };
}
```

**Batch size limit:** документально не указан в Miro API; emпирическое значение ≤50 items per request (community practice). Реализация: split на chunks по 50, **последовательные** запросы (не параллельные — Pass A2 chunks внутри себя последовательны, чтобы rate limit credits не выгорал на параллелизме). Probe-script для batch limit определения — cheap testable во время implementation, не блокирует spec (см. §13 OQ#2).

```typescript
const itemMap = new Map<string, string>();
const chunks = chunkBy(payload.data, 50);
for (const chunk of chunks) {
  const response = await client.post(`/v2/boards/${boardId}/items/bulk`, { data: chunk });
  chunk.forEach((req, idx) => {
    itemMap.set(req.shemmaElementId, response.data[idx].id);
  });
  // partial commit tracking after each chunk
  await tracker.commit(boardId, chunk, response.data);
}
const passAMap = new Map([...frameMap, ...itemMap]);
```

### 6.3 Pass B — connectors

```typescript
interface MiroConnectorCreate {
  startItem: {
    id: string;
    snapTo?: "auto" | "top" | "right" | "bottom" | "left";
    position?: { x: string; y: string }; // "50%", "100%"
  };
  endItem: {
    id: string;
    snapTo?: "auto" | "top" | "right" | "bottom" | "left";
  };
  shape?: "straight" | "elbowed" | "curved";
  style?: {
    strokeColor?: string;
    strokeWidth?: string;
    strokeStyle?: "normal" | "dotted" | "dashed";
    startStrokeCap?: string;
    endStrokeCap?: string;
  };
  captions?: Array<{ content: string; position?: string }>;
}
```

Тип коннектора (`shape`) маппится из tldraw arrow props:
- tldraw `elbow` → `"elbowed"`.
- tldraw `curve` → `"curved"`.
- default (прямой) → `"straight"`.

Arrow label (если есть) → `captions[0].content`.

**Throttling Pass B:** max 10 concurrent connector POST'ов (см. §6.4 rate limiting). Не bulk, потому что Miro `/v2/boards/{id}/items/bulk` не поддерживает `connector` type — только per-item endpoint `/v2/boards/{id}/connectors`.

### 6.4 Rate limiting и retry

Rate limit Miro: Level 1 (create operations) — 2000 requests/minute, 50 credits/call. Глобальный лимит — 100,000 credits/min. Для типичного selection (10–50 shapes + 5–10 connectors) лимит не является проблемой. **Throttle Pass B: max 10 concurrent requests** — предосторожность (единое phrasing для §6.3 и §6.4, см. revision v0.2 M5).

При получении HTTP 429:

```
retry_delay = min(initial_delay * 2^attempt, max_delay)
initial_delay = 1000ms
max_delay = 8000ms
max_attempts = 3
```

Sequence: 1s → 2s → 4s. После 3 неудачных попыток — item пропускается, warning в result.

### 6.5 Error handling

| Ошибка | Поведение |
|---|---|
| 429 Too Many Requests | Exponential backoff (1s/2s/4s), 3 попытки, затем skip + warning |
| 4xx validation error | Log item payload + skip item, продолжить batch |
| 401 Unauthorized | Завершить export с error `miro-auth-failed`; предложить проверить token |
| 404 Board not found | Завершить export с error `miro-board-not-found` |
| 5xx Server Error | 1 retry (без backoff), затем fail |
| Pass A1 partial failure | Frames частично созданы в Miro, tracking сохраняет partial frameMap; A2 и B не запускаются; user видит partial count |
| Pass A2 partial failure | A1 frames + part of A2 items уже в Miro и tracked; B не запускается; user видит partial |
| Pass B partial failure | Items в Miro, tracking обновлён; failed connectors в skipped list |
| Network timeout | 30s timeout per request; на timeout — treat как 5xx |

**Partial export** — допустимый исход. User видит toast: «Exported 12/15 items (3 skipped: 2 unsupported types, 1 validation error)».

---

## 7. Auth & config

### 7.1 Token storage

**Schema decision (revision v0.2, resolves §13 OQ#4):** единый файл `~/.config/shemma/config.json` для всех services. Per-service file (`miro-token.json`, `drawio-token.json`, …) отвергнут — один файл проще читать/писать, легче расширять, меньше FS operations.

**Файл:** `~/.config/shemma/config.json`

Директория определяется через XDG Base Directory:
```
configHome = XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
configDir  = path.join(configHome, "shemma")
configFile = path.join(configDir, "config.json")
```

**Схема JSON:**
```json
{
  "miro": {
    "token": "eyJm...",
    "createdAt": "2026-05-19T10:30:00.000Z"
  }
}
```

Будущие services добавляются как top-level keys: `drawio: { token: ... }`, `excalidraw: { ... }` — без breaking changes для существующих readers.

**Права доступа:**
- При создании directory — `mkdir -p` с дефолтным mode (0755 ок, файл сам chmod'ится).
- При создании / write файла — `chmod 600` (только текущий пользователь читает/пишет). Если file уже существует с другими правами — write предупреждает но не fail'ит (best-effort).

**Token caching (revision v0.2, decision locked):** backend читает токен **один раз per `POST /api/export/miro` request** (в начале handler), передаёт в `MiroClient` constructor через DI. **Без in-memory cache** — токен non-expiring, повторное чтение из FS дёшево; смена токена через `shemma config set miro.token <new>` подхватится без рестарта daemon'а. Это устраняет противоречие из v0.1 spec ("on-demand при каждом запросе" vs "lazy cache").

**Test environment caveat (revision v0.2 M1):** в CI / `bun test` envs `~/.config/shemma/` может не существовать. Тесты, требующие config read, должны:
- Override `XDG_CONFIG_HOME` через `process.env` в setup.
- Либо использовать DI `MiroClient({ token: "test-token" })` без файлового чтения.
- Backend `readMiroToken()` возвращает `null` если файл не существует — не throw'ит.

### 7.2 CLI-команды

```bash
# Записать токен
shemma config set miro.token <token>
# Выводит: ✓ miro.token saved to ~/.config/shemma/config.json

# Проверить (не показывать сам токен)
shemma config get miro.token
# Выводит: miro.token = [set] (40 chars)

# Удалить
shemma config unset miro.token
# Выводит: ✓ miro.token removed
```

`shemma config` — новая sub-command в `packages/shemma-cli/src/config.ts`. Для 0.19.0 поддерживает только `miro.token` namespace. Расширяется для будущих `drawio.token`, `excalidraw.*` без breaking changes.

Структура обработчика:
```typescript
// packages/shemma-cli/src/config.ts
export async function cmdConfigSet(key: string, value: string): Promise<void>
export async function cmdConfigGet(key: string): Promise<void>
export async function cmdConfigUnset(key: string): Promise<void>
```

### 7.3 Token validation on set

`shemma config set miro.token <token>` опционально делает тестовый запрос `GET /v2/boards?limit=1` перед записью. Если запрос возвращает 401 — выводить ошибку и не записывать невалидный токен:

```
✗ token validation failed (401 Unauthorized)
  Make sure you copied the full token from Miro developer settings.
```

Если validation request недоступен (сеть offline) — записать токен с предупреждением `(network check skipped)`.

### 7.4 Missing token — UX

Если при export токен отсутствует:
- Backend: `HTTP 412 Precondition Failed`
  ```json
  {
    "error": "miro-token-missing",
    "hint": "Run: shemma config set miro.token <token>\nGet token: https://developers.miro.com/docs/rest-api-build-your-first-hello-world-app"
  }
  ```
- Frontend modal: inline error-banner с текстом команды + копируемый блок.
- MCP tool: error response с тем же hint.

### 7.5 New CLI sub-command structure

> **Revision v0.2:** Архитектура `shemma config` — extension scope. `packages/shemma-cli/src/index.ts` сейчас не имеет config sub-command (cross-check confirmed). Pattern добавления — следовать existing structure (`cmdDoctor`, `cmdMcpStart`, `cmdRoom` и т.п.): inline switch в `index.ts` → delegate в отдельный module.

**Choice: delegate.** Reasons:
- Index.ts уже разросся; новый module `config.ts` локализует логику.
- Тестирование изолировано: можно `import { cmdConfigSet } from "./config"` в unit-тесте без shell parsing.
- Consistent с `doctor.ts` / `mcp.ts` shape.

**Parser pattern (index.ts):**

```typescript
if (cmd === "config") {
  const sub = argv[1];                // "set" | "get" | "unset"
  const key = argv[2];                // "miro.token"
  const value = argv[3];              // только для set
  const { cmdConfigSet, cmdConfigGet, cmdConfigUnset } = await import("./config");
  if (sub === "set") {
    if (!key || value === undefined) {
      die("usage: shemma config set <key> <value>");
    }
    return cmdConfigSet(key, value);
  }
  if (sub === "get") {
    if (!key) die("usage: shemma config get <key>");
    return cmdConfigGet(key);
  }
  if (sub === "unset") {
    if (!key) die("usage: shemma config unset <key>");
    return cmdConfigUnset(key);
  }
  die(`unknown config subcommand: ${sub}; expected set | get | unset`);
}
```

**Output style (consistent с `cmdDoctor` / `cmdRoom`):**
- Через `initOutput` + `getOutput()` UI helper (см. `packages/shemma-cli/src/ui.ts`).
- Success: `ui.success("miro.token saved")` → green checkmark или JSON `{ "ok": true, "message": "..." }`.
- Error: `ui.error("miro.token validation failed (401)")` → red prefix или JSON `{ "ok": false, "error": "..." }`.
- Info: `ui.info("miro.token = [set] (40 chars)")`.

**`--json` global flag support:** уже parsed в `initOutput()` (см. index.ts:50–53). `cmdConfigSet/Get/Unset` используют `getOutput()` → автоматически переключаются между friendly text и JSON.

**Help text snippet (для `shemma --help`):**
```
  config set <key> <value>      # store credential / setting in ~/.config/shemma/config.json
  config get <key>              # read setting (тoken values masked: "[set] (N chars)")
  config unset <key>            # remove setting
                                  Supported keys (0.19.0): miro.token
```

**Schema decision (resolves §13 OQ#4):** **единый файл** `~/.config/shemma/config.json` (см. §7.1). Per-service отдельный файл (`miro-token.json`) **отвергнут**: единый файл проще для extensibility, меньше FS operations, parsing один раз.

### 7.6 Backend config file I/O

**Cross-check (revision v0.2):** `apps/backend/src/config.ts` сейчас **env-var only** (verified). Нет file I/O. Добавляем capability — additive, не ломает existing config consumers (`getProfile`, `getConfig`, и т.д. остаются env-var driven).

**Новые exports в `apps/backend/src/config.ts`:**

```typescript
// XDG-aware config file path resolver.
export function configFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
  return path.join(configHome, "shemma", "config.json");
}

// File schema (full union, для type-safety).
export interface ConfigFile {
  miro?: {
    token?: string;
    createdAt?: string;
  };
  // Future: drawio, excalidraw, ...
}

// Read full config; null если файл не существует.
// Throws при permission denied (с hint в message) или invalid JSON.
export function readConfig(): ConfigFile | null {
  const p = configFilePath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as ConfigFile;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    if (err.code === "EACCES") {
      throw new Error(
        `Cannot read ${p}: permission denied. Try: chmod 600 ${p}`,
      );
    }
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${p}: ${e.message}`);
    }
    throw e;
  }
}

// Write full config; creates dir if needed, chmod 600 on create.
export function writeConfig(cfg: ConfigFile): void {
  const p = configFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// Convenience wrappers — used by Miro export handler.
export function readMiroToken(): string | null {
  const cfg = readConfig();
  return cfg?.miro?.token ?? null;
}

export function writeMiroToken(token: string): void {
  const cfg = readConfig() ?? {};
  cfg.miro = { ...cfg.miro, token, createdAt: new Date().toISOString() };
  writeConfig(cfg);
}

export function unsetMiroToken(): void {
  const cfg = readConfig();
  if (!cfg?.miro?.token) return;
  delete cfg.miro.token;
  // Если miro stays пустой — оставляем `{ "miro": {} }`, чтобы не терять createdAt etc.
  writeConfig(cfg);
}
```

**Error semantics:**
- `ENOENT` (file missing) → `readConfig` returns `null`, не throw. `readMiroToken` → `null`.
- `EACCES` (permission denied) → throw `Error` с hint, чтобы handler мог surface user-readable message.
- Invalid JSON → throw `Error` с file path и parse error.
- `writeConfig` ошибки `mkdir`/`writeFileSync` пропускаются вверх — caller (handler) wrap'ит в HTTP error.

**CLI consumes backend exports:** `packages/shemma-cli/src/config.ts` импортирует `readConfig`/`writeConfig` через `@shemma/backend-config` либо relative path (после внедрения — выбор в plan'е). Alternative: дублировать file I/O в CLI module — отвергнуто (single source of truth для config schema).

---

## 8. UI design

### 8.1 Triggers

**Hotkey `⌘⇧E`** (Ctrl+Shift+E на Windows/Linux). Паттерн аналогичен `⌘⇧L` (Tidy, DRW-088):

```typescript
// apps/frontend/src/App.tsx
// Вариация на паттерн makeTidyHotkeyHandler из canvas/tidy-layout.ts
useEffect(() => {
  const handler = makeExportHotkeyHandler(
    () => (editor ? editor.getSelectedShapeIds() as unknown as string[] : []),
    async (ids) => {
      if (ids.length === 0) {
        // toast: "Select shapes to export"
        return;
      }
      setExportModalOpen(true);
    },
  );
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, [editor]);
```

При пустой selection — toast «Select shapes first to export».

**Context menu item «Export to → Miro»:**

Паттерн аналогичен Tidy context menu (DRW-088) в `chrome/TldrawComponents.tsx`. Добавляется в `TidyContextMenu` (или в отдельный `ExportContextMenu`) при `selectedCount >= 1`:

```tsx
<div className="tlui-menu__group">
  <button
    type="button"
    className="tlui-button tlui-button__menu"
    onClick={() => {
      const ids = editor.getSelectedShapeIds() as unknown as string[];
      onExportSelection!(ids);
    }}
  >
    <span className="tlui-button__label">Export to Miro</span>
    <kbd className="tlui-kbd">⌘⇧E</kbd>
  </button>
</div>
```

Минимальный порог selection: 1 shape (в отличие от Tidy где требуется 2+). Можно экспортировать и один shape.

### 8.2 Export modal — ExportMiroModal

Компонент `apps/frontend/src/canvas/export-miro-modal.tsx`. Три состояния:

**Шаг 1: Board picker**

```
┌─ Export to Miro ──────────────────────────────────────────┐
│                                                            │
│  [ Search boards...                          🔍 ]          │
│                                                            │
│  ● My Project Architecture    (last used)    [↗ Open]     │
│  ○ Team Design Review                         [↗ Open]    │
│  ○ Q2 Planning                                [↗ Open]    │
│                                                            │
│  Loading boards...  (spinner при fetch)                    │
│                                                            │
│  [ Cancel ]                         [ Next → ]            │
└────────────────────────────────────────────────────────────┘
```

- Список board'ов загружается через `GET /api/export/miro/boards` при mount.
- Last-used board отмечается и выбрана по умолчанию.
- Каждая board имеет «↗ Open» ссылку на `https://miro.com/app/board/<id>/`.
- Search: client-side фильтрация по имени.
- Если токен отсутствует — inline error-banner с командой `shemma config set miro.token`.

**Шаг 2: Confirm**

```
┌─ Export to Miro ──────────────────────────────────────────┐
│                                                            │
│  Exporting to: My Project Architecture                     │
│                                                            │
│  12 shapes (3 frames, 5 rectangles, 4 notes)              │
│   8 connectors                                             │
│   2 unsupported (draw strokes) — will be skipped          │
│                                                            │
│  [ ← Back ]                          [ Export ]           │
└────────────────────────────────────────────────────────────┘
```

- Preview считается на frontend по selection (без server round-trip).
- Предупреждение о skipped types — до export, не после.

**Шаг 3: Progress / Result**

```
┌─ Export to Miro ──────────────────────────────────────────┐
│                                                            │
│  Exporting... [████████░░░░] 8/12                         │
│  (или после завершения)                                    │
│  ✓ Exported 12 items + 8 connectors                       │
│    Open in Miro →                                          │
│                                                            │
│  (или при ошибке)                                          │
│  ✗ Export failed: miro-auth-failed                        │
│    Run: shemma config set miro.token <token>              │
│                                                            │
│  [ Close ]                                                 │
└────────────────────────────────────────────────────────────┘
```

Прогресс: backend возвращает итоговый count синхронно (нет streaming в 0.19.0). Modal показывает spinner → результат. При больших selection (>100 shapes) request может занять несколько секунд.

**Cancellation:** кнопка Cancel во время spinner — frontend делает `AbortController.abort()` на fetch. Backend ловит abort signal через request lifecycle — items уже созданные в Miro остаются (best-effort cleanup невозможен без rollback API).

### 8.3 Service-layer pattern

Согласно CLAUDE.md §3.8 UI design (tldraw остаётся primary UI, shemma добавляет service-layer):

- `ExportMiroModal` рендерится через `components` slot в tldraw. Конкретно: добавляется как элемент в `OverlayUi` компонент (аналог `PromptInput`, `PromptDrawer`, `MermaidImportModal` в текущем `App.tsx`).
- Никаких `position: fixed` overlay'ев вне tldraw component tree.
- Modal state (`exportModalOpen: boolean`) управляется через `useState` в `App.tsx` по аналогии с `mermaidOpen`.

---

## 9. MCP tool API

**Файл:** `packages/shemma-mcp/src/tools/export-miro.ts`

**Tool name:** `shemma_export_miro`

### 9.1 Input schema

```typescript
// packages/shemma-mcp/src/schemas.ts (добавить)
export const ExportMiroArgs = {
  boardId: z
    .string()
    .optional()
    .describe(
      "Miro board id. If omitted — uses last-used board from tracking. " +
      "If no tracking — returns error asking to specify boardId.",
    ),
  scope: z
    .enum(["selection", "room"])
    .default("selection")
    .describe(
      "'selection' (default) — export current selection in active room. " +
      "'room' — export all non-deleted shapes in the room.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "If true — returns preview JSON (item counts + sample payload) without " +
      "making Miro API calls.",
    ),
  room: z.string().optional().describe("Room id (resolved if omitted)."),
};
```

### 9.2 Output schema

**Success:**
```typescript
interface ExportMiroSuccess {
  ok: true;
  exportedAt: string;      // ISO timestamp
  boardId: string;
  boardName: string;
  boardUrl: string;        // https://miro.com/app/board/<id>/
  itemsCreated: number;    // shapes + frames + sticky notes + text
  connectorsCreated: number;
  skipped: Array<{
    elementId: string;
    reason: "unsupported-type" | "cross-selection-connector" | "validation-error";
  }>;
}
```

**Error:**
```typescript
interface ExportMiroError {
  ok: false;
  error: string;           // error code: "miro-token-missing", "miro-board-not-found", ...
  hint?: string;           // человекочитаемая инструкция
}
```

**Dry run:**
```typescript
interface ExportMiroDryRun {
  ok: true;
  dryRun: true;
  itemCount: number;
  connectorCount: number;
  skippedCount: number;
  samplePayload: unknown;  // первые 3 items для preview
}
```

### 9.3 Room resolution guarantee

Tool использует `deps.resolver.resolve({ argRoom: input.room })` — тот же паттерн, что в `domain.ts`. Если комната не открыта — resolver гарантирует auto-open (через `autoOpen` manager). Семантика аналогична `shemma_open`.

---

## 10. Tracking schema

### 10.0 Envelope schema extension

> **Revision v0.2:** v1 spec ссылался на `room.meta.miroExports` так, как будто `RoomState.meta` уже существует. Cross-check показал, что **ни `RoomState` (apps/backend/src/types.ts), ни `EnvelopeV3` (apps/backend/src/envelope.ts) не имеют поля `meta`** — это новое extension'ое поле, которое нужно добавить.

**Изменения в `apps/backend/src/types.ts`:**

```typescript
// Новый type — общий контейнер для room-level metadata.
export interface RoomMeta {
  miroExports?: MiroExportsMap;
  // Future: drawioExports, excalidrawExports, ...
}

export type MiroExportsMap = Record<
  string,                       // boardId (Miro board id)
  {
    boardName?: string;         // кэш для UI без round-trip к Miro
    lastExportedAt: string;     // ISO timestamp последнего export в эту board
    items: Record<string, string>; // elementId → miroItemId
    connectors?: Record<string, string>; // arrowId → miroConnectorId
  }
>;

// Extend RoomState:
export type RoomState = {
  store: TLStoreSnapshot;
  opLog: StoreOpLogEntry[];
  prompts: Prompt[];
  version: number;
  dirty: boolean;
  lastTouched: number;
  aiActivity?: AiActivity;
  didrawIndex: Map<string, string>;
  linkedSession?: string;
  projectDir?: string;
  meta?: RoomMeta;              // ← NEW (revision v0.2): export tracking, future use
};
```

**Изменения в `apps/backend/src/envelope.ts`:**

```typescript
export type EnvelopeV3 = EnvelopeHeader & {
  schemaVersion: 3;
  shemma: { shemmaVersion: string; createdAt: string };
  store: TLStoreSnapshot;
  prompts: Prompt[];
  opLog: StoreOpLogEntry[];
  linkedSession?: string;
  projectDir?: string;
  meta?: RoomMeta;              // ← NEW
};
```

`buildV3` plumbing:

```typescript
function buildV3(roomId: string, s: RoomState): EnvelopeV3 {
  const env: EnvelopeV3 = {
    schemaVersion: 3,
    roomId,
    version: s.version,
    lastTouched: new Date(s.lastTouched).toISOString(),
    elementCount: countShapes(s.store.store),
    shemma: { shemmaVersion: SHEMMA_VERSION, createdAt: new Date().toISOString() },
    store: s.store,
    prompts: s.prompts,
    opLog: s.opLog.slice(-config.opLogMaxSize),
  };
  if (s.linkedSession !== undefined) env.linkedSession = s.linkedSession;
  if (s.projectDir !== undefined) env.projectDir = s.projectDir;
  if (s.meta !== undefined) env.meta = s.meta;   // ← NEW
  return env;
}
```

`parseFull` plumbing:

```typescript
// в parseFull(), после plumbing linkedSession/projectDir:
if (j.meta !== undefined && typeof j.meta === "object" && j.meta !== null) {
  parsed.meta = j.meta as RoomMeta;
}
```

**Migration story.** Старые envelope-файлы (saved до 0.19.0) **не имеют** `meta` field. `parseFull` обрабатывает это естественно через `if (j.meta !== undefined)` — `parsed.meta` остаётся `undefined`. При первом export в Miro handler инициализирует `RoomState.meta = {}` и записывает `miroExports`; следующий `serialize` сохранит уже с `meta`.

Никаких active migrations не требуется — old envelope.json files читаются без preprocessing, get/set операции дополняют meta по мере появления exports.

**`ENVELOPE_SCHEMA_VERSION` bump decision: НЕ нужен.** Causes:
- Изменение **additive optional**: новое поле `meta?`, старые consumers (frontend, tests) игнорируют unknown fields через `parseFull` shape.
- `SUPPORTED_SCHEMA_VERSIONS = [2, 3]` остаётся неизменным. Schema v3 расширяется, не реплейсится.
- Если в будущем `meta` станет required или конфликтует с другим extension — тогда bump до 4 с migration; не сейчас.

Document this в comment-блоке `envelope.ts`:
```typescript
// Schema v3 extension policy (since 0.19.0):
// - Additive optional fields (`meta?: RoomMeta`) — НЕ бампят SCHEMA_VERSION.
// - Required fields / shape changes к existing fields — bump до v4 + migrate-v3.ts.
```

### 10.1 Room metadata

См. §10.0 для full schema. Recap:

```typescript
// apps/backend/src/types.ts
export interface RoomMeta {
  miroExports?: MiroExportsMap;
}

export type MiroExportsMap = Record<
  string,                       // boardId
  {
    boardName?: string;
    lastExportedAt: string;
    items: Record<string, string>;       // elementId → miroItemId
    connectors?: Record<string, string>; // arrowId → miroConnectorId
  }
>;
```

**Где хранится:** в `RoomState.meta` (in-memory) → `EnvelopeV3.meta` (persisted). Daemon serialize/parseFull plumbing — см. §10.0.

**Визуализация:** не отображается в UI (debug panel — future improvement). Данные читаются только при update path (out of scope 0.19.0) или в `dryRun` response MCP tool.

### 10.2 Miro item metadata

Каждый Miro item создаётся с custom-полем, привязывающим Miro item к shemma element:

```json
{
  "metadata": {
    "shemmaId": "shape:e_backend",
    "shemmaRoom": "default",
    "exportedAt": "2026-05-19T14:30:00.000Z",
    "shemmaVersion": "0.19.0"
  }
}
```

`shemmaVersion` value читается из `VERSION.version` (см. `apps/backend/src/version.ts`), не hardcode. Это даёт history-traceability — при analysis Miro board можно отделить items от разных версий shemma.

> **Critical (revision v0.2, blocks idempotency story):** field name `metadata` **not verified** в research report. Возможные альтернативы:
> - `metadata` — общий custom-fields контейнер (если поддерживается на v2).
> - `appData` — per-app scratchpad с quota constraints (~32KB per app per item, **доступно только для items созданных тем же приложением** что и Bearer token).
>
> **Implementation phase task #1: probe Miro API** до начала builder.ts implementation:
> 1. POST a sample shape с `metadata: { shemmaId: "test" }` — check response.
> 2. POST с `appData: '{"shemmaId":"test"}'` (note: appData — string, не object).
> 3. GET the created item — verify which field round-trips.
> 4. Update §10.2 + builder.ts payload accordingly.
>
> Если **только `appData` доступен**: payload должен быть `appData: JSON.stringify({ shemmaId, shemmaRoom, exportedAt, shemmaVersion })` (string format). Document `appData` quota constraints (~32KB per item — наша structure ~150 байт, comfortable margin).
>
> **Until verified, payload format отмечен в `builder.ts` как TODO.**

### 10.3 Persistence semantics

- Tracking записывается **best-effort после успешного export**. Если Pass A завершился, но save room state упал — tracking потерян, items в Miro существуют. Это known edge case; документируется.
- При повторном export тех же elementId в ту же board — tracking перезаписывается новыми miroItemId (старые items остаются в Miro, но tracking теряет на них ссылку).
- При export в другую board — новый boardId ключ в map, старые записи сохраняются.

---

## 11. Tests

### 11.1 Backend integration tests

Файл: `apps/backend/src/export/miro/upload.test.ts`

Mock Miro API через `Bun.serve` на отдельном тестовом порту. Fixture сервер перехватывает POST-запросы и возвращает заранее определённые ответы.

Test cases:

```typescript
describe("miro upload — happy path", () => {
  it("exports 5 shapes + 3 connectors: verifies payload structure", async () => {
    // Given: 5 tldraw geo shapes + 3 arrows in selection
    // When: upload() called with mock boardId
    // Then: Pass A2 sends 1 bulk POST with 5 items (no frames → A1 skipped)
    //       Pass B sends 3 connector POSTs
    //       Each item has correct position (centroid-translated)
    //       Each item has metadata.shemmaId (or appData, см. §10.2 verification)
  });

  it("coordinate translation: centroid → (0,0) on Miro board", async () => {
    // Given: 2 shapes at tldraw page-space (100,100,w50,h50) and (200,200,w50,h50)
    // centroid = (175, 175)
    // Expected Miro positions:
    //   shape1: x = (100+25) - 175 = -50, y = (100+25) - 175 = -50
    //   shape2: x = (200+25) - 175 = 50, y = (200+25) - 175 = 50
  });

  it("page-space resolution: frame child stored parent-relative → resolved before bbox", async () => {
    // Given: frame at page (100, 100) w200 h200; child shape with parentId=frame, x=10, y=10
    // Then: resolved pageX = 110, pageY = 110 (not 10/10)
    //       bbox + centroid computed in page-space
    //       child Miro payload: position is frame-relative (после parent.id resolution)
  });

  it("Pass A split: A1 only frames, A2 only non-frame items", async () => {
    // Given: 1 frame + 2 children + 1 standalone shape
    // Then:
    //   A1 POST body: [{type: "frame", ...}]
    //   A1 response → frameMap
    //   A2 POST body: [{type: "shape", parent: {id: <miro_frame_id>}}, ..., {type: "shape", /* standalone, no parent */}]
    //   A2 response → itemMap, merged into passAMap
  });

  it("frame with children: A1 → A2 → children have parent.id from A1 mapping", async () => {
    // Given: tldraw frame + 2 children shapes
    // Then: Two sequential bulk POSTs:
    //   POST #1 (A1): payload contains only frame, response → frameMap
    //   POST #2 (A2): children have parent.id = frameMap.get(frame.id)
    //   Positions for children: frame-relative (computed from child page-space - frame page-space - centroid)
  });

  it("boundary shape (meta.role === 'boundary'): maps to Miro frame, goes in A1", async () => {});

  it("connector resolution: arrow binding → Pass A2 item id → Pass B startItem.id", async () => {
    // Given: arrow from shape_A to shape_B (both standalone, не дети frame)
    // When: A1 noop (no frames), A2 creates shape_A (miro_id_A) и shape_B (miro_id_B)
    // Then: Pass B connector has startItem.id = miro_id_A, endItem.id = miro_id_B
  });

  it("connector to frame child: arrow target in A2 (после A1 commit)", async () => {
    // Given: arrow from standalone_shape to frame_child_shape
    // Then: passAMap.get(frame_child.id) === miro_id (from A2 response)
    //       connector created с правильным endItem.id
  });

  it("cross-selection connector (endpoint outside selection): skipped with warning", async () => {
    // Given: arrow from shape_A (in selection) to shape_C (not in selection)
    // Then: connector skipped, result.skipped contains the connector elementId
    //       reason: "cross-selection-connector"
  });

  it("free-floating arrow (no bindings): skipped with warning", async () => {
    // Given: arrow с props.start = {type: "point", x, y}, props.end = {type: "point", x, y}
    //   (no binding records в store with fromId === arrow.id)
    // Then: skipped, reason: "unsupported-type"
  });

  it("group selection expansion: group dropped, children exported", async () => {
    // Given: selection = [groupId]; group contains 3 shapes
    // Then: A2 payload contains 3 shapes (no group entry)
    //       result.itemsCreated === 3 (не 4)
  });
});

describe("miro upload — partial commit (Pass A1 → A2 split)", () => {
  it("A1 succeeds, A2 fails: tracking has frames; result.partial = true", async () => {
    // Mock: A1 returns 201, A2 returns 500.
    // Then: room.meta.miroExports[boardId].items contains only frames
    //       result.error indicates A2 failure
    //       Pass B not executed
  });

  it("A1 + A2 succeed, B partially fails: connectors partial", async () => {
    // Mock: A1, A2 OK. Pass B: 2 connectors OK, 1 fails (4xx validation).
    // Then: tracking.connectors has 2 entries
    //       result.skipped includes failed connector elementId
  });
});

describe("miro upload — auth", () => {
  it("missing token → 412 with miro-token-missing error", async () => {});
  it("invalid token (401 from Miro) → error miro-auth-failed", async () => {});
});

describe("miro upload — rate limiting", () => {
  it("429 → retries with backoff, succeeds on 3rd attempt", async () => {
    // Mock: first 2 responses = 429, 3rd = 201
    // Then: item created successfully, no error in result
  });
  it("429 × 3 → item skipped, warning in result", async () => {});
});

describe("miro upload — frame nesting limitation", () => {
  it("frame inside frame: outer → Miro frame, inner → shape without parent", async () => {});
});
```

### 11.2 Unit tests

**`color-mapping.test.ts` (revision v0.2 — расширено):**
```typescript
describe("nearestShapeColor — happy path", () => {
  it("pure white #ffffff → white preset", () => {});
  it("pure black #000000 → black preset", () => {});
  it("near-red #ff2200 → nearest red preset", () => {});
  it("near-blue #4488ff → nearest blue preset", () => {});
});

describe("nearestShapeColor — edge cases", () => {
  // Tie-breaking
  it("equidistant colors → first match wins (deterministic order)", () => {
    // если два preset'а на одинаковом RGB-distance — возвращается тот, который
    // первый в SHAPE_PRESETS array. Это гарантирует deterministic output.
  });

  // Case insensitivity
  it("#FF0000 (upper) === #ff0000 (lower) → same preset", () => {});
  it("#FfAaCc mixed case → normalized internally", () => {});

  // Shorthand
  it("3-char shorthand #f00 → expand to #ff0000", () => {});
  it("3-char #abc → #aabbcc", () => {});

  // Malformed input
  it("null → throw or return default preset (decide: throw)", () => {});
  it("empty string '' → throw", () => {});
  it("missing # ('ff0000') → throw OR accept? (decide: accept, normalize)", () => {});
  it("non-hex chars ('#zzgghh') → throw", () => {});
  it("wrong length ('#ffff') → throw", () => {});

  // Property: return always in preset set
  it("property: для 1000 random hex inputs return ∈ SHAPE_PRESETS", () => {
    // используется property-based pattern (bun:test + fast-check-like
    // manual loop OR `bun:test` with `it.prop` если доступно).
  });
});

describe("nearestStickyColor — happy path", () => {
  it("yellow-ish #ffe066 → 'yellow' or 'light_yellow'", () => {});
  it("dark green #1a7a3a → 'dark_green'", () => {});
});

describe("nearestStickyColor — edge cases", () => {
  it("equidistant named colors → first match wins", () => {});
  it("case insensitive", () => {});
  it("3-char shorthand", () => {});
  it("malformed → throw", () => {});
  it("property: return always ∈ STICKY_NAMED_COLORS (16 values)", () => {});
});
```

**`rich-text-to-plain.test.ts`:**
```typescript
describe("richTextToPlain", () => {
  it("simple paragraph: {type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Hello'}]}]} → 'Hello'", () => {});
  it("multi-paragraph: preserves newlines", () => {});
  it("empty doc: → ''", () => {});
  it("null/undefined: → ''", () => {});
  it("heading + paragraph: joined with newline", () => {});
});
```

**`builder.test.ts`:**
```typescript
describe("buildShapePayload", () => {
  it("tldraw geo rectangle → MiroShapeItem with shape='rectangle'", () => {});
  it("tldraw note → MiroStickyNoteItem with named fillColor", () => {});
  it("tldraw frame → MiroFrameItem with title", () => {});
  it("text shape → MiroTextItem with plain text content", () => {});
});
```

**`tracking.test.ts`:**
```typescript
describe("MiroTracker", () => {
  it("write: stores elementId → miroItemId per boardId", () => {});
  it("read: retrieves miroItemId for known elementId + boardId", () => {});
  it("returns undefined for unknown elementId", () => {});
  it("getLastUsedBoardId: returns boardId from most recent export", () => {});
});
```

**`anchor-side.test.ts`:**
```typescript
describe("anchorToSnapTo (revision v0.2 thresholds 0.25/0.75)", () => {
  it("normalizedY = 0.1 → 'top'", () => {});
  it("normalizedY = 0.9 → 'bottom'", () => {});
  it("normalizedX = 0.1 → 'left'", () => {});
  it("normalizedX = 0.9 → 'right'", () => {});
  it("center (0.5, 0.5) → 'auto'", () => {});
  it("normalizedY = 0.25 boundary → 'auto' (not 'top')", () => {});
  it("normalizedY = 0.75 boundary → 'auto' (not 'bottom')", () => {});
});
```

**`token-validation.test.ts` (revision v0.2 M6 — moved from §11.3 manual E2E):**
```typescript
describe("cmdConfigSet — miro.token validation", () => {
  it("valid token (mock GET /v2/boards returns 200): writes file", async () => {
    // Mock Miro API на тестовом порту, override baseUrl env-var.
    // Run cmdConfigSet("miro.token", "valid_token").
    // Then: readMiroToken() returns "valid_token", file mode === 0o600.
  });

  it("invalid token (mock returns 401): does not write file, prints error", async () => {
    // Run cmdConfigSet("miro.token", "bad_token").
    // Then: readMiroToken() returns null, exit code != 0.
    //       Stderr contains "validation failed (401)".
  });

  it("network offline (mock errors connection): writes with (network check skipped) warning", async () => {});

  it("--json mode: outputs structured JSON instead of friendly text", async () => {
    // Run with --json flag.
    // Then: stdout parses как JSON {ok: true, message: ...} or {ok: false, error: ...}.
  });
});

describe("readConfig / writeConfig / readMiroToken", () => {
  it("readConfig: ENOENT → returns null (does not throw)", () => {});
  it("readConfig: invalid JSON → throws Error with file path", () => {});
  it("readConfig: EACCES → throws Error with chmod hint", () => {});
  it("writeConfig: creates ~/.config/shemma/ if missing", () => {});
  it("writeConfig: chmod 600 on file create", () => {});
  it("readMiroToken: file missing → null", () => {});
  it("writeMiroToken: merges с existing config (preserves other services keys)", () => {});
  it("unsetMiroToken: removes token, keeps other keys", () => {});
});
```

### 11.3 Manual E2E checklist

Для acceptance verify после implementation:

1. Создать тестовую Miro board «shemma export test».
2. В shemma создать selection: 3 geo shapes (rectangle, ellipse, diamond) + 2 sticky notes + 2 arrows между shapes + 1 frame с 2 дочерними shapes.
3. Нажать `⌘⇧E`, выбрать тестовую board, нажать Export.
4. Открыть Miro board, визуально проверить:
   - [ ] 3 geo shapes с корректными формами и цветами (ближайшие presets).
   - [ ] 2 sticky notes с корректными named colors.
   - [ ] 2 connectors между правильными shapes, прикреплены с корректной стороны.
   - [ ] Frame с заголовком; 2 дочерних shapes внутри frame в Miro UI.
   - [ ] Текстовые метки корректны.
5. Повторить export той же selection → проверить, что создались новые items (append-only), tracking обновился.
6. Проверить `shemma config get miro.token` → `[set] (N chars)`.
7. Проверить `shemma_export_miro({ dryRun: true })` через MCP → preview без создания items в Miro.

> **Note (revision v0.2 M6):** token validation против Miro API перенесён из E2E в §11.2 unit (с mock Miro server). Не дублируется здесь.

---

## 12. Out of scope

| Item | Status |
|---|---|
| draw.io export | Отдельная задача (другой API) |
| Excalidraw export | Отдельная задача |
| Bi-directional sync (Miro → shemma) | Отдельная phase candidate |
| OAuth 2.0 full flow | Non-goal; developer non-expiring token достаточен |
| Update existing Miro items (PATCH) | Future — основа через tracking table заложена |
| Multi-board templated export | Слишком широко для 0.19.0 |
| Frame deep nesting (>1 уровня) | Miro ограничение; documented known limitation |
| Full richText fidelity (bold, links, code) | MVP plain text; rich conversion — follow-up |
| Streaming progress (SSE) | Sync response достаточен; SSE — follow-up если понадобится |
| Export из gallery view | Selection primary; галерея — не scope |
| Export `draw`, `line`, `image`, `video`, `highlight` shapes | Нет Miro equivalent для structured export; skip with warning |
| Undo export (rollback items в Miro) | Нет Miro delete-all-by-tag API; технически сложно и вне scope |

---

## 13. Open questions

По завершению research (2026-05-19) и revision pass (2026-05-20) большинство вопросов закрыты. Оставшиеся нюансы для implementation:

**Critical (blocks implementation):**

1. **Точные hex-значения 16 Miro shape presets** — `style.fillColor` принимает только enum hex values. Без них `color-mapping.ts` имплементировать нельзя. **Blocks `color-mapping.ts` implementation.** Probe paths (см. §5.3):
   - `POST /v2/boards/<test>/shapes` с произвольным fillColor → 4xx error со списком допустимых.
   - `GET /v2/boards/<id>/shapes` после ручного создания shapes разных цветов.
   - Miro OpenAPI spec.
   - **Fallback path** (graceful degradation): ship borderColor-only mapping в 0.19.0, defer fillColor preset в 0.19.1.

2. **Miro item `metadata` vs `appData` field name verification** — research report не подтверждает имя поля. От field-name зависит whole idempotency story (§4.4, §10.2). **Blocks `builder.ts` payload format.** Probe (см. §10.2):
   - POST с `metadata: { shemmaId: "test" }` → check response shape.
   - POST с `appData: '{"shemmaId":"test"}'` (note: appData — string).
   - GET item → verify which round-trips.
   - Если только `appData` доступен — document quota constraints (~32KB per app per item).

**Non-blocking (можно verify во время implementation):**

3. **Batch size limit для `/v2/boards/{id}/items/bulk`** — документально не указан; выбрано 50 (community practice). Probe-script (POST batch с 60+ items, check response 413/422) **cheaply testable во время implementation, не блокирует spec**. Если лимит окажется ниже 50 — уменьшить chunk size в `upload.ts`.

**Resolved (in this revision):**

4. **`shemma config` sub-command architecture** — **RESOLVED** в §7.5: delegate в новый `packages/shemma-cli/src/config.ts`; единый файл `~/.config/shemma/config.json` (не per-service); `--json` mode supported; error style consistent с `cmdDoctor`.

5. **Frame children coordinate space (tldraw 5.x)** — **RESOLVED** в §5.1: tldraw 5.x frame children parent-relative; page-space resolution через `editor.getShapePageBounds()` (frontend) или manual walker (backend). ADR-0002 reference удалён (это про domain Group, не tldraw frame).

6. **Pass A single-batch parent.id resolution** — **RESOLVED** в §6: split на Pass A1 (frames) → frameMap → Pass A2 (non-frames с parent.id).

---

## 14. Files touched (high-level)

> **Revision v0.2:** добавлен `apps/backend/src/envelope.ts` (EDIT для `meta?: RoomMeta` plumbing); MCP registration перенесена с EDIT `tools/domain.ts` на NEW `tools/export-miro.ts` + EDIT `server.ts` (one-file-per-tool pattern, см. existing `tools/open.ts`, `tools/instructions.ts`).

| Path | Назначение | Статус |
|---|---|---|
| `apps/backend/src/export/miro/client.ts` | Miro REST v2 HTTP wrapper (auth header, URL encoding, retry) | NEW |
| `apps/backend/src/export/miro/builder.ts` | tldraw shape → Miro payload mapping (per shape type) | NEW |
| `apps/backend/src/export/miro/color-mapping.ts` | nearest-color алгоритм для shapes + sticky notes | NEW |
| `apps/backend/src/export/miro/upload.ts` | three-phase orchestrator (Pass A1 frames + A2 non-frames + Pass B connectors) | NEW |
| `apps/backend/src/export/miro/tracking.ts` | room.meta.miroExports CRUD + lastUsedBoardId resolution | NEW |
| `apps/backend/src/export/miro/rich-text.ts` | richTextToPlain (ProseMirror → string) | NEW |
| `apps/backend/src/export/miro/coords.ts` | page-space resolution (resolvePageBounds walker для backend path) | NEW |
| `apps/backend/src/routes/export.ts` | `POST /api/export/miro` + `GET /api/export/miro/boards` | NEW |
| `apps/backend/src/config.ts` | дополнить: `configFilePath`, `readConfig`, `writeConfig`, `readMiroToken`, `writeMiroToken`, `unsetMiroToken` | EDIT |
| `apps/backend/src/types.ts` | `RoomMeta`, `MiroExportsMap` types; `RoomState.meta?: RoomMeta` | EDIT |
| `apps/backend/src/envelope.ts` | `EnvelopeV3.meta?: RoomMeta`; plumbing в `buildV3` + `parseFull`; comment про additive schema policy | EDIT |
| `packages/shemma-cli/src/config.ts` | `cmdConfigSet/Get/Unset` (delegate из index.ts) | NEW |
| `packages/shemma-cli/src/index.ts` | switch `cmd === "config"` → delegate в `./config`; help text update | EDIT |
| `packages/shemma-mcp/src/tools/export-miro.ts` | `registerExportMiroTool(server, deps)` (one-file-per-tool pattern) | NEW |
| `packages/shemma-mcp/src/schemas.ts` | `ExportMiroArgs` zod schema | EDIT |
| `packages/shemma-mcp/src/server.ts` | импорт + вызов `registerExportMiroTool(...)` после `registerDomainTools` | EDIT |
| `apps/frontend/src/canvas/export-miro-modal.tsx` | Board picker + confirm + progress modal | NEW |
| `apps/frontend/src/canvas/export-hotkey.ts` | `makeExportHotkeyHandler` (по аналогии с `tidy-layout.ts:makeTidyHotkeyHandler`) | NEW |
| `apps/frontend/src/App.tsx` | `⌘⇧E` hotkey wiring + `exportModalOpen` state + modal render в OverlayUi | EDIT |
| `apps/frontend/src/chrome/TldrawComponents.tsx` | «Export to Miro» context menu item + `⌘⇧E` kbd hint (рядом с Tidy) | EDIT |
| `CHANGELOG.md` | 0.19.0 entry (feature: Export selection → Miro) | EDIT |

**Тесты:**
| Path | Статус |
|---|---|
| `apps/backend/src/export/miro/upload.test.ts` | NEW |
| `apps/backend/src/export/miro/color-mapping.test.ts` | NEW |
| `apps/backend/src/export/miro/builder.test.ts` | NEW |
| `apps/backend/src/export/miro/tracking.test.ts` | NEW |
| `apps/backend/src/export/miro/rich-text.test.ts` | NEW |
| `apps/backend/src/export/miro/coords.test.ts` | NEW (page-space walker) |
| `apps/backend/src/config.test.ts` | NEW (readConfig/writeConfig/*MiroToken) |
| `packages/shemma-cli/src/config.test.ts` | NEW (cmdConfigSet validation, --json mode) |
| `apps/frontend/src/canvas/export-hotkey.test.ts` | NEW (по аналогии с tidy hotkey test, DRW-088) |

---

## 15. References

- DRW-103 task: `backlog/tasks/drw-103-export-miro.md` (motivation, brainstorm questions, research output).
- Research report: `/tmp/miro-research-2026-05-19.md` (Miro REST API v2 endpoints, auth, rate limits, quirks).
- Miro REST API v2 docs: `https://developers.miro.com/reference/api-reference`.
- DRW-088 spec (Tidy selection): UI паттерн для hotkey + context menu. Реализован в `canvas/tidy-layout.ts` + `chrome/TldrawComponents.tsx`.
- CLAUDE.md §3.8: service-layer pattern (tldraw components API, no `position:fixed` overlays).
- Memory: [[feedback-product-vision-bidirectional]] — driver для export as stakeholder sharing.
- Memory: [[feedback-gitflow-semver-tags]] — MINOR bump 0.19.0, numeric tag без `v`.
- `docs/references/tldraw-cheatsheet.md` — tldraw 5.x bindings API, `getBindingsFromShape`, page-space resolution patterns.
- `docs/references/tldraw-5x-deep.md` §3 — `TLArrowBindingProps` detailed schema (`snap` field caveat).
- `apps/backend/src/version.ts` — `VERSION.version` source для `metadata.shemmaVersion` (§10.2).
- DRW-082 — frame children parent-relative fix в `domain/layout.ts` (precedent для page-space resolution).
- DRW-076 — arrow binding validation history (`snap: ElbowArrowSnap` caveat).
