# Phase 3.0 — tldraw-as-primary, domain-as-view (Design)

**Version:** 0.1
**Date:** 2026-05-17
**Status:** approved (user delegated approval to AI; user end-to-end test после полной реализации)
**Tag at release:** `0.4.0`
**Backlog ref:** DRW-028
**Spec convention:** этот документ — design (spec), не implementation plan. План — отдельным документом.

---

## 1. Цель и driver

di.draw — инструмент **двусторонней визуальной парной разработки человека с LLM**. Ключевое требование (см. memory `feedback-product-vision-bidirectional`):

1. Любой shape, нарисованный user'ом, **должен быть виден AI**.
2. Любой shape, нарисованный AI, **должен быть виден user'у**.
3. Sessions переживают reload и cross-device (любой нарисованный shape на одном устройстве появляется на другом при подключении к той же комнате).
4. Стоимость AI context при чтении — управляемая (token-cheap projection).

Текущая архитектура (Phase 2.x) нарушает (1) и (3): наша модель `CanvasState{nodes,edges,groups}` whitelist'ит только пять `Node.kind` (`rect/ellipse/diamond/sticky/text`). Всё остальное (`draw/line/image/video/embed/bookmark/highlight`, freehand, и любые custom shapes) — silent-skip в `to-patch.ts:nodeToShape`. Эти фигуры существуют только локально через `persistenceKey` IndexedDB и не уезжают на backend → не видны AI, не реплицируются на другие клиенты.

**Phase 3.0 устраняет эту нелепость:** tldraw store становится **primary persistence**, наш domain layer — **read-only view + write-compiler** поверх него.

---

## 2. Ненавязчивое (что НЕ меняется)

- Single-binary бэкенд на Bun + Hono, profile dev/release/debug, портовая схема (8787/8788).
- Per-workspace storage в `~/.claude/projects/<slug-hash>/canvas/<room>.json` (один JSON-файл на комнату, как сейчас).
- WS-based realtime sync (один WS per client per room).
- Daemon-safe rooms ops (`flushIfDirty → stat → op`), durable op-log, replay/hello/truncated протокол из Phase 2.2.
- CLI machine interface: `didraw daemon/data/domain/rooms/...` — те же команды, те же payload'ы, тот же exit-code контракт. **Back-compat preserved** (см. §10).
- Token-cheap context API `GET /api/agent/context?since=N` — формат ответа эволюционирует, но HTTP-контракт остаётся.
- `@didraw/domain` package как SSOT для Role/ConnectionKind/LayoutMode/presets.
- ADR-0002 (children coords absolute) — переносится в новую модель без изменений.

---

## 3. Архитектурный invariant Phase 3.0

> **Single source of truth — tldraw store.** Domain — это view + write-compiler.

Из этого invariant'а выводится всё остальное:

- **Storage:** room envelope содержит `TLStoreSnapshot` (вся внутренняя структура tldraw как JSON) — не наш `CanvasState`.
- **Sync:** WS обменивается **`TLStoreChange` batches** (added/updated/removed records), не нашими `PatchOp`.
- **Backend без tldraw runtime:** хранит store как opaque JSON; ручной guard для критичных полей (`typeName`, `id`, `props`, `meta`); миграции схемы tldraw применяет **frontend** при `loadSnapshot()`.
- **AI write:** domain action (`define/connect/group/note/layout/delete`) — это **DSL**, не storage format. Backend компилирует action → `TLStoreChange[]` через лукап по `meta.didrawName`.
- **AI read:** view-builder сканирует `store.records`, фильтрует по `typeName === 'shape'`, проецирует в token-cheap JSON summary (нет геометрии в default mode).
- **Domain semantics** (`role / connectionKind / pinned / styleOwnedBy / didrawName`) — живут в `TLShape.meta`, не в отдельной структуре.

---

## 4. Envelope v3 (storage format)

