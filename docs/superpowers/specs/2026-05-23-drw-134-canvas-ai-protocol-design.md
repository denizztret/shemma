# DRW-134: Canvas-AI bidirectional protocol — RAW+overlay в schema-frame

**Date:** 2026-05-23
**Status:** Proposed (design phase, awaiting impl plan)
**Version:** v0.1
**Related:** DRW-127 (subsumed), DRW-124 (umbrella close), DRW-112 (UI picker overlap), ADR-0001, ADR-0004 (superseded), DRW-111 (parallel track, no conflicts)

## TL;DR

Каждая схема на доске — это frame с RAW mermaid-source в `meta.mermaidSource` и набором overlay-правок в `meta.didrawOverlays`; AI читает доску структурированно (frames + free shapes), пишет инкрементальные patch'и поверх RAW, а деструктивные правки делает через явный дубликат frame'а вместо in-place mutation.

## Goals

- Дать LLM семантически родной view канваса: mermaid-text как первичный язык, JSON только для overlay + free shapes.
- Сделать write API инкрементальным (patch RAW + overlay) вместо нынешнего append-only через `/api/domain` для frame-внутреннего контента.
- Развести user-edits и AI-edits через overlay-слой: user-перетаскивания/цвета/rename не теряются при AI re-render, AI не перетирает user-вложения.
- Развести identity и label: ID стабилен через rename, label — изменяемый display атрибут.
- Поддержать multi-schema в одной room (несколько frames) и cross-device storage-only path (DRW-127) одним механизмом.
- Сделать destructive changes (truly разрушительные правки структуры) явным actiton'ом через frame duplication, а не in-place перезаписью RAW.
- Сохранить legacy rooms работающими через legacy API без вынужденной миграции.

## Non-goals

- Bit-perfect round-trip любого freehand/manual canvas-ввода через mermaid (rasterized scribbles, custom shapes без role и т.д. остаются free shapes).
- Auto-classification ролей по содержимому label или контексту (`role: "service"` etc. ставится либо из mermaid syntax при импорте, либо user явно через UI picker).
- Vision-mode (screenshot/image read) — отдельный complementary path в backlog, не требует совместного дизайна.
- D2 как альтернативный DSL — отдельная задача после MVP (`@terrastruct/d2`, pre-1.0, drag-positions через платный TALA).
- Active migration script для существующих rooms — opt-in через создание новых rooms.
- AB-test инфраструктура для сравнения mermaid vs D2 в одной session.
- Cleanup policy для длинных цепочек duplicated frames (history pruning).

## Background

### Current state

Сейчас mermaid pipeline работает односторонне через WebSocket:

- `shemma_import_mermaid` (MCP) → `POST /api/agent/import-mermaid?room=<id>` → WS-фрейм в живой browser tab → `window.shemmaImportMermaid(source)` → `createMermaidDiagram(editor, source)` из `@tldraw/mermaid`.
- ADR-0001 зафиксировал frontend-only impl: mermaid.parse падает в jsdom (нет SVG layout engine), `@tldraw/mermaid` требует React Editor instance.
- Если живого WS-клиента нет → backend возвращает HTTP 503 + room_url (`apps/backend/src/routes/import-mermaid.ts:51`), AI обязан попросить user открыть tab. Headless / cron / cross-device сценарии заблокированы (DRW-127).

Frontend импорт пишет сырые `geo`/`arrow`/`frame` shapes с `meta.didrawName` (см. `apps/frontend/src/canvas/mermaid-import.ts:142`); RAW source сохраняется в `meta.mermaidSource` на root frame'е как passive marker для debug — но никто его не читает обратно для re-render или edit.

Read-side AI работает через `shemma_context` (`apps/backend/src/routes/context.ts` → `apps/backend/src/domain/context.ts`): отдаёт domain-summary в JSON (nodes, edges, groups с role/connectionKind, ~8KB на 100 элементов). Это **JSON view**, не mermaid; LLM натренированы на mermaid кратно лучше, поэтому семантический сигнал теряется на read pass.

Write-side AI работает через `/api/domain` (define/connect/group/note/layout/delete), типизированные actions поверх `@shemma/domain` package. Действия append-only по отношению к существующему canvas — точечные изменения существующих shapes возможны через define-upsert (по name), но diff'а с предыдущим состоянием AI явно не строит.