```ts
export const ENVELOPE_SCHEMA_VERSION = 3;

export type EnvelopeV3 = {
  schemaVersion: 3;
  roomId: string;
  version: number;          // op-seq; bump'ится на каждый принятый StoreChangeBatch
  lastTouched: string;      // ISO
  elementCount: number;     // approx (records.length с typeName === 'shape')
  didraw: {
    didrawVersion: string;  // например "0.4.0" — для будущих миграций v3 → v4
    createdAt: string;      // ISO
  };
  store: TLStoreSnapshot;   // opaque tldraw snapshot: { schema, store: {[id]: TLRecord} }
  prompts: Prompt[];        // как сейчас (не tldraw shapes — отдельный канал AI↔user)
  opLog: StoreOpLogEntry[]; // rolling window, как Phase 2.2
};

export type TLStoreSnapshot = {
  schema: TLSchemaDef;      // tldraw schema descriptor (для migrate())
  store: Record<string, TLRecord>; // [recordId]: TLRecord — все shapes/page/document/...
};

export type StoreChangeBatch = {
  added: Record<string, TLRecord>;     // by id
  updated: Record<string, [TLRecord, TLRecord]>; // [oldRecord, newRecord]
  removed: Record<string, TLRecord>;   // by id (новое: храним удалённый record для replay-rollback)
};

export type StoreOpLogEntry = {
  ops: StoreChangeBatch;
  source: "ai" | "user";
  version: number;
  at: number;
  clientOpId?: string;
};
```

**Что выпадает из envelope (по сравнению с v2):**
- `canvas: { nodes, edges, groups }` — больше нет нашей `CanvasState`. Группы становятся либо `frame` shape'ами, либо meta-ассоциациями (см. §7).

**Что сохраняется:**
- `prompts` (AI↔user out-of-band канал, не visual).
- `opLog` (rolling window, `config.opLogMaxSize`, как Phase 2.2).
- Все header-поля (`roomId`, `version`, `lastTouched`, `elementCount`) — для CLI `didraw rooms list` без чтения целого файла.

---

## 5. WS sync (replace PatchOp с TLStoreChange)

**Текущий протокол (Phase 2.2):**
```
client → server: { kind: 'hello', lastVersion: N }
server → client: { kind: 'sync-ack' | 'replay' | 'truncated', ops: PatchOp[], version }
server ↔ client: { kind: 'patch', source, ops: PatchOp[], version, originClientId }
```

**Phase 3.0 протокол:**
```
client → server: { kind: 'hello', lastVersion: N }
server → client: { kind: 'sync-ack' | 'replay' | 'truncated', changes: StoreChangeBatch[], version }
server ↔ client: { kind: 'store-change', source, changes: StoreChangeBatch, version, originClientId }
server → client: { kind: 'prompt-created' | 'prompt-resolved' | 'prompt-removed' | 'ai-activity', ... }  // без изменений
```

**Семантика идентична** Phase 2.2: hello/replay/truncated/sync-ack пути сохраняются, меняется только payload-тип `ops` → `changes`. Логика `handleHello()` в `ws-protocol.ts` остаётся pure-function over RoomState.

**Frontend side:**
- Подписка через `editor.store.listen(change => ...)` — tldraw native API.
- Debounce batching (e.g. 50ms или `setTimeout(0)`) → отправка `{ kind: 'store-change', changes }`.
- Echo-guard: `originClientId === self.clientId` → ignore (как сейчас).
- Receive: `editor.store.applyDiff(changes)` — tldraw native idempotent apply.

**Echo-guard переходит** из `canvas/echo-guard.ts` в WS-handler: запись `clientOpId` ставится при отправке, проверяется при получении.

---

## 6. AI write path — компилятор в backend

CLI / MCP / любой AI-агент **по-прежнему** говорит на языке `domain action`:

```bash
didraw define backend --role service
didraw connect frontend backend --kind request
didraw group "Core" frontend backend
didraw layout --mode layered
didraw delete backend
```

POST `/api/domain` принимает тот же payload, что и Phase 2.1:
```json
{ "actions": [{ "kind": "define", "name": "backend", "role": "service" }] }
```

**Что меняется:** `apps/backend/src/domain/compile.ts` переписывается. На входе — action, на выходе — **`StoreChangeBatch`**, не `PatchOp[]`.

Логика compile (упрощённо):

| Action | Compile → TLRecord |
|--------|--------------------|
| `define { name, role }` | Lookup shape по `meta.didrawName === name`. Если есть — `updated` (merge style/meta); нет — `added` с `type: 'geo'`, `props.geo: 'rectangle'`, `props.richText: <name>`, `meta: { didrawName, role, ... }` |
| `connect { from, to, kind }` | Lookup `fromShape/toShape` по `didrawName`. Создать `type: 'arrow'` shape + два `arrow-binding` записи (terminal start/end). `meta: { connectionKind: kind, didrawName: <auto> }` |
| `group { name, members }` | Создать frame shape `type: 'frame'`, `meta: { didrawName, didrawIsGroup: true }`. Для каждого member shape — `updated` с `parentId` указывающим на frame.id |
| `note { name, text }` | Lookup/create shape `type: 'note'`, `props.richText: <text>`, `meta: { didrawName, role: 'note' }` |
| `layout { mode, scope }` | ELK работает над shape-bounds из store. Output → `updated[id] = [old, { ...old, x, y, ... }]` для каждого affected. Pin discipline (DRW-003 fix) сохраняется на уровне ELK pre-/post-process. |
| `delete { name }` | Lookup → `removed[id] = shape`. Cascade: все arrows с binding'ом к этому shape — тоже `removed`. Если был child frame'а — `parentId` сбросить (или: если frame пустой — оставить пустым). |