Identity model сейчас: **tldraw shape ID — opaque random** (`shape:<rand>` через `apps/backend/src/domain/compile.ts:17`), а **identity для protocol — это `meta.didrawName`** (string slug; см. `elementIdOf` в `apps/backend/src/domain/context.ts:70-73`). Префикс `shape:e_<name>` упоминается только в `migrate-v2.ts` (legacy strip из старых v2 envelope'ов) и в Miro tracking тестах — это **устаревшая часть**. CLAUDE.md содержит устаревший claim про `nameToShapeId === "shape:e_<name>"`; его обновление — отдельный fix в impl фазе.

Проблема текущей identity model: `meta.didrawName` tied to label через slug — переименование label = новый name = новая сущность; round-trip через label change невозможен. Overlay-слой нельзя адресовать по stable ID, потому что ID меняется при rename.

### Problem

Три структурных несоответствия:

1. **Read mismatch.** AI получает JSON, но natively «думает» в mermaid. Любая операция «посмотри что на доске и продолжи логику» проходит через mental translation JSON → mermaid → patch. Это лишний hop, hallucination-prone.

2. **One-way write через snapshot.** Текущий `import_mermaid` это «полная перезаписка», а incremental edit (добавь узел, переименуй существующий, перекинь связь) делается либо через domain actions поверх raw shapes (теряем mermaid semantics), либо через append к raw mermaid через тот же tool (получаем дубликаты). Diff-патч на RAW отсутствует.

3. **Identity tied to label.** `shape:e_<name>` ломает rename как недеструктивную операцию. Любое переименование = новая сущность + потеря всех связей в overlay-слое (если бы он был).

И ещё: **нет overlay semantics**. User drag, custom color, sticky note рядом с узлом — всё живёт в плоском store вместе с AI-shapes; AI формально не отделяет один от другого и рискует перетереть.

### Vision

«**RAW photo + неразрушающие фильтры**» как model. Метафоры:

- **Lightroom** — RAW (negative) + adjustments (exposure, white balance) применяются на render time; original не меняется.
- **Figma instance + overrides** — master component задаёт структуру, instance overrides меняют конкретные поля без отвязки от master.
- **Git branch + commits** — base commit + diff = current state; revert удаляет diff, не base.

Каждая schema на доске — **frame**. В `frame.meta.mermaidSource` — canonical RAW. В `frame.meta.didrawOverlays` — diff (positions, colors, labels) поверх render'а. Дети frame'а = render(RAW) + apply(overlays). User drags узел → пишется в overlay, RAW не трогается. AI добавляет узел → пишется в RAW, frame re-render'ится, overlay-entries для существующих узлов применяются заново.

**Frame как unit.** Snapshot operations (создание схемы, дубликация, удаление) идут на уровне frame'а. Incremental patches идут поверх RAW конкретного frame'а. Multi-schema в одной room = несколько frames рядом. Destructive change → AI делает `shemma_duplicate_schema` (новый frame рядом) → правит дубликат → user видит цепочку версий.

**Mermaid как DSL Stage 1.** D2 в backlog. LLM знают mermaid лучше; mermaid subset для storage-mode (graph TD/LR, flowchart, subgraph, базовые node shapes / edge styles) покрывает 90% architecture-диаграмм. D2 преимущества (pure-Node parser, stable IDs в синтаксисе) откладываются до явного запроса.

## Architecture

### Schema-frame as unit

**Schema-frame** = tldraw `frame` shape с двумя обязательными meta-полями:

- `meta.mermaidSource: string` — RAW mermaid-text, canonical source of truth для structure.
- `meta.didrawOverlays: Record<NodeId, OverlayEntry>` — diff поверх render'а, по `NodeId` каждого render'нутого ребёнка.

Плюс служебные:

- `meta.didrawSchemaFrame: true` — discriminator (отличает schema-frame от обычного user-drawn frame'а).
- `meta.schemaProtocolVersion: "1.0"` — версия protocol модели (для будущих breaking changes на уровне overlay schema).

Структура: `frame > shapes`. Children frame'а — **прямые** shapes (geo / arrow), без промежуточной tldraw `group`. После mermaid import auto-ungroup убирает родительскую group, оставляя shapes прямыми детьми frame'а (см. §Membership rules ниже).

**Room-level marker.** `room.meta.didrawProtocol = "v2"` — opt-in marker. Старые rooms без этого marker'а работают через legacy API (текущий `shemma_context` отдаёт domain JSON). Detection: backend читает `room.meta.didrawProtocol` при resolve и роутит request на v1/v2 read-handler.

Важно: **не путать** `room.meta.didrawProtocol` (новый, string `"v2"`) с envelope-level `schemaVersion` (число 1/2/3, persistence format в `apps/backend/src/envelope.ts`). Это разные namespaces; envelope про JSON file format, didrawProtocol про logical model.

### Identity model

**Format:** `<slug>-<6char-base36>` для именованных узлов, `e-<6char-base36>` для безымянных (anonymous nodes из mermaid типа `A --> B` где `A` сам по себе и label, и id).

**Examples:**
- `api-x9k2lm` — узел с label «API» (slug = `api`).
- `auth-service-7q3w1z` — узел с label «Auth Service» (slug = `auth-service`).
- `e-h4n8tp` — anonymous узел (mermaid `A` без явного label).

**Rules:**
- Slug normalization как сейчас (`apps/frontend/src/canvas/mermaid-import.ts:74`): `lowercase → [^a-z0-9]+ → '-' → trim '-' → slice 40 chars → fallback "shape"`.
- Suffix length default = 6, configurable через `room.meta.didrawIdSuffixLength` (3..12). Длиннее = ниже collision risk + длиннее IDs в RAW; короче = читаемее.
- Charset базы — `[0-9a-z]` (base36).
- ID **immutable** после create. Rename label не меняет ID, не пишет новый суффикс.
- Любая сторона может генерировать ID: frontend локально при создании shape через tldraw UI, backend при `/api/schema/*` action, AI в snapshot mermaid через явный syntax `nodeId["Label"]`.
- Backend не переписывает caller-provided IDs (no slug regeneration, no suffix normalization), но **валидирует** regex shape + uniqueness within schema-frame; on mismatch возвращает `duplicate-node` / `invalid-id` error. Это защищает RAW integrity без silent regenerate.

**Breaking change vs current.** Текущая identity модель: `meta.didrawName` (slug string) — это identity, tldraw shape ID — opaque random. Identity tied to label через slug. Новая модель добавляет два явных meta-поля:

- `meta.didrawId: NodeId` — stable, immutable, never changes при rename; формат `<slug>-<6char>` или `e-<6char>`.
- `meta.didrawLabel: string` — display, mutable; rename меняет только это поле.

Existing `meta.didrawName` остаётся как **legacy field**, deprecate gradually. Identity больше не tied to label — overlay-слой адресуется по stable `didrawId`. Старая модель остаётся для legacy rooms; новые rooms идут по новой identity model. CLAUDE.md invariant `nameToShapeId === "shape:e_<name>"` обновляется в impl-фазе (отдельный fix).

**Collision impossible by uniqueness.** Suffix генерится с retry до 8 attempts при unlikely collision внутри той же schema-frame (всё что нужно — frontend / backend проверяют `meta.didrawId` set на children). Birthday paradox для 6 base36 chars (≈ 2.18 × 10⁹) даёт > 1% collision rate только при > 6500 узлов в одной schema-frame; за этим cutoff'ом — увеличить suffix length через config.

### Overlay model

**Overlay = diff поверх render'а от RAW**, хранится в `frame.meta.didrawOverlays` как `Record<NodeId, OverlayEntry>`. NodeId — это `meta.didrawId` соответствующего shape'а.

```typescript
type OverlayEntry = {
  position?: { x: number; y: number };   // page-relative coords
  color?: string;                         // tldraw color name или hex
  label?: string;                         // overrides RAW label при render
  role?: Role;                            // overrides inferred role
  pinned?: boolean;                       // user-pinned position (см. CLAUDE.md pin discipline)
  styleOwnedBy?: "user";                  // user-edited, AI не перетирает
  // future: width/height overrides, freehand attachments, custom strokes
};
```

**Apply order при render:** RAW → mermaid parse → ELK layout → shape generation → apply overlays per NodeId → final shape props.

**Orphan policy: keep dead.** Если RAW удалил узел `api-x9k2lm`, а overlay `didrawOverlays["api-x9k2lm"]` остался — entry **сохраняется в meta**, не удаляется автоматически. Rationale:

- User мог переместить узел, потом AI его удалил по ошибке; reverse (вернуть узел в RAW) восстанавливает позицию из overlay.
- Cleanup — explicit operation (frame archive/delete полностью убирает meta), не silent garbage collection.
- Collision risk нулевой: NodeId уникален по construction.

**Warning surface.** Mutation response несёт `{orphanedOverlays: N}` если patch удалил узлы с непустым overlay entry — AI или user может решить, делать ли cleanup.

**User vs AI ownership.** Существующее `meta.styleOwnedBy === "user"` invariant (CLAUDE.md) сохраняется для shape-level customization. Overlay — orthogonal layer, который user редактирует через drag/style picker; AI **может** писать в overlay через `shemma_set_overlay`, но typical write flow для AI — это patch RAW, не overlay.

**User overlay write flow (frontend → backend).** При user drag / color change / rename на shape inside schema-frame frontend пишет в overlay автоматически:

1. tldraw store change listener в frontend (`apps/frontend/src/canvas/schema-overlay-sync.ts` new) ловит изменения shapes с `meta.didrawSchemaParent` set.
2. Diff'ит изменённые fields против rendered defaults (position vs auto-layout position, props.color vs role-preset color, richText vs label из RAW).
3. Строит partial `OverlayEntry` для каждого изменённого shape: `{ position?, color?, label?, styleOwnedBy: "user" }`.
4. Шлёт `POST /api/schema/{frameId}/patch` с action `{ kind: "schema-set-overlay", nodeId, overlay }`. `styleOwnedBy: "user"` маркер ставится автоматически (frontend знает что user-initiated edit).
5. Backend применяет overlay merge в `frame.meta.didrawOverlays[nodeId]` (deep merge, не replace); WS bus emit к other subscribers (включая backend persistence).
6. Race: если AI в этот момент делает `schema-set-overlay` без `styleOwnedBy: "user"` для того же nodeId — backend rejects AI write если existing overlay has `styleOwnedBy: "user"`, возвращает `overlay-user-owned` error code (added в Error codes table).

Это **симметрия с CLAUDE.md style ownership rule**: AI не перетирает user-owned data на ни одном уровне (shape props OR overlay entry).

### Read model

`shemma_context` отдаёт **structured view** доски:

```json
{
  "frames": [
    {
      "id": "frame-a3f7k2",
      "label": "Auth flow",
      "bbox": { "x": 120, "y": 80, "w": 640, "h": 420 },
      "raw": "graph LR\n  user-x1y2 --> api-x9k2lm\n  api-x9k2lm --> db-c8h2vx",
      "overlays": {
        "api-x9k2lm": { "position": { "x": 380, "y": 200 }, "color": "red" }
      }
    }
  ],
  "free": [
    {
      "id": "shape:e_x1y2",
      "type": "geo",
      "label": "TODO check timeout",
      "bbox": { "x": 800, "y": 100, "w": 120, "h": 60 }
    }
  ]
}
```

- `frames[]` — все schema-frames в room. Per-frame: bbox, RAW, overlays. Полный structured view = достаточно для AI чтобы reconstruct visual state.
- `free[]` — shapes снаружи frame'ов (включая user-drawn sticky notes, freehand, scrap geometry). Минимум: id / type / label / bbox. AI читает это для context, но **не пишет** в free section (выход за scope umbrella'ы).
- Legacy rooms (`room.meta.didrawProtocol !== "v2"`) → routed на legacy handler, response shape = текущий domain JSON (nodes/edges/groups). Backward compat preserved.

**Semantic:** AI видит canvas как user — отдельные schema-документы плюс свободное пространство. Это драйвер для feedback `feedback-product-vision-bidirectional`.

### Write model

Все mutation'ы на schema-frame идут через новый endpoint `POST /api/schema/{frameId}/patch` с **incremental actions**:

- `schema-define { nodeId, role, label? }` — add or upsert node в RAW.
- `schema-connect { from, to, connectionKind?, label? }` — add edge.
- `schema-rename { nodeId, label }` — change display label (RAW updated, identity preserved).
- `schema-set-role { nodeId, role }` — change role в RAW (re-renders shape with new style).
- `schema-group { nodeIds, as: "boundary"|"network", name?, label? }` — wrap в subgraph.
- `schema-disconnect { from, to }` — remove edge.
- `schema-delete-node { nodeId }` — remove node + adjacent edges from RAW.
- `schema-set-overlay { nodeId, overlay: OverlayEntry }` — write overlay directly (typical для UI, rare для AI).

**Snapshot write** — только для bootstrap нового frame через `POST /api/schema/create`. Polymorphic body:
- Mode A: `{ label, raw }` — full mermaid source, backend парсит и создаёт frame + shapes.
- Mode B: `{ label, actions: SchemaAction[] }` — построение через actions, backend сериализует в RAW.

**Apply flow на patch:**
1. AI вызывает `POST /api/schema/{frameId}/patch` с actions.
2. Backend читает текущий `frame.meta.mermaidSource`.
3. Применяет actions к RAW в memory → new RAW string.
4. Парсит new RAW → AST → новые children (with stable identity assignment).
5. Diff old children vs new: delete removed, add new, update changed.
6. Применяет existing `frame.meta.didrawOverlays` к финальным children.
7. Auto-layout (ELK) для added/moved shapes (best-effort, не блокирует apply).
8. Emit store delta через WS bus.

**Destructive change → frame duplication.** Если AI делает потенциально разрушительное изменение (массовый rebuild, удаление >50% узлов, смена direction `LR → TD` — это перетрясывает все позиции), AI **обязан** сначала вызвать `shemma_duplicate_schema(frameId, newLabel)`, получить newFrameId, и patch'ить новый frame. Original остаётся untouched. На доске копится цепочка версий.

Guidance что считать destructive — в tool description; mechanism не enforce'ит (AI decision), но `frame.meta.didrawDestructiveCount` (счётчик предупреждений) растёт когда patch удаляет >N узлов или меняет direction — user может смотреть как фильтр для review.

### Frame duplication

Explicit AI tool `shemma_duplicate_schema(frameId, newLabel)`:

1. Backend читает `frame` + все children (shapes inside frame).
2. Создаёт new frame с label = newLabel; копирует `meta.mermaidSource` и `meta.didrawOverlays` 1:1.
3. **Re-assigns identity** на children: каждый `meta.didrawId` получает новый `<slug>-<6char>` (slug сохраняется, suffix регенерится).
4. Updates RAW: replace все old IDs на new IDs (regex по mermaid source).
5. Updates overlays: same key replacement.
6. Positions new frame `[oldFrameBboxRight + 40, oldFrameBboxTop]` (offset вправо).
7. Original frame **не модифицируется** вообще.

**Effect:** новый параллельный frame, который AI может править инкрементально. User видит исходный + новую версию как side-by-side для compare. Undo бесплатный (удалить копию). А vs B vs C альтернативы — несколько duplicate calls.

**No automatic cleanup chains.** Цепочки длиной 10+ frames — user explicit problem; cleanup policy в backlog.

### Multi-schema targeting

Одна room может содержать несколько schema-frame'ов. Targeting rules для MCP tools (`shemma_patch_schema`, `shemma_duplicate_schema`, `shemma_set_overlay`):

- **0 frames в room** → каждый mutation tool возвращает `{ ok: false, code: "no-schema-frame", hint: "call shemma_create_schema first" }`.
- **1 frame в room** → `frameId` argument опционален; backend resolve'ит implicitly.
- **N > 1 frames в room** → `frameId` argument **required**; omission даёт `{ ok: false, code: "ambiguous-schema-frame", candidates: [{ frameId, label }] }`.
- AI читает frame list через `shemma_canvas_view` → `frames[]` чтобы знать целевой `frameId`.

Targeting parallels existing `space?` / `room?` resolver pattern (см. CLAUDE.md MCP section — `Resolver: explicit > CWD prefix match > default > ambiguous`).

## Data model

### TypeScript types

```typescript
// === Identity ===

/** NodeId внутри schema-frame. Detached от tldraw shape ID.
 *  Canonical form: see "Identity format (formal)" section ниже.
 *  Default suffix length = 6 base36 chars; configurable per room. */
export type NodeId = string;

/** Builder для regex с конкретным suffix-length (N). Используется validator'ом. */
export function nodeIdRegex(suffixLen: number): RegExp {
  return new RegExp(`^(?:[a-z0-9]+(?:-[a-z0-9]+)*|e)-[0-9a-z]{${suffixLen}}$`);
}

/** Default regex для suffixLen=6. */
export const DEFAULT_NODE_ID_REGEX = nodeIdRegex(6);

// === Overlay entry ===

import type { Role } from "@shemma/domain";

export type OverlayEntry = {
  position?: { x: number; y: number };
  color?: string;
  label?: string;
  role?: Role;
  pinned?: boolean;
  styleOwnedBy?: "user";
};

// === Frame meta ===

export type SchemaFrameMeta = {
  didrawSchemaFrame: true;
  didrawProtocol: "v2";
  schemaProtocolVersion: string;   // "1.0" для первого release
  mermaidSource: string;
  didrawOverlays: Record<NodeId, OverlayEntry>;
  didrawDestructiveCount?: number;
};

// === Shape meta (children frame'а) ===

export type SchemaChildMeta = {
  didrawId: NodeId;             // stable, immutable identity для overlay addressing
  didrawLabel: string;          // mutable display label; rename меняет только это поле
  didrawSchemaParent: string;   // frame ID (tldraw shape:xxx)
  /** @deprecated legacy `meta.didrawName` (slug). Сохраняется для v1 compat, не используется в v2 identity. */
  didrawName?: string;
};

// === Room meta ===

import type { RoomMeta as LegacyRoomMeta } from "./types";

export type RoomMetaV2 = LegacyRoomMeta & {
  didrawProtocol?: "v2";
  didrawIdSuffixLength?: number;  // default 6, range 3..12
};

// === Schema actions ===

export type SchemaDefineAction = {
  kind: "schema-define";
  nodeId?: NodeId;          // omit → backend generates
  role: Role;
  label?: string;
  in?: NodeId;              // subgraph parent
};

export type SchemaConnectAction = {
  kind: "schema-connect";
  from: NodeId;
  to: NodeId;
  connectionKind?: ConnectionKind;
  label?: string;
};

export type SchemaRenameAction = {
  kind: "schema-rename";
  nodeId: NodeId;
  label: string;
};

export type SchemaSetRoleAction = {
  kind: "schema-set-role";
  nodeId: NodeId;
  role: Role;
};

export type SchemaGroupAction = {
  kind: "schema-group";
  nodeIds: NodeId[];
  as: "boundary" | "network";
  name?: NodeId;
  label?: string;
};

export type SchemaDisconnectAction = {
  kind: "schema-disconnect";
  from: NodeId;
  to: NodeId;
};

export type SchemaDeleteNodeAction = {
  kind: "schema-delete-node";
  nodeId: NodeId;
};

export type SchemaSetOverlayAction = {
  kind: "schema-set-overlay";
  nodeId: NodeId;
  overlay: OverlayEntry;
};

export type SchemaAction =
  | SchemaDefineAction
  | SchemaConnectAction
  | SchemaRenameAction
  | SchemaSetRoleAction
  | SchemaGroupAction
  | SchemaDisconnectAction
  | SchemaDeleteNodeAction
  | SchemaSetOverlayAction;

// === Request / response shapes ===

export type SchemaCreateRequest =
  | { label: string; raw: string }
  | { label: string; actions: SchemaAction[] };

export type SchemaCreateResponse =
  | { ok: true; frameId: string; nodeIds: NodeId[]; version: number }
  | { ok: false; errors: SchemaActionError[] };

export type SchemaPatchRequest = {
  actions: SchemaAction[];
  clientOpId?: string;
};

export type SchemaPatchResponse =
  | {
      ok: true;
      frameId: string;
      version: number;
      orphanedOverlays?: number;
      addedNodeIds?: NodeId[];
      removedNodeIds?: NodeId[];
    }
  | { ok: false; errors: SchemaActionError[] };

export type SchemaDuplicateRequest = {
  newLabel: string;
};

export type SchemaDuplicateResponse =
  | { ok: true; newFrameId: string; nodeIdMap: Record<NodeId, NodeId> }
  | { ok: false; error: string };

// === Read shape ===

export type CanvasViewResponse = {
  schemaVersion: "v2";
  frames: Array<{
    id: string;
    label: string;
    bbox: { x: number; y: number; w: number; h: number };
    raw: string;
    overlays: Record<NodeId, OverlayEntry>;
  }>;
  free: Array<{
    id: string;
    type: string;
    label?: string;
    bbox: { x: number; y: number; w: number; h: number };
  }>;
};

export type SchemaActionError = {
  actionIndex: number;
  code:
    | "unknown-node"
    | "duplicate-node"
    | "invalid-id"
    | "invalid-mermaid"
    | "invalid-role"
    | "invalid-connection-kind"
    | "frame-not-found";
  message: string;
};
```

### JSON schema

`GET /api/canvas/view?room=<roomId>` для v2 room возвращает `CanvasViewResponse` (см. выше). Legacy room (без `meta.didrawProtocol === "v2"`) → backend возвращает `{ schemaVersion: "v1", legacy: <legacy domain JSON> }`. Caller (MCP / CLI) переключается на legacy formatting по `schemaVersion`.

`POST /api/schema/create?room=<roomId>` body — `SchemaCreateRequest`, response — `SchemaCreateResponse`.

`POST /api/schema/{frameId}/patch?room=<roomId>` body — `SchemaPatchRequest`, response — `SchemaPatchResponse`.

`POST /api/schema/{frameId}/duplicate?room=<roomId>` body — `SchemaDuplicateRequest`, response — `SchemaDuplicateResponse`.

### Identity format (formal)

**Regex:**
```
^(?:[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{N})|(?:e-[0-9a-z]{N})$
```

где N = `room.meta.didrawIdSuffixLength` (default 6, range 3..12).

**Slug normalization:**
1. Lowercase входной label.
2. Replace `[^a-z0-9]+` → `-`.
3. Trim leading/trailing `-`.
4. Slice [0..40] chars.
5. Fallback `shape` если результат empty.

**Non-ASCII labels (cyrillic, CJK, emoji) — design choice.** Slug normalization step 2 фильтрует всё кроме `[a-z0-9]`, поэтому label `"Postgres БД"` нормализуется в `"postgres"` (cyrillic часть выпадает), label `"БД"` нормализуется в empty → fallback `shape` → ID `shape-<6char>`, label `"📊 Dashboard"` нормализуется в `dashboard`. **Это intentional**: identity не несёт читаемость для unicode-only labels, но **`meta.didrawLabel` сохраняет оригинал** для display. Если slug становится пустым/коллизирующим с другим `shape-N` — fallback `e-<6char>` (anonymous form). AI может явно передать `nodeId: "auth-<6char>"` если хочет читаемый identifier для cyrillic node — backend trust'ит ID (см. §Identity model: Backend trust'ит ID без regeneration).