**Server flow для POST `/api/domain`:**
1. Validate actions (как Phase 2.1).
2. Compile → `StoreChangeBatch` (атомарно для всего batch'а).
3. Apply на in-memory room.store → bump version → push в opLog → publish через `bus.publish({ kind: 'store-change', ... })`.
4. Если actions содержат `layout` или `scope='affected'` → second-stage ELK writeback, опубликовать вторым batch'ем (как Phase 2.1).
5. Return JSON: `{ ok: true, version: N, changeCount: M }`.

**Лукап `findShapeByDidrawName(store, name)`** делается линейным scan'ом `store.records` (O(N)). Для production rooms (1k+ shapes) — кешировать в `room.didrawIndex: Map<name, shapeId>`, инвалидировать при apply. **MVP:** linear scan (room sizes сейчас < 100 shapes).

---

## 7. Container model: frame + meta.didrawIsGroup

Текущий `Group` (с `children: ElementId[]`) — наша концепция. tldraw native эквивалент — **`frame` shape** (визуальный контейнер с заголовком и bbox).

**Решение Phase 3.0:** domain `group { name, members }` компилируется в:
- `frame` shape (`type: 'frame'`, `props.name: <label>`, `meta: { didrawName, didrawIsGroup: true }`)
- Каждый member shape: `parentId: <frame.id>` — это tldraw native parent-child.

**Children list получается** обратным запросом: `store.records.values().filter(s => s.parentId === frameId)`.

**Преимущества:**
- Native rendering (frame визуально подсвечивается, draggable as unit).
- Tldraw обеспечивает invariant: при move frame'а дети двигаются с ним.
- Удаление frame'а: tldraw native cascade или ручной (по нашему выбору — рекомендую ручной cascade в `delete`-action).

**Container coords:** ADR-0002 (children absolute) **продолжает действовать**. Tldraw store хранит children с **absolute** coords (X/Y page-level), parentId — только ссылка. Это совпадает с нашим текущим инвариантом.

---

## 8. AI read path — view-builder (cheap projection)

`GET /api/agent/context?since=N`:

```ts
type DomainView = {
  version: number;
  diffSince?: number; // если since query задан и есть diff
  elements: Array<{
    id: string;                   // didrawName (если есть) или shape.id (fallback)
    type: 'shape' | 'connection' | 'group' | 'note';
    label?: string;               // из richText → plain text
    role?: Role;                  // из meta.role
    connectionKind?: ConnectionKind; // для arrows
    from?: string;                // arrow endpoint (didrawName или id)
    to?: string;
    children?: string[];          // для frame: список didrawName детей
    pinned?: boolean;
  }>;
  pendingPrompts?: Prompt[];      // как сейчас
};
```

**Что отсутствует в default response:** x/y/w/h/rotation, props.color/fill/dash, props.points (draw shapes), richText raw struct, bindings raw, schema внутренности.

**Opt-in `?include=geometry`** возвращает доп. поле `bounds: {x,y,w,h}` для каждого element. Не дефолт.

**Token budget:** target ≤8KB JSON для 100 elements. Замер — часть test plan.

**Smart projection (subagent на Sonnet/Haiku) — out of scope Phase 3.0.** Roadmap'd в Phase 3.1: MCP tool `describe_canvas` который вызывает subagent с full `TLStoreSnapshot` + render и возвращает human-language description. Не нужен для MVP двусторонней синхронизации.

---

## 9. Migration v2 → v3 (lazy, lossless)

**Trigger:** при `rooms.load(id)` парсится envelope. Если `schemaVersion === 2` → запустить migrator → save as v3.

**Migration алгоритм:**

```ts
function migrateV2ToV3(env: EnvelopeV2): EnvelopeV3 {
  const store: Record<string, TLRecord> = {};
  // 1. document + page records (tldraw boilerplate)
  store['document:document'] = tldrawDefaultDocument();
  store['page:page'] = tldrawDefaultPage();

  // 2. nodes → shapes
  const nameToShapeId = new Map<string, string>();
  for (const n of env.canvas.nodes) {
    const shapeId = `shape:${randomId()}`;
    nameToShapeId.set(n.id, shapeId); // n.id уже e_<name>, используем как name
    store[shapeId] = nodeToTLShape(n, shapeId); // kind→type, label→richText, style→props
  }

  // 3. groups → frame shapes
  for (const g of env.canvas.groups) {
    const frameId = `shape:${randomId()}`;
    nameToShapeId.set(g.id, frameId);
    store[frameId] = groupToFrameShape(g, frameId);
    // set parentId for children
    for (const childName of g.children) {
      const childId = nameToShapeId.get(childName);
      if (childId && store[childId]) {
        store[childId] = { ...store[childId], parentId: frameId };
      }
    }
  }

  // 4. edges → arrow shapes + bindings
  for (const e of env.canvas.edges) {
    const arrowId = `shape:${randomId()}`;
    store[arrowId] = edgeToArrowShape(e, arrowId, nameToShapeId);
    // arrow bindings
    if (e.from.kind === 'node') {
      store[`binding:${randomId()}`] = arrowBinding(arrowId, nameToShapeId.get(e.from.id), 'start');
    }
    if (e.to.kind === 'node') {
      store[`binding:${randomId()}`] = arrowBinding(arrowId, nameToShapeId.get(e.to.id), 'end');
    }
  }

  return {
    schemaVersion: 3,
    roomId: env.roomId,
    version: env.version, // continue same op-seq
    lastTouched: env.lastTouched,
    elementCount: env.elementCount,
    didraw: { didrawVersion: '0.4.0', createdAt: new Date().toISOString() },
    store: { schema: tldrawSchemaSnapshot(), store },
    prompts: env.prompts,
    opLog: [], // не мигрируем — заводим новый rolling window под новый формат
  };
}
```

**Lossless guarantees:**
- `meta.didrawName` сохраняется для каждого мигрированного shape → CLI `didraw define backend` после migration попадает в тот же shape (upsert).
- `meta.role/connectionKind` сохраняются из существующих `meta` Node/Edge.
- `meta.pinned + meta.position` сохраняются (pin discipline продолжает работать).
- ADR-0002 absolute coords — соблюдается.

**Lossy parts (acceptable):**
- `opLog` обнуляется. Connected clients после migration получат **`truncated`** при hello-reconnect → forced full-fetch (это норма для Phase 2.2 truncated path).
- `style.color` маппинг tldraw enum (`red/blue/...`) сужает гамму, если в v2 был free-form hex; в практике v2 хранил tldraw enum-значения, потерь нет.

**Migration commit point:** мигрировать сразу в `rooms.load()`, save as v3 одним атомарным write (tmp-file + rename, как существующий `persistence.ts:writeAtomic`); при следующем client connect клиент получит уже-v3 snapshot. Backup исходного v2-файла — `<room>.v2.bak` рядом, удаляется через 7 дней. Если migrator падает — `rooms.load()` возвращает error, room не открывается; backup гарантирует возможность ручного rollback.

---

## 10. CLI back-compat (full preserve)

Все команды Phase 2.1 продолжают работать **без изменений CLI side**:

```
didraw define <name> --role <role>
didraw connect <from> <to> --kind <kind>
didraw group <name> <m1> <m2> ...
didraw note <name> --text "..."
didraw layout [--mode layered|free] [--scope all|affected]
didraw delete <name>
didraw apply --file actions.json
didraw context [--since N]
didraw rooms list/create/restore/delete/import/export/...
didraw daemon start/stop/status
didraw data dir
didraw version
```

Payload `/api/domain` идентичен. Response format `/api/domain` (`{ ok, version, ... }`) и `/api/agent/context` (с обновлённой view shape, см. §8) — описаны в spec явно, CLI парсит как раньше.

**Что ломается** (документируется в CHANGELOG breaking section):
- `/api/patch` — устаревший raw transport, **удаляется**. AI должен использовать `/api/domain` (как мы уже требовали в Phase 2.1).
- `GET /api/state` возвращает new shape: `{ store: TLStoreSnapshot, version, prompts, ... }` вместо `{ canvas, version, prompts }`. CLI `didraw rooms export` обновляется (frontend получает store, выгружает наш envelope v3).
- WS `kind: 'patch'` сменился на `kind: 'store-change'`. Все клиенты должны быть на одной версии (frontend bundled с backend → embedded UI всегда совместима; only CLI потребляет HTTP не WS).

---

## 11. File structure (после Phase 3.0)

Маркеры: **NEW** — создать; **DEL** — удалить; **CHG** — переписать/обновить; без маркера — без изменений.

```
apps/backend/src/
  types.ts                    CHG  убрать CanvasState/Node/Edge/Group/PatchOp; оставить RoomState/WsMessage/Prompt
  store-types.ts              NEW  TLRecord, TLStoreSnapshot, StoreChangeBatch, StoreOpLogEntry
  envelope.ts                 CHG  v3 only; v2 parser → migrate-v2.ts
  migrate-v2.ts               NEW  одноразовая lazy миграция в rooms.load()
  store-ops.ts                NEW  applyStoreChanges, findShapeByDidrawName (replaces patch.ts)
  patch.ts                    DEL  applyPatch → store-ops.ts
  domain/supported-kinds.ts   DEL  tldraw schema валидирует
  ws-protocol.ts              CHG  handleHello over StoreChangeBatch (логика идентична Phase 2.2)
  ws.ts, rooms.ts, persistence.ts  работают with in-memory store, без концептуальных правок
  layout-engine.ts            CHG  читает x/y/w/h из shape.props.* вместо Node
  domain/compile.ts           CHG  action[] → StoreChangeBatch (новый signature)
  domain/context.ts           CHG  view-builder over store.records; opt-in geometry
  domain/layout.ts            CHG  ELK wrapper над store-bounds; pin discipline preserved
  domain/layout-postprocess.ts, domain/validate.ts, domain/types.ts  без изменений
  routes/domain.ts            CHG  compile → applyStoreChanges → publish
  routes/context.ts           CHG  возвращает new view shape (см. §8)
  routes/state.ts             CHG  { store: TLStoreSnapshot, version, prompts }
  routes/patch.ts             DEL  устаревший raw transport (deprecated в 2.1)
  routes/rooms.ts, prompts.ts, layout.ts, health.ts, version.ts, viewport.ts  без изменений

apps/frontend/src/
  App.tsx                     CHG  editor.store.listen → WS send; WS recv → editor.store.applyDiff;
                                   удаляется replaceCanvasFromState/diff loop; удаляется persistenceKey
  transport/ws.ts             CHG  store-change subscribe/send/apply
  canvas/to-patch.ts          DEL
  canvas/from-canvas-state.ts DEL
  canvas/kinds.ts             DEL
  canvas/echo-guard.ts        DEL  (8 строк, переезжает в transport/ws.ts)
  canvas/role-render.ts, richtext.ts, camera-persist.ts  без изменений
  canvas/id-prefix.ts         CHG  helper findShapeByDidrawName(store, name); убрать e_<name> кодировку
  canvas/mermaid-import.ts    CHG  editor.createShapes напрямую (без нашего diff)
  chrome/, prompts/, state/, styles.css   минимальные правки (отвязка от старой state.shape)

packages/
  didraw-domain/              без изменений (SSOT presets)
  didraw-client/              CHG  типы для context view shape; HTTP API без изменений
  didraw-cli/                 без изменений public API (см. §10)
```

---

## 12. Backend без tldraw runtime — ручной guard

Backend хранит `TLRecord` как JSON и **не** импортирует `@tldraw/store` / `@tldraw/tlschema` / `tldraw`. Причины:

- Tldraw — frontend SDK; зависимости (React DOM, ProseMirror, canvas-render) бесполезны на сервере и взрывают bundle (`bun build --compile`).
- Schema migrations выполняются frontend'ом на `loadSnapshot()`. Это native tldraw path: при первой загрузке клиента он мигрирует store до своей текущей schema, отправляет `store-change` → backend получает уже-мигрированный snapshot и записывает в envelope.

**Что валидирует backend (минимум):**
- `typeof record.id === 'string'` и совпадает с key.
- `typeof record.typeName === 'string'`.
- `props` — object или undefined.
- `meta` — object или undefined.
- Для `applyChanges`: `added/updated/removed` keys consistent (нет id одновременно в added и removed).

**Что не валидирует:**
- Внутренности `props` (tldraw schema знает лучше).
- Версия schema (frontend обновит при load).
- Геометрию (это форма; нет проверок что arrow корректно biased и т.д.).

**Trade-off:** backend «слепой» к семантике tldraw shapes (не знает, что arrow — это связь). Это компенсируется `meta.didrawName / meta.connectionKind / meta.role` — domain semantics живут в meta, и view-builder/compile.ts читают только meta + минимум props (label, parentId).

---

## 13. Pin discipline + layout (Phase 3.0 preserved)

Pin discipline (DRW-003 fix) **переносится** в новую модель один-к-одному:
- User pinned position: `meta.pinned === true`, `meta.position: {x,y}`.
- Layout `apps/backend/src/domain/layout.ts`:
  1. Прочитать shape bounds из `store.records` (filter `typeName === 'shape'`).
  2. ELK input: для pinned — pre-set `x/y` + node-fixed constraint.
  3. ELK output → positions.
  4. Post-process: restore pinned `x/y` (не двигаем).
  5. Displacement при overlap (DRW-003): non-pinned, пересекающие pinned bbox, смещаются вправо/вниз.
  6. Output → `StoreChangeBatch.updated[shapeId] = [oldShape, {...oldShape, x, y}]`.
- Group bbox writeback (DRW-004): для `frame` shape пишем `props.w/props.h` из ELK output (frame в tldraw имеет explicit bbox).
- ADR-0002 (children absolute) preserved: frame stores absolute x/y, children тоже хранят absolute x/y; `parentId` — только ссылка.

`@didraw/domain` package: `Role / ConnectionKind / LayoutMode / presets` сохраняются без изменений. Phase 3.0 их использует через `meta.role / meta.connectionKind / meta.layoutMode`.

---

## 14. Tests (high-level)

**Backend (`apps/backend/tests/`):**
- `envelope-v3.test.ts` — round-trip serialize/parse; rejection malformed; backward-parser for v2 (in migrate-v2 only).
- `migrate-v2-to-v3.test.ts` — lossless для типичных v2 envelope'ов (nodes/edges/groups/pinned/role).
- `store-ops.test.ts` — applyStoreChanges idempotent; conflict detection (added+removed same id); echo-guard via clientOpId.
- `domain-compile.test.ts` — каждое action → expected StoreChangeBatch (define/connect/group/note/layout/delete).
- `domain-context.test.ts` — view-builder token budget (≤8KB для 100 shapes); фильтр геометрии.
- `layout-pin-discipline.test.ts` — переписан на новую модель (тесты из 0.3.2 переносятся 1:1 по семантике).
- `ws-protocol.test.ts` — handleHello over StoreChangeBatch op-log (логика идентична Phase 2.2).
- `rooms.test.ts` — без изменений.

**Frontend (`apps/frontend/tests/`):**
- `ws-bridge.test.ts` — editor.store.listen → WS send (debounce verified); WS recv → editor.store.applyDiff (idempotent).
- `migration-load.test.ts` — frontend ловит v2-migrated snapshot, loadSnapshot succeeds, schema OK.

**Domain (`packages/didraw-domain`):** без изменений.
**Client (`packages/didraw-client`):** обновить типы для context shape; smoke tests.
**CLI (`packages/didraw-cli`):** integration tests — те же команды, новый wire format под капотом; tests должны проходить без modify (verify back-compat).

**Migration smoke:** прогнать существующую v2 room через migrator → load в frontend → проверить, что все shapes отрендерились + все edges связаны + groups → frames + pinned остался pinned.

**Bidirectional viz (acceptance):**
- User рисует freehand в browser A → перезагружает → freehand на месте.
- User рисует freehand в browser A → browser B (та же комната, second tab/device) → freehand виден.
- AI вызывает `didraw context` после user freehand → видит element с `type: 'shape'`, `id: shape:<auto>`, нет `didrawName` (т.к. user не дал) → AI может ссылаться по id.

Target: 290+ tests (как Phase 2.2 + новые).

---

## 15. Open questions / явно отложено

- **Custom shapes registry** (для AI-specific визуала, например «cluster» с особым рендером) — Phase 3.1.
- **Smart AI projection** (subagent на Sonnet, render snapshot → описание) — Phase 3.1.
- **Real-time cursors / user presence** — Phase 4.x.
- **Viewport sync** (cross-device camera position) — Phase 4.x (сейчас `camera-persist.ts` хранит локально).
- **Конфликт-резолюция при одновременном edit двумя клиентами** — Phase 3.0 принимает «last write wins» (tldraw native semantics; op-log сохраняет историю, но автоматического merge нет).
- **Размер snapshot'а на диске** (1k+ shapes, freehand с тысячами points → MB-уровень JSON) — мониторим в Phase 3.x, если станет проблемой → переход на binary format / sqlite.

---

## 16. Acceptance criteria (Phase 3.0 done = MVP двусторонней синхронизации)

1. ✅ User рисует **любой** tldraw shape (freehand draw / line / image / video / embed / bookmark / highlight / geo / arrow / note / text / frame). Это уезжает на backend, реплицируется на other connected clients, появляется в `GET /api/agent/context` view с минимум `id + type` (label/role — если есть).
2. ✅ AI вызывает `didraw define backend --role service` → shape создаётся в tldraw store → виден user'у в browser.
3. ✅ Session pickup: user рисует, закрывает browser, открывает через час → всё на месте. Открывает в другом browser/device на той же комнате → всё там.
4. ✅ Существующие v2 rooms мигрируются автоматически без потери domain semantics (didrawName, role, connectionKind, pinned).
5. ✅ CLI команды Phase 2.1 работают без изменений на стороне CLI (verified тестами).
6. ✅ Token-cheap context API остаётся ≤8KB для 100 elements.
7. ✅ Pin discipline + layout (Phase 0.3.2 фиксы) работают на новой модели.

**Release tag:** `0.4.0` (MINOR per SemVer pre-1.0 — это breaking storage format и breaking WS protocol, но pre-1.0 позволяет MINOR).

---

## 17. Refs

- Driver memory: `feedback-product-vision-bidirectional` (от 2026-05-17).
- Backlog task: DRW-028 — Phase 3.0 brainstorm (To Do, priority medium).
- Previous spec: `docs/superpowers/specs/2026-05-16-di-draw-phase2-2-sync-hardening-design.md` (Phase 2.2 — shipped 0.3.0).
- ADR-0002: `docs/decisions/0002-group-children-coordinates.md` — absolute coords (preserved).
- Tldraw editor docs (REQUIRED reading before plan): https://tldraw.dev/docs/editor, https://tldraw.dev/docs/persistence, https://tldraw.dev/docs/store