**Suffix generation:**
1. Random base36 char × N через `Math.random()` (frontend) или `crypto.randomBytes()` (backend).
2. Check uniqueness внутри текущей schema-frame (across all children `meta.didrawId`).
3. Retry до 8 раз; на 9-й — throw (signal user увеличить suffix length).

**Anonymous nodes:** prefix `e` (e = element без явного label). Полная форма: `e-<6char>`. Mermaid `A --> B` где `A` это identifier — backend парсит и присваивает `A` slug = `a`, label = `A`; результат `a-x9k2lm`. Полностью anonymous (например, edge с `[Some]` без explicit name в LHS) → `e-<6char>`.

**Collision handling:** impossible after uniqueness check. Если retry лимит превышен — это signal что schema-frame перегружена (>1000 узлов); продакшн constraint, не runtime ошибка для AI.

## API contract

### MCP tools — new

- `shemma_canvas_view` — replaces `shemma_context`. Returns `CanvasViewResponse`. Args: `{ room?, space? }`. Read-only.
- `shemma_create_schema` — args: `{ label: string, raw?: string, actions?: SchemaAction[], room?, space? }`. Creates new schema-frame; returns `{ frameId, nodeIds, version }`.
- `shemma_patch_schema` — args: `{ frameId: string, actions: SchemaAction[], clientOpId?, room?, space? }`. Incremental patch; returns `{ frameId, version, orphanedOverlays?, addedNodeIds?, removedNodeIds? }`.
- `shemma_duplicate_schema` — args: `{ frameId: string, newLabel: string, room?, space? }`. Returns `{ newFrameId, nodeIdMap }`.
- `shemma_set_overlay` — args: `{ frameId: string, nodeId: NodeId, overlay: OverlayEntry, room?, space? }`. Single overlay write. Convenience wrapper around `schema-set-overlay` action.
- `shemma_delete_schema` — args: `{ frameId: string, room?, space? }`. Removes schema-frame полностью (frame + children + meta). Returns `{ ok: true }` или `{ ok: false, code: "frame-not-found" }`. Convenience tool для AI cleanup и user-initiated archive — без него frame удаляется только через tldraw UI или generic `shemma_delete` на free layer (что для schema-frame требует двух операций — clear children + delete frame).

### MCP tools — modified

- `shemma_import_mermaid` — now writes в v2 model для v2 rooms (creates schema-frame with RAW); auto-ungroups children. For legacy rooms — продолжает работать как сейчас (WS path through browser). New param: `mode?: "auto" | "storage" | "browser"` (default `"auto"`); `"storage"` requires v2 room, `"browser"` — fallback на existing WS flow.
- `shemma_context` — kept as alias for `shemma_canvas_view` для legacy compatibility 1 minor version; emits deprecation warning. Polymorphic response: v2 rooms get new shape, v1 rooms get domain JSON.

### MCP tools — unchanged

- `shemma_define` / `shemma_connect` / `shemma_group` / `shemma_note` / `shemma_layout` / `shemma_delete` — продолжают работать на legacy rooms и на **free** layer (вне schema-frame) для v2 rooms. AI **не** использует их для schema-frame внутренностей в v2 rooms; вместо них — `shemma_patch_schema`.
- `shemma_layout_selection` / `shemma_apply` / `shemma_open` / `shemma_export_miro` — без изменений.

### HTTP endpoints

- `GET /api/canvas/view?room=<roomId>` — replaces `GET /api/agent/context` для v2 rooms; legacy для v1.
- `POST /api/schema/create?room=<roomId>` — body `SchemaCreateRequest`.
- `POST /api/schema/{frameId}/patch?room=<roomId>` — body `SchemaPatchRequest`.
- `POST /api/schema/{frameId}/duplicate?room=<roomId>` — body `SchemaDuplicateRequest`.
- `DELETE /api/schema/{frameId}?room=<roomId>` — removes schema-frame полностью (frame shape + children + meta). Returns `{ ok: true }` или `{ ok: false, code: "frame-not-found" }`.

Existing `/api/domain` остаётся для legacy rooms и для free-layer операций в v2 rooms (если AI хочет добавить sticky note вне frame'а — это idiomatic free-layer write).

### Domain actions

Новые action kinds `schema-*` живут в backend (`apps/backend/src/domain/schema-types.ts` — new file). Они **не** добавляются в `@shemma/domain` package сразу: эта SSOT-shared package для Role / ConnectionKind / LayoutMode, эти типы новые actions используют, но action types сами по себе HTTP-layer concern, не domain semantics.

**Relation to existing `/api/domain`:**
- `define` (domain) ≈ `schema-define` (schema) — но schema-define ограничен scope'ом одного frame'а и пишет в RAW, define пишет shape в общий canvas.
- `connect` ≈ `schema-connect` — similar relation.
- `group` (domain `as: "network"|"boundary"`) ≈ `schema-group` (same shape).
- `note`, `layout`, `delete` — нет direct schema-action analogs; AI использует domain actions для free layer.

## Membership & ownership

**Shape ∈ schema-frame ⟺ parentId chain заканчивается на frame.** Direct parent или через nested tldraw groups (intermediate group'ы не запрещены, но post-mermaid-import убираются auto-ungroup'ом).

- `parentId === frameId` → direct child, schema member.
- `parentId === groupId, group.parentId === frameId` → nested member.
- `parentId === pageId` → free shape.

**AI invariant:** AI не lift'ает shapes за пределы frame'а через any action. Lift = destructive structural change → требует `shemma_duplicate_schema` first. Если AI попытается это сделать в `schema-*` action — backend rejects с `outside-frame-not-allowed`.

**User invariant:** User может lift'ить shape за пределы frame'а через tldraw UI; shape становится free shape, overlay entry в `frame.meta.didrawOverlays` остаётся как orphan (keep dead policy).

**Ownership layers:**
- `shape.meta.styleOwnedBy === "user"` — existing invariant per CLAUDE.md, shape-level styling user-owned.
- `frame.meta.didrawOverlays[nodeId].styleOwnedBy === "user"` — new, overlay-level marker user-edited entry, AI не перетирает через `schema-set-overlay`.
- `frame.meta.didrawOverlays[nodeId]` без styleOwnedBy — AI может перезаписать (но typical AI write — это RAW patch, не overlay write).

## Read semantics

Backend resolver на `GET /api/canvas/view?room=<roomId>`:

1. Resolve room через existing resolver (space + room composite key).
2. Read `room.meta.didrawProtocol`.
3. If `"v2"`:
   - Iterate page shapes; partition into frames with `meta.didrawSchemaFrame === true` and free shapes.
   - For each frame:
     - Read `frame.meta.mermaidSource` → `raw`.
     - Read `frame.meta.didrawOverlays` → `overlays`.
     - Compute bbox через union of children bounds (или fallback на frame's own bbox).
     - Read frame label из `frame.props.name` (tldraw frame name).
   - For each free shape:
     - id, type, plaintext label (через richText render), bbox.
   - Return `CanvasViewResponse`.
4. If not `"v2"` (or undefined):
   - Delegate to existing `/api/agent/context` handler.
   - Return `{ schemaVersion: "v1", legacy: <existing domain JSON> }`.

**Performance considerations:**
- Full canvas read — все frames + RAW + overlays — ожидаемый payload size ~2-10 KB per frame, ~5 frames typical, ~50 KB max для heavy room.
- No filtering / pagination в MVP. Если becoming bottleneck → optional `frameIds?: string[]` filter param.

**bbox computation.** Per frame backend:
1. Если frame имеет explicit `props.w / props.h` → uses tldraw frame bounds (`frame.x, frame.y, frame.w, frame.h`).
2. Иначе fallback на union всех children bounds.
3. Если children пусты (новый frame, RAW yet to be rendered) → frame's intrinsic bounds.

bbox это integer-rounded для consistency между storage и frontend render.

**Label extraction.** `frame.props.name` — tldraw frame's built-in name property (string, displayed как frame header). Если не установлен → fallback на `frame.meta.didrawLabel` (если AI явно set'нул через `shemma_create_schema`).

**Legacy view shape.** Для legacy rooms response отдаётся как:
```json
{
  "schemaVersion": "v1",
  "legacy": { /* existing /api/agent/context payload, unchanged */ },
  "hint": "room uses legacy protocol; upgrade to v2 via shemma room set-meta didrawProtocol=v2 + create schema-frame"
}
```
MCP layer переключается на legacy formatter если видит `schemaVersion: "v1"`.

## Write semantics

Backend handler на `POST /api/schema/{frameId}/patch`:

1. Resolve room + space.
2. Lookup frame по `frameId`; check `meta.didrawSchemaFrame === true`. Else 404.
3. Idempotency: если `clientOpId` matches recent entry → return cached response.
4. Validate actions:
   - `unknown-node` если action references nodeId отсутствующий в RAW.
   - `duplicate-node` если `schema-define` создаёт уже существующий nodeId.
   - `invalid-mermaid` если в результате применения actions RAW не парсится.
   - `invalid-role` / `invalid-connection-kind` — против `@shemma/domain` enums.
5. Construct new RAW: apply actions sequentially, mutate working string.
6. Parse new RAW → AST (mermaid flowchart parser, см. ADR-0004 для DSL parser choice).
7. Diff old children (`frame.children` with their `meta.didrawId`) vs new AST:
   - Removed nodes → delete tldraw shapes, keep overlay entries (orphan).
   - Added nodes → create tldraw shapes with `meta.didrawId` from RAW.
   - Renamed nodes (same nodeId, new label) → update richText props.
   - Role changed → re-style shape props per role-preset.
8. Apply existing overlays from `frame.meta.didrawOverlays` to final shapes (position, color, etc.).
9. Best-effort auto-layout: ELK pass on changed subgraph, scope `affected` (existing `runLayout`), respects pinned shapes.
10. Persist new `frame.meta.mermaidSource`.
11. Emit `store-change` WS frame через bus.
12. Return `SchemaPatchResponse` with `orphanedOverlays`, `addedNodeIds`, `removedNodeIds`.

**Atomicity:** all-or-nothing. If any action fails validation → return errors[], no mutation persisted. Already aligned with `/api/domain` atomic semantics.

**Rollback order (RAW + shapes coherence).** Steps 5-10 выше выполняются атомарно. Конкретный rollback protocol:

1. Backend держит `oldRaw = frame.meta.mermaidSource` и `oldOverlays = frame.meta.didrawOverlays` в памяти до конца handler'а.
2. Новый RAW парсится в AST **до** любых store-mutation'ов. Parse failure → throw + return `invalid-mermaid`, store не тронут.
3. Diff old vs new children строится в памяти (`StoreChangeBatch`); до применения batch frame meta ещё не изменена.
4. **Commit point:** atomic `applyStoreChanges(batch)` + `frame.meta.mermaidSource = newRaw` пишутся в одной транзакции. Если apply шага 9 (auto-layout) падает — это best-effort, **не** rollback'ится (layout не critical для structural integrity).
5. Если ELK auto-layout (step 9) выбрасывает unrecoverable error до commit point → rollback to `oldRaw` + `oldOverlays`, return `{ ok: false, errors: [{ code: "layout-failed" }] }`. Layout-failed добавляется в error codes table.
6. После commit point WS-frame emit (step 11) — even если subscriber dropped, RAW + shapes persisted; replay при reconnect восстанавливает client view.

Invariant: **новый RAW не commit'ится до successful parse + diff build + shape batch construct'а**; on any failure roll back to pre-batch frame.meta (RAW + overlays) + zero shape changes.

**Destructive detection:** на step 7 backend считает `destructiveScore = removedCount / oldNodeCount`. Если score > 0.5 OR direction change (LR→TD etc.) → increment `frame.meta.didrawDestructiveCount`, include `warning: "destructive-without-duplicate"` в response. **Не** блокирует операцию — это hint для AI / user audit.

### Write flow example (sequence)

```
AI                       MCP                      Backend                tldraw frontend
 │                         │                         │                         │
 │ shemma_canvas_view     │                         │                         │
 │ ───────────────────────▶ GET /api/canvas/view   │                         │
 │                         │ ───────────────────────▶                         │
 │                         │ ◀─── { frames, free } ──                         │
 │ ◀── { frames, free } ──│                         │                         │
 │                         │                         │                         │
 │ (decide: add API node)  │                         │                         │
 │ shemma_patch_schema     │                         │                         │
 │  frameId=frame-a3f7k2   │                         │                         │
 │  actions=[schema-define]│                         │                         │
 │ ───────────────────────▶ POST /api/schema/.../patch                        │
 │                         │ ───────────────────────▶                         │
 │                         │                         │ read meta.mermaidSource │
 │                         │                         │ apply actions to RAW    │
 │                         │                         │ parse new RAW → AST     │
 │                         │                         │ diff children           │
 │                         │                         │ apply overlays          │
 │                         │                         │ ELK layout (affected)   │
 │                         │                         │ persist + emit WS       │
 │                         │                         │ ────── store-change ───▶│
 │                         │ ◀── { ok: true, ... } ──                         │
 │ ◀── { addedNodeIds }   │                         │                         │
```

### Mermaid → schema action mapping

При parsing RAW backend конвертирует mermaid syntax в schema actions. Mapping table для Phase 2 storage parser:

| Mermaid syntax | Schema action |
|---|---|
| `nodeId[Label]` | `schema-define { nodeId, role: "service", label }` |
| `nodeId(Label)` | `schema-define { nodeId, role: "service", label }` (round-rect, same default) |
| `nodeId{Label}` | `schema-define { nodeId, role: "service", label }` (decision diamond — `service` is default; user может override через `shemma_set_role` если нужен другой role) |
| `nodeId[(Label)]` | `schema-define { nodeId, role: "datastore", label }` (cylinder) |
| `nodeId((Label))` | `schema-define { nodeId, role: "actor", label }` (circle) |
| `nodeId>Label]` | `schema-define { nodeId, role: "external", label }` (asymmetric) |
| `A --> B` | `schema-connect { from: A, to: B, connectionKind: "sync" }` |
| `A -.-> B` | `schema-connect { from: A, to: B, connectionKind: "dep" }` |
| `A ==> B` | `schema-connect { from: A, to: B, connectionKind: "data" }` |
| `A --x B` (or `o`) | `schema-connect { from: A, to: B, connectionKind: "async" }` |
| `A -->\|label\| B` | `schema-connect { from, to, label, connectionKind: "sync" }` |
| `subgraph X [Label] ... end` | `schema-group { name: X, label, as: "boundary", nodeIds: [...] }` |

Inverse direction (action → mermaid) при write используется тем же mapping table — backend генерирует canonical mermaid string из actions. Roundtrip stability: parse(generate(actions)) === actions для in-scope syntax subset.

**Unsupported syntax** (mermaid types вне flowchart subset) — backend возвращает `{ code: "invalid-mermaid", details: { reason: "unsupported-diagram-type" } }` без модификации. AI fallback на browser path через `shemma_import_mermaid({ mode: "browser" })`.

## Migration (legacy mode)

**Strategy: opt-in только для новых rooms. Active migration script — out of scope.**

**New rooms:**
- `shemma rooms create` или `shemma_open` создаёт room с `room.meta.didrawProtocol = "v2"`.
- Все шаги read/write идут по v2 path.

**Existing rooms (без didrawProtocol marker):**
- Detected на каждом read/write как v1 / legacy.
- Continue работать через current `/api/domain` + `/api/agent/context`.
- Никаких breaking changes для existing integrations.

**Detection:**
```typescript
function isV2Room(room: RoomState): boolean {
  return room.meta?.didrawProtocol === "v2";
}
```

**Opt-in upgrade (manual):** User может вручную добавить `meta.didrawProtocol = "v2"` к existing room через `shemma room set-meta`. **Но**: existing shapes не получают `meta.didrawId` retroactively, schema-frames не создаются. Эффект — `GET /api/canvas/view` отдаст v2 shape с `frames: []` и всеми existing shapes в `free[]`. Дальнейший workflow — user явно создаёт schema-frame через `shemma_import_mermaid` для всех важных диаграмм.

**Deprecation timeline:** legacy mode сохраняется минимум 2 minor versions после v2 stabilization. Точные milestones — open для plan phase. Backward-incompatible removal требует separate ADR.

### MCP callers migration guide

Существующий AI / CLI / external integration code использует `shemma_context` для чтения canvas state. Гарантия совместимости:

1. **`shemma_context` остаётся как polymorphic alias** ровно на 1 minor version после v2 stabilization (например, если v2 ships в `0.23.0`, alias живёт до `0.24.x` включительно).
2. **Polymorphic response:**
   - **v1 room** → `shemma_context` возвращает legacy domain JSON (`{ nodes, edges, groups }`) **byte-identical** к pre-v2 shape. Callers не видят разницы.
   - **v2 room** → `shemma_context` возвращает **новый** `CanvasViewResponse` shape (`{ schemaVersion: "v2", frames, free }`). Каждый response carries `deprecation: "shemma_context → shemma_canvas_view"` warning field (informational, не блокирующий).
3. **`shemma_canvas_view` (new) — non-polymorphic.** Всегда возвращает new shape для обоих room types; для v1 — wraps legacy domain JSON под `{ schemaVersion: "v1", legacy: <domain JSON> }`. Это позволяет callers строить против стабильного contract без полиморфизма.
4. **Migration steps для existing callers:**
   - Step 1 (0.23.0): Update caller code чтобы handle `schemaVersion` discriminator при reading response. Не required — старый код продолжает работать на v1 rooms.
   - Step 2 (0.24.0): Switch tool call с `shemma_context` на `shemma_canvas_view`. Warning surface deprecation reminder.
   - Step 3 (0.25.0+): `shemma_context` removed; callers обязаны использовать `shemma_canvas_view`. Separate ADR fixes exact removal milestone.
5. **MCP tool descriptions** ясно маркируют `shemma_context` как `@deprecated` начиная с 0.23.0 — IDE / completion / AI агенты видят hint при использовании.

## Out of scope

- D2 как альтернативный DSL — backlog, separate ADR planned (`@terrastruct/d2`, drag-positions через платный TALA).
- Vision/screenshot read mode — complementary path в backlog (tldraw `Editor.toImage()`, copy-to-clipboard).
- Auto-classification ролей по label / context inference.
- Bit-perfect round-trip с freehand gestures, custom shapes, rasterized scribbles.
- Active migration script для existing rooms (opt-in only).
- Cleanup policy для длинных цепочек duplicated frames (history pruning).
- AB-test инфраструктура для mermaid vs D2 в одной session.
- Live collaborative editing schema-frame'а несколькими agents одновременно (current single-writer model достаточен).
- Cmd-shift-K UI picker для optional role assignment на user-drawn shapes (см. DRW-112; разнесено в Phase 3 этой umbrella'ы или отдельной задачей).

## Acceptance criteria

1. **AC-1:** `POST /api/schema/create?room=<v2RoomId>` с body `{ label: "Auth flow", raw: "graph LR\nA-->B" }` возвращает HTTP 200 + `{ ok: true, frameId, nodeIds: [<2 ids>], version }`. Subsequent `GET /api/canvas/view?room=<v2RoomId>` содержит этот frame в `frames[]` с тем же RAW.
2. **AC-2:** `POST /api/schema/{frameId}/patch` с `{ actions: [{ kind: "schema-define", role: "service", label: "API" }] }` возвращает `{ ok: true, addedNodeIds: ["api-<6char>"] }`. `frame.meta.mermaidSource` после операции содержит новую node declaration; `GET /api/canvas/view` отражает её.
3. **AC-3:** `POST /api/schema/{frameId}/patch` с unknown nodeId в `schema-connect` action возвращает `{ ok: false, errors: [{ code: "unknown-node", ... }] }` без модификации RAW.
4. **AC-4:** User drag узла в frame'е → frontend пишет `frame.meta.didrawOverlays[nodeId].position` через store change. Subsequent `GET /api/canvas/view` содержит overlay entry. Backend patch RAW (add other node) не перетирает overlay.
5. **AC-5:** `POST /api/schema/{frameId}/duplicate` с `{ newLabel: "Auth flow v2" }` создаёт новый frame side-by-side. Original frame `meta.mermaidSource` и children — без изменений. New frame children получили new `meta.didrawId` (none match original), RAW и overlays remapped.
6. **AC-6:** `schema-delete-node` для узла с непустым overlay entry → backend возвращает `{ ok: true, orphanedOverlays: 1 }`, overlay entry остаётся в `frame.meta.didrawOverlays`.
7. **AC-7:** Legacy room (без `meta.didrawProtocol === "v2"`) — `GET /api/canvas/view` возвращает `{ schemaVersion: "v1", legacy: <domain JSON> }`. Existing `shemma_context` запросы для тех же rooms работают без изменений.
8. **AC-8:** `shemma_canvas_view` (MCP) на v2 room возвращает structured response с `frames[]` + `free[]`. На v1 room тот же tool возвращает legacy shape с deprecation hint в payload.
9. **AC-9:** NodeId generation: `slugify("Auth Service")` + suffix gives `auth-service-<6char>`. Anonymous node → `e-<6char>`. Regex match required для всех persisted IDs.
10. **AC-10:** User lift'ает shape за пределы frame'а через UI → shape становится free, frame.meta.didrawOverlays entry сохраняется. AI попытка lift через `schema-*` action — rejected с `outside-frame-not-allowed`.
11. **AC-11:** Storage-only path: `POST /api/schema/create` работает без WebSocket клиента в room. Subsequent reload room через WS отображает созданный frame с правильным RAW + overlays.
12. **AC-12:** Test coverage по areas, не по counts. Required coverage:
    - **Identity layer** — slug normalization (включая unicode/cyrillic fallback), suffix generation, regex validation для всех suffix lengths в range 3..12, uniqueness retry × 8.
    - **RAW parse/generate roundtrip** — для каждой строки mapping table (`nodeId[Label]`, `A --> B`, subgraph, etc.) parse → AST → generate → byte-equal RAW.
    - **Schema action validation matrix** — каждый action × каждый error code (unknown-node, duplicate-node, invalid-id, invalid-mermaid, invalid-role, invalid-connection-kind).
    - **Diff algorithm** — old children vs new AST: removed nodes detected, added nodes detected, renamed nodes detected (same nodeId, new label), role-changed detected.
    - **Orphan overlay preservation** — `schema-delete-node` для узла с overlay → entry kept в `frame.meta.didrawOverlays`, response carries `orphanedOverlays: N`.
    - **Duplicate remap** — `shemma_duplicate_schema` → new IDs across all children, RAW replaced, overlays remapped key-by-key.
    - **Legacy fallback** — v1 room через `GET /api/canvas/view` отдаёт `{ schemaVersion: "v1", legacy: ... }`; `shemma_context` для v1 room возвращает domain JSON unchanged.
    - **Storage-only path** — `POST /api/schema/create` без живого WS-клиента → frame persisted; reload room через WS отображает RAW + overlays.
    - **User overlay ownership** — user `styleOwnedBy: "user"` overlay не перетирается AI `schema-set-overlay`; AI write returns `overlay-user-owned`.
    - **Rollback atomicity** — invalid action в середине batch → no mutation persisted, RAW + overlays unchanged.

## Phasing (high-level — detailed in plan)

### Phase 1: Data model + identity (foundation)

- NodeId generator (`<slug>-<6char>` / `e-<6char>`) — frontend (`apps/frontend/src/canvas/identity.ts` new) и backend (`apps/backend/src/domain/identity.ts` new).
- `room.meta.didrawProtocol` marker; resolver detection (v1/v2 routing).
- Shape `meta.didrawId` field — frontend writes на create, backend reads.
- Frame `meta.didrawSchemaFrame` / `mermaidSource` / `didrawOverlays` / `schemaProtocolVersion` — type extension.
- Legacy mode preserved: existing `/api/domain` + `/api/agent/context` untouched, just detection layer for v2 rooms.
- Tests: identity uniqueness, slug normalization, marker detection, regex validation.

**Shipping status: internal milestone, не самостоятельный release.** Phase 1 — type-level + identity utility code без UI exposure (нет MCP tools, нет new endpoints; existing flows работают без изменений). Ship'ится вместе с Phase 2 как single release `0.23.0` после Phase 2 stabilization. Phase 1 boundary существует для review checkpoint, не для production gate.

### Phase 2: Read API + Write API

- `GET /api/canvas/view` endpoint (replaces `shemma_context` for v2 rooms; legacy для v1).
- `POST /api/schema/create` (snapshot bootstrap with `raw` or `actions`).
- `POST /api/schema/{frameId}/patch` (incremental actions).
- MCP tools: `shemma_canvas_view`, `shemma_create_schema`, `shemma_patch_schema`, `shemma_set_overlay`.
- Mermaid parsing layer (storage-mode flowchart subset per ADR-0004 decision).
- Frontend mermaid-import: writes v2 model (auto-ungroup, identity assignment, schemaVersion marker on new rooms).
- Tests: action validation matrix, diff algorithm, orphan overlay preservation, legacy backward compat.

Shipping-able: full v2 read/write для new rooms. DRW-127 (storage-only path) автоматически закрывается т.к. `/api/schema/create` работает без browser.

### Phase 3: Frame duplication + UI picker + storage hardening

- `POST /api/schema/{frameId}/duplicate` endpoint + `shemma_duplicate_schema` tool.
- Cmd-shift-K-style picker для optional explicit role / connection-kind на user-drawn shapes (frontend UI).
- `meta.didrawDestructiveCount` audit counter + warning surface.
- Storage-only path validation: cron / headless / cross-device scenarios end-to-end.
- Tests: duplicate preserves overlays, identity remap correctness, picker writes role correctly, full headless flow.

Shipping-able: complete protocol surface. DRW-112 picker partially closed (subset того что эта umbrella покрывает).

## Risks

1. **Mermaid subset coverage too narrow.** Storage-mode parser покрывает только flowchart / graph. `sequenceDiagram`, `classDiagram`, `stateDiagram` etc. — return `unsupported-diagram`, AI должен fallback на browser path. Mitigation: explicit `mode: "auto"` который пытается storage сначала, fallback на browser; clear error codes для AI.

2. **LLM hallucination на patch.** AI может выдать `schema-connect` для nodeId которого нет (drift между mental model и actual RAW). Mitigation: AI ВСЕГДА читает `shemma_canvas_view` перед patch (zero-shot AI guidance в tool description); validation rejects с clear `unknown-node` code; idempotency cache защищает от double-apply.

3. **Overlay desync с RAW re-render.** Если RAW изменился так что геометрия kardinally сдвинулась, sticky overlay позиции могут оказаться вне sensible bounds. Mitigation: overlay positions — hints, не absolute; ELK auto-layout уважает pinned (`overlay.pinned === true`); user-edited (`styleOwnedBy: "user"`) не перетирается, но visual drift возможен — это acceptable trade-off для non-destructive editing.

4. **Identity collisions при коротких suffix length.** При user-config `didrawIdSuffixLength: 3` (base36³ = 46656) collision rate растёт быстро. Mitigation: range constraint 3..12, default 6; retry × 8 при generation; explicit warning при > 1000 nodes / suffix length < 5.

   **Birthday paradox для default (suffix=6).** Math: `P(collision) ≈ 1 - exp(-n²/(2·36⁶))`. ~1% collision rate при ~6500 узлах в одной schema-frame. **Typical case** (100 узлов в frame) → effective collision rate ~0.00007% (one in a million). Birthday paradox это not concern для realistic usage; retry × 8 покрывает unlikely collision при corner-case bursts.

5. **Performance — full canvas read.** `GET /api/canvas/view` строит payload of all frames + RAW + overlays. На room с 20 frames × 50 nodes ≈ 100 KB. Mitigation: optional `frameIds?: string[]` filter в Phase 3; bbox computation memoized в room state; benchmark target — < 50ms на 1000-node room.

6. **Breaking change identity model (legacy `meta.didrawName` → new `meta.didrawId` + `didrawLabel`).** Legacy rooms продолжают использовать `meta.didrawName` (slug-as-identity); новые rooms получают stable `meta.didrawId`. CLAUDE.md содержит устаревший claim про `nameToShapeId === "shape:e_<name>"` (residue от `migrate-v2.ts`, не actual current state); documentation update в CLAUDE.md required при Phase 1 ship — refresh обоих claim'ов: current legacy state (didrawName slug) + v2 identity model (didrawId + didrawLabel).

## Error codes (consolidated)

Все `schema-*` endpoints + MCP tools используют единый error code namespace. Каждый code stable across phases, не меняется без bump.

| Code | When | HTTP status | Recovery |
|---|---|---|---|
| `frame-not-found` | `frameId` не существует в room | 404 | Caller читает `shemma_canvas_view` для актуального списка. |
| `not-schema-frame` | `frameId` указывает на frame без `meta.didrawSchemaFrame === true` | 422 | Caller использует другой frame или `shemma_create_schema`. |
| `no-schema-frame` | Mutation tool без frameId на room с 0 schema-frame'ов | 422 | `shemma_create_schema` first. |
| `ambiguous-schema-frame` | Mutation tool без frameId на room с N > 1 schema-frame'ов | 422 | Caller передаёт явный `frameId`. |
| `unknown-node` | Action references nodeId отсутствующий в RAW | 422 | Caller читает `shemma_canvas_view`. |
| `duplicate-node` | `schema-define` создаёт уже существующий nodeId | 422 | Caller использует другой ID или `schema-rename` существующего. |
| `invalid-id` | nodeId не матчит `nodeIdRegex(suffixLen)` (caller-provided ID rejected) | 422 | Caller передаёт ID матчащий regex или omit'ит для server-side generation. |
| `invalid-mermaid` | После apply RAW не парсится | 422 | Caller fixes syntax (rare — schema actions гарантированно генерят valid mermaid). |
| `invalid-role` | role не в `@shemma/domain` enum | 422 | Caller использует один из `ALL_ROLES`. |
| `invalid-connection-kind` | connectionKind не в `@shemma/domain` enum | 422 | Caller использует один из `ALL_KINDS`. |
| `outside-frame-not-allowed` | AI schema-action пытается lift shape за пределы frame'а | 422 | Caller использует `shemma_duplicate_schema` first. |
| `overlay-user-owned` | AI `schema-set-overlay` для nodeId с existing `overlay.styleOwnedBy === "user"` | 422 | AI оставляет user customization, patch'ит RAW (структуру) вместо overlay (стиля). |
| `unsupported-diagram-type` | Bootstrap с `raw` для non-flowchart diagram | 422 | Caller fallback на `shemma_import_mermaid({ mode: "browser" })`. |
| `legacy-room-not-v2` | Schema endpoint called against legacy room | 422 | Caller использует `/api/domain` или upgrade'ит room. |
| `layout-failed` | ELK auto-layout pass упал до commit point (rollback) | 500 | Retry; если воспроизводится — caller убирает действия с layout-impact или включает `mode: "no-layout"` (Phase 3+). |
| `version-conflict` | Optimistic locking failure (concurrent write) | 409 | Caller refetch + retry. |

**Idempotency:** `clientOpId` в `SchemaPatchRequest` cache'ируется backend-side (same LRU semantics что в `/api/domain`). Replay с тем же `clientOpId` возвращает cached response без re-apply.

## Open questions (post-brainstorm)

All major brainstorm decisions resolved. Implementation-level details для plan phase:

- **OQ-1:** Mermaid parser choice (Option A bespoke vs Option B mermaid flowParser internal) — наследуется из ADR-0004; spike в Phase 2 Task 1.
- **OQ-2:** Точный shape `connectionKind` inference из mermaid edge syntax (`-->` vs `==>` vs `-.->` — таблица в Phase 2 Task 3 plan).
- **OQ-3:** Deprecation timeline для legacy mode — 2 minor versions минимум; точный milestone после v2 stabilization (отдельный ADR).
- **OQ-4:** UI picker (Cmd-shift-K) shortcut precise binding и UX — Phase 3 design, может референсить DRW-112 brainstorm output.

## References

**Memory files:**
- `~/.claude/projects/-Users-tretyakov-dv-Projects-sandbox-di-draw/memory/drw-134-canvas-ai-protocol.md` — brainstorm decisions (8/8 resolved).
- `feedback-product-vision-bidirectional` — driver vision для bidirectional canvas/AI protocol.
- `feedback-russian-primary-tldr`, `feedback-batched-reviews`, `feedback-plan-approval-gate` — process conventions.
- `reference-tldraw-cheatsheet` — for implementation phase tldraw API reference.

**ADRs:**
- `docs/decisions/0001-mermaid-import-location.md` — frontend-only constraint для full mermaid API.
- `docs/decisions/0004-mermaid-storage-only-import.md` — superseded by DRW-134; useful background на DSL parser options (A/B) для storage path.

**Related tasks:**
- DRW-127 — storage-only mermaid import; subsumed via Phase 2 endpoints.
- DRW-124 — umbrella MCP feedback; closes остаток через этот redesign.
- DRW-112 — AI prompts UX; UI picker overlap в Phase 3.
- DRW-111 — Miro visual fidelity v2; independent track (no conflicts по analysis).

**Existing code paths (для plan reference):**
- `apps/frontend/src/canvas/mermaid-import.ts:142` — current `meta.mermaidSource` write на root frame, foundation для v2 model.
- `apps/backend/src/routes/domain.ts:55` — existing `/api/domain` handler, reference для idempotency cache + atomic apply pattern.
- `apps/backend/src/routes/context.ts` + `apps/backend/src/domain/context.ts` — current `/api/agent/context` implementation; legacy fallback path в Phase 2.
- `apps/backend/src/routes/import-mermaid.ts:51` — current 503 + room_url fallback flow, supersed by storage path в Phase 2.
- `apps/backend/src/routes/layout-selection.ts:25-55` — existing mermaid direction parsing, reusable в Phase 2 patch flow.
- `apps/backend/src/types.ts:27` — `RoomMeta` interface, extension point для `didrawProtocol` + `didrawIdSuffixLength`.
- `apps/backend/src/envelope.ts:19` — envelope-level `schemaVersion` (1/2/3) — different namespace от `room.meta.didrawProtocol`, не путать.
- `packages/shemma-domain/src/roles.ts`, `connections.ts` — SSOT enums, reused в schema actions.
