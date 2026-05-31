# Stage 1 — Mermaid Import Productization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** При импорте mermaid создавать НАШИ v2-объекты (schema-frame + geo-узлы с identity + schema-container subgraph'ы + elbow-стрелки + стили) на координатах валидированной dagre/elk-раскладки, минуя backend-ELK.

**Architecture:** Frontend снимает `{mermaidId → {x,y,w,h}}` из `@tldraw/mermaid` `createMermaidDiagram` через публичный хук `blueprintRender.mapNodeToRenderSpec` (на offscreen-странице, throwaway-shapes удаляются), шлёт карту в `POST /api/schema/create` как `positionsOverride`. Backend парсит тот же mermaid (единственный v2-builder), строит наши объекты, затем применяет инъецированные позиции (parent-relative) + fit-to-content sizing вместо запуска ELK; после — существующий `runAndBroadcastAnchors` (port-lock + elbow lever). Инкрементально: 1a объекты+позиции+sizing, 1b elbow-рычаг, 1c стили+локализация+дефолты.

**Tech Stack:** Bun + Hono backend, tldraw 5.0.0 + Vite frontend, `@shemma/domain` shared types, `@tldraw/mermaid@5.0.0`, ELK (не используется на import-пути), bun test.

**Spec:** `docs/superpowers/specs/2026-05-29-autolayout-rebuild-stage1-import-productization-design.md`

**Baseline:** ветка `feature/autolayout-rebuild` @ `a05e2a1`.

**Review policy (per CLAUDE.md):** phase-end only. Implementer-subagent коммитит каждую задачу; визуальные чекпойнты (Task 6/9/12) делает контроллер сам через chrome-MCP (не доверять subagent-скриншотам). В конце Stage 1 — code-simplifier по diff'у + единый spec+quality review.

---

## File Structure

| Файл | Ответственность | Действие |
|---|---|---|
| `packages/shemma-domain/src/schema-meta.ts` | контракт запроса: `NodePos`, `positionsOverride` | Modify |
| `apps/backend/src/domain/schema/mermaid-parser.ts` | экспорт `idMap` в `ParseResult` | Modify |
| `apps/backend/src/domain/schema-import-positions.ts` | **NEW** pure builder: позиции (parent-relative) + sizing → `StoreChangeBatch` | Create |
| `apps/backend/src/domain/schema-import-positions.test.ts` | unit-тесты builder'а | Create |
| `apps/backend/src/routes/schema.ts` | branch handler'а: `positionsOverride` → apply-positions вместо `runLayout` | Modify |
| `apps/backend/src/routes/_anchors.ts` | проброс `midpointDistribution` | Modify |
| `apps/backend/src/domain/midpoints.ts` | swapOrder-aware распределение (R2) | Modify |
| `apps/frontend/src/canvas/mermaid-import.ts` | `harvestMermaidPositions` + wiring dagre/elk → harvest+backend; `positionsOverride` в `createSchemaViaBackend` | Modify |

**Команды тестов:** backend/domain — `bun test apps/backend/src/...` (или `bun run test` из корня для всего пайплайна). Frontend — `bun test --cwd apps/frontend src`. tsc — `bun run --cwd apps/frontend tsc` (фронт) / `bunx tsc --noEmit` (backend, если настроено).

---

## Task 0: Spike — harvest-hook на sample-2 (controller, без коммита)

**Цель:** до кода подтвердить, что `mapNodeToRenderSpec` снимает `{mermaidId → {x,y,w,h}}` для всех узлов + subgraph'ов, ключи = mermaid id, subgraph'ы НЕ вложены, и хук не ломает валидированный elk-layout. Делает **контроллер** (chrome-MCP), не subagent.

- [ ] **Step 1: Поднять доску.** `bun run dev` из корня → vite :5173, открыть space `di-draw` → room `a-engine-compare` (живой WS tab). Версия-бейдж `0.28.0-N-g<sha>-dirty`.

- [ ] **Step 2: Внедрить harvest-проб в браузере.** Через chrome-devtools `evaluate_script` выполнить импорт sample-2 с no-op хуком, собирающим позиции:

```js
// в консоли страницы (editor доступен глобально или через window.__editor — проверить)
const src = `<содержимое apps/backend/tests/fixtures/sample-2-mermaid.md без ```-обёрток>`;
window.__harvest = {};
const mod = await import("@tldraw/mermaid");
await mod.createMermaidDiagram(window.__editor, src, {
  mermaidConfig: { layout: "elk" },
  blueprintRender: {
    // tldraw 5.0.0: mapper receives a WRAPPER { nodeId, node, diagramKind, kind } —
    // NOT a flat node. Geometry is on input.node; id on input.nodeId.
    mapNodeToRenderSpec: (input) => {
      const n = input.node;
      window.__harvest[input.nodeId] = { x: n.x, y: n.y, w: n.w, h: n.h, kind: n.kind, parentId: n.parentId };
      return undefined; // default render preserved
    },
  },
});
console.log("HARVEST", Object.keys(window.__harvest).length, JSON.stringify(window.__harvest, null, 2));
```

- [ ] **Step 3: Проверить вердикты (HARD GATE — решает источник harvest для Task 5):**
  - (a) собрано **18 node-id**, ключи = literal mermaid id (не opaque `shape:xxx`);
  - (b) **КЛЮЧЕВОЙ gate:** приходят ли **subgraph'ы** через mapper как entries с `node.kind==='subgraph'` и **ненулевыми `w/h`**? Subgraph'ы материализуются из `blueprint.groups` через `editor.groupShapes` — могут НЕ прийти как node-entries. Посчитать, сколько из 4 subgraph-id присутствуют с w/h;
  - (c) **R8:** subgraph'ы НЕ вложены — ни у одного subgraph-узла `parentId` не равен другому subgraph-id;
  - (d) leaf-узлы внутри subgraph'а имеют `parentId === <subgraph mermaid id>` (нужно для parent-relative в 1a);
  - (e) доска визуально идентична валидированному elk-результату из A (хук ничего не сломал).

- [ ] **Step 4: Зафиксировать РЕШЕНИЕ по источнику harvest (влияет на Task 5):**
  - (b) ✅ subgraph'ы приходят с w/h → **harvest через hook** (Task 5 §3b primary).
  - (b) ✗ subgraph'ов нет среди node-entries / без w/h → **harvest через deep-import** `parseFlowchartLayout`+`flowchartToBlueprint` (Task 5 §3b alt: `blueprint.nodes` + `blueprint.groups`, оба keyed by mermaid id, БЕЗ scratch-page и throwaway). Записать выбранный вариант — это снимает развилку §9.1 спеки.
  - (c) ✗ subgraph'ы вложены → СТОП, эскалировать (одноуровневая модель не покрывает; nested-guard в Task 5 §3b должен бросить).
  - **Кода не коммитим** — это валидация.

---

## Task 1: `idMap` в `ParseResult` (backend)

**Files:**
- Modify: `apps/backend/src/domain/schema/mermaid-parser.ts:45-71` (тип), `:361` (return)
- Test: `apps/backend/src/domain/schema/mermaid-parser.test.ts` (существующий suite — добавить кейс)

- [ ] **Step 1: Failing test.** Добавить в существующий test-файл парсера:

```ts
test("ParseResult exposes idMap mermaidId→NodeId", () => {
  const res = parseMermaidFlowchart("flowchart LR\n  api[API Gateway] --> db[DB]");
  if (!res.ok) throw new Error("expected ok parse");
  // idMap keyed by raw mermaid identifier
  expect(res.idMap.get("api")).toBeDefined();
  expect(res.idMap.get("db")).toBeDefined();
  // value is the resolved NodeId (slug-<6char> form), distinct per node
  expect(res.idMap.get("api")).toMatch(/-[a-z0-9]{6}$/);
  expect(res.idMap.get("api")).not.toEqual(res.idMap.get("db"));
});
```

- [ ] **Step 2: Run — expect FAIL** (`res.idMap` undefined): `bun test apps/backend/src/domain/schema/mermaid-parser.test.ts -t "exposes idMap"`. Expected: FAIL (`idMap` is undefined / property missing).

- [ ] **Step 3: Implement.** В `ParseResult` (success-вариант, после `subgraphStyles`) добавить поле:

```ts
      subgraphStyles: Map<string, MermaidNodeStyle>;
      /** mermaid raw identifier → resolved NodeId. For position-injection (Stage 1). */
      idMap: Map<string, NodeId>;
```

В return на `:361`:

```ts
  return { ok: true, actions, direction, nodeStyles, nodeStylesByNodeId, subgraphStyles, idMap };
```

- [ ] **Step 4: Run — expect PASS.** `bun test apps/backend/src/domain/schema/mermaid-parser.test.ts -t "exposes idMap"`. Затем весь suite парсера зелёный.

- [ ] **Step 5: Commit.**

```bash
git add apps/backend/src/domain/schema/mermaid-parser.ts apps/backend/src/domain/schema/mermaid-parser.test.ts
git commit -m "feat(backend): expose idMap (mermaidId->NodeId) in ParseResult for position-injection"
```

---

## Task 2: `NodePos` + `positionsOverride` в контракте (domain)

**Files:**
- Modify: `packages/shemma-domain/src/schema-meta.ts:7-14` (новый тип), `:77-79` (`SchemaCreateRequest`)

- [ ] **Step 1: Implement type.** В `schema-meta.ts` добавить тип и расширить raw-вариант запроса. Текущий union:

```ts
export type SchemaCreateRequest =
  | { label: string; raw: string }
  | { label: string; actions: import("./schema-actions").SchemaAction[] };
```

Заменить на:

```ts
/** Позиция узла/контейнера для Stage-1 import position-injection.
 *  Координаты — layout-flat (как отдаёт mermaid blueprint); backend сам
 *  конвертирует детей subgraph'а в parent-relative. w/h обязательны для
 *  subgraph-ключей (для sizing контейнера), опциональны для leaf. */
export type NodePos = { x: number; y: number; w?: number; h?: number };

export type SchemaCreateRequest =
  | { label: string; raw: string; positionsOverride?: Record<string, NodePos> }
  | { label: string; actions: import("./schema-actions").SchemaAction[] };
```

> `Record<string, NodePos>` keyed by **mermaid id** (НЕ NodeId — фронт NodeId не знает, см. spec §2.1/§4.2).

- [ ] **Step 2: Typecheck.** `bunx tsc --noEmit -p packages/shemma-domain` (или корневой tsc). Expected: чисто (новый optional-field не ломает существующих вызовов).

- [ ] **Step 3: Commit.**

```bash
git add packages/shemma-domain/src/schema-meta.ts
git commit -m "feat(domain): add NodePos + positionsOverride to SchemaCreateRequest (mermaid-id-keyed)"
```

---

## Task 3: `applyImportPositions` pure builder + unit-тесты (backend)

Сердце 1a. Чистая функция: на вход — store с уже созданными shape'ами + карты резолва + позиции; на выход — `StoreChangeBatch`, пишущий parent-relative позиции, leaf/container w/h, и frame w/h (union). Не трогает arrows (их геометрия — производная bindings + anchors).

**Files:**
- Create: `apps/backend/src/domain/schema-import-positions.ts`
- Test: `apps/backend/src/domain/schema-import-positions.test.ts`

- [ ] **Step 1: Failing test.** Создать тест-файл:

```ts
import { describe, expect, test } from "bun:test";
import { applyImportPositions } from "./schema-import-positions";
import type { TLRecord, TLStoreSnapshot } from "../store-types";

function rec(id: string, type: string, parentId: string, props: Record<string, unknown> = {}): TLRecord {
  return { id, typeName: "shape", type, x: 0, y: 0, parentId, props: { w: 100, h: 50, ...props }, meta: {} } as TLRecord;
}
function store(records: TLRecord[]): TLStoreSnapshot {
  const m: Record<string, TLRecord> = {};
  for (const r of records) m[r.id] = r;
  return { store: m } as unknown as TLStoreSnapshot;
}

describe("applyImportPositions", () => {
  test("top-level leaf written at flat coord (frame-relative); frame sized to union + pad", () => {
    const frameId = "shape:frame";
    const leaf = rec("shape:a", "geo", frameId);
    const s = store([rec(frameId, "frame", "page:page", { w: 640, h: 480 }), leaf]);

    const batch = applyImportPositions({
      store: s,
      frameId,
      positions: { a: { x: 50, y: 30, w: 120, h: 60 } },
      leafShapeIdByMermaidId: new Map([["a", "shape:a"]]),
      containerShapeIdByMermaidId: new Map(),
      subgraphMermaidIdByMemberMermaidId: new Map(),
      framePad: 40,
    });

    const leafUpd = batch.updated["shape:a"]?.[1] as TLRecord;
    expect(leafUpd.x).toBe(50);
    expect(leafUpd.y).toBe(30);
    expect((leafUpd.props as { w: number }).w).toBe(120);

    const frameUpd = batch.updated[frameId]?.[1] as TLRecord;
    // union right = 50+120=170; bottom = 30+60=90; + pad 40
    expect((frameUpd.props as { w: number }).w).toBe(170 + 40);
    expect((frameUpd.props as { h: number }).h).toBe(90 + 40);
    // frame position unchanged (only w/h written)
    expect(frameUpd.x).toBe(0);
  });

  test("child of subgraph converted to parent-relative; container sized from subgraph w/h", () => {
    const frameId = "shape:frame";
    const container = rec("shape:sg", "schema-container", frameId, { w: 300, h: 200 });
    const child = rec("shape:c", "geo", "shape:sg");
    const s = store([rec(frameId, "frame", "page:page", { w: 640, h: 480 }), container, child]);

    const batch = applyImportPositions({
      store: s,
      frameId,
      positions: {
        SG: { x: 200, y: 100, w: 260, h: 160 }, // subgraph flat
        c: { x: 220, y: 130, w: 80, h: 40 },    // child flat (inside subgraph)
      },
      leafShapeIdByMermaidId: new Map([["c", "shape:c"]]),
      containerShapeIdByMermaidId: new Map([["SG", "shape:sg"]]),
      subgraphMermaidIdByMemberMermaidId: new Map([["c", "SG"]]),
      framePad: 40,
    });

    const childUpd = batch.updated["shape:c"]?.[1] as TLRecord;
    // parent-relative: 220-200=20, 130-100=30
    expect(childUpd.x).toBe(20);
    expect(childUpd.y).toBe(30);

    const contUpd = batch.updated["shape:sg"]?.[1] as TLRecord;
    expect(contUpd.x).toBe(200); // container frame-relative = subgraph flat
    expect(contUpd.y).toBe(100);
    expect((contUpd.props as { w: number }).w).toBe(260); // from harvested subgraph w
    expect((contUpd.props as { h: number }).h).toBe(160);
  });

  test("unmatched mermaid id reported, not silently dropped", () => {
    const frameId = "shape:frame";
    const s = store([rec(frameId, "frame", "page:page", { w: 640, h: 480 })]);
    const res = applyImportPositions({
      store: s,
      frameId,
      positions: { ghost: { x: 1, y: 1, w: 1, h: 1 } },
      leafShapeIdByMermaidId: new Map(),
      containerShapeIdByMermaidId: new Map(),
      subgraphMermaidIdByMemberMermaidId: new Map(),
      framePad: 40,
    });
    expect(res.unmatched).toContain("ghost");
  });

  test("arrows are never positioned (no arrow ids in maps → no arrow updates)", () => {
    const frameId = "shape:frame";
    const arrow = rec("shape:arr", "arrow", frameId);
    const s = store([rec(frameId, "frame", "page:page", { w: 640, h: 480 }), arrow]);
    const batch = applyImportPositions({
      store: s, frameId, positions: {},
      leafShapeIdByMermaidId: new Map(), containerShapeIdByMermaidId: new Map(),
      subgraphMermaidIdByMemberMermaidId: new Map(), framePad: 40,
    });
    expect(batch.updated["shape:arr"]).toBeUndefined();
  });
});
```

> `applyImportPositions` возвращает `StoreChangeBatch & { unmatched: string[] }` (batch + список несопоставленных mermaid id).

- [ ] **Step 2: Run — expect FAIL** (module not found): `bun test apps/backend/src/domain/schema-import-positions.test.ts`. Expected: FAIL (cannot find `./schema-import-positions`).

- [ ] **Step 3: Implement.** Создать `apps/backend/src/domain/schema-import-positions.ts`:

```ts
// apps/backend/src/domain/schema-import-positions.ts
//
// Stage 1: apply mermaid-blueprint positions to freshly-built v2 schema shapes
// WITHOUT running ELK. Writes parent-relative child coords, leaf/container w/h,
// and frame w/h (union of top-level bounds + pad). Pure: maps in, batch out.
//
// Coordinate model (spec §2.2):
//  - blueprint coords are layout-FLAT.
//  - top-level items (parented to frame): flat coords ARE frame-relative (frame's
//    own page position carries the global offset) → written as-is.
//  - children of a subgraph (parented to a schema-container): converted to
//    container-relative via (childFlat - subgraphFlat).
//  - frame.x/y preserved; only frame.props.w/h recomputed.

import type { NodePos } from "@shemma/domain";
import type { StoreChangeBatch, TLRecord, TLStoreSnapshot } from "../store-types";

export type ApplyImportPositionsInput = {
  store: TLStoreSnapshot;
  frameId: string;
  /** keyed by mermaid id (leaf + subgraph). */
  positions: Record<string, NodePos>;
  /** mermaid id → leaf geo shape.id */
  leafShapeIdByMermaidId: Map<string, string>;
  /** subgraph mermaid id → schema-container shape.id */
  containerShapeIdByMermaidId: Map<string, string>;
  /** member mermaid id → its subgraph mermaid id (for parent-relative conversion) */
  subgraphMermaidIdByMemberMermaidId: Map<string, string>;
  /** padding added to the frame around its content union. */
  framePad: number;
};

export type ApplyImportPositionsResult = StoreChangeBatch & { unmatched: string[] };

function readNum(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

export function applyImportPositions(input: ApplyImportPositionsInput): ApplyImportPositionsResult {
  const {
    store, frameId, positions,
    leafShapeIdByMermaidId, containerShapeIdByMermaidId,
    subgraphMermaidIdByMemberMermaidId, framePad,
  } = input;

  const updated: Record<string, [TLRecord, TLRecord]> = {};
  const unmatched: string[] = [];

  // Track top-level (frame-relative) bounds for frame sizing.
  let maxRight = 0;
  let maxBottom = 0;
  const noteTopLevel = (x: number, y: number, w: number, h: number) => {
    if (x + w > maxRight) maxRight = x + w;
    if (y + h > maxBottom) maxBottom = y + h;
  };

  const writeShape = (
    shapeId: string,
    x: number, y: number,
    w?: number, h?: number,
  ) => {
    const old = store.store[shapeId] as TLRecord | undefined;
    if (!old) { return; }
    const newRec: TLRecord = { ...old, x, y };
    if (w !== undefined || h !== undefined) {
      const oldProps = (old.props ?? {}) as Record<string, unknown>;
      const newProps: Record<string, unknown> = { ...oldProps };
      if (w !== undefined) newProps.w = w;
      if (h !== undefined) newProps.h = h;
      // measured-bounds discipline (DRW-174): nullify growY so written h sticks.
      if ("growY" in oldProps) newProps.growY = 0;
      (newRec as { props?: Record<string, unknown> }).props = newProps;
    }
    updated[shapeId] = [old, newRec];
  };

  for (const mermaidId in positions) {
    const pos = positions[mermaidId];

    // Container (subgraph) — frame-relative, w/h required.
    const containerShapeId = containerShapeIdByMermaidId.get(mermaidId);
    if (containerShapeId) {
      writeShape(containerShapeId, pos.x, pos.y, pos.w, pos.h);
      noteTopLevel(pos.x, pos.y, readNum(pos.w, 0), readNum(pos.h, 0));
      continue;
    }

    // Leaf
    const leafShapeId = leafShapeIdByMermaidId.get(mermaidId);
    if (!leafShapeId) { unmatched.push(mermaidId); continue; }

    const parentSub = subgraphMermaidIdByMemberMermaidId.get(mermaidId);
    if (parentSub) {
      const sp = positions[parentSub];
      const px = sp ? sp.x : 0;
      const py = sp ? sp.y : 0;
      writeShape(leafShapeId, pos.x - px, pos.y - py, pos.w, pos.h);
      // child is inside a container → NOT part of frame's top-level union
    } else {
      writeShape(leafShapeId, pos.x, pos.y, pos.w, pos.h);
      const old = store.store[leafShapeId] as TLRecord | undefined;
      const w = readNum(pos.w, readNum((old?.props as { w?: unknown })?.w, 0));
      const h = readNum(pos.h, readNum((old?.props as { h?: unknown })?.h, 0));
      noteTopLevel(pos.x, pos.y, w, h);
    }
  }

  // Frame sizing: union of top-level bounds + pad. frame.x/y preserved.
  const frame = store.store[frameId] as TLRecord | undefined;
  if (frame) {
    const frameProps = (frame.props ?? {}) as Record<string, unknown>;
    const newRec: TLRecord = {
      ...frame,
      props: { ...frameProps, w: maxRight + framePad, h: maxBottom + framePad },
    } as TLRecord;
    updated[frameId] = [frame, newRec];
  }

  return { added: {}, updated, removed: {}, unmatched };
}
```

- [ ] **Step 4: Run — expect PASS.** `bun test apps/backend/src/domain/schema-import-positions.test.ts`. Все 4 кейса зелёные.

- [ ] **Step 5: Commit.**

```bash
git add apps/backend/src/domain/schema-import-positions.ts apps/backend/src/domain/schema-import-positions.test.ts
git commit -m "feat(backend): applyImportPositions pure builder (parent-relative coords + fit-to-content sizing)"
```

---

## Task 4: Wire `applyImportPositions` в handler `POST /api/schema/create` (backend)

Заменить `runLayout`-блок на apply-positions-блок, когда `positionsOverride` присутствует. `runAndBroadcastAnchors` (875) остаётся — порядок «позиции→размеры→anchors» соблюдён by construction.

**Files:**
- Modify: `apps/backend/src/routes/schema.ts` — чтение body (`:696` область парсинга raw), maps-построение (после `:736`/`:776`), branch на `:835-872`
- Test: `apps/backend/src/routes/schema.test.ts` (или существующий integration suite для schema/create)

- [ ] **Step 1: Failing test.** Добавить integration-тест (формат — как существующие schema/create тесты; найти их в suite и mirror'ить setup для room/store/bus):

```ts
test("POST /api/schema/create with positionsOverride writes injected coords, skips ELK", async () => {
  // setup: v2-capable room + app (mirror existing schema/create test harness)
  const raw = "flowchart LR\n  api[API] --> db[DB]";
  const res = await postSchemaCreate(app, {
    label: "T",
    raw,
    positionsOverride: {
      api: { x: 0, y: 0, w: 120, h: 60 },
      db: { x: 400, y: 0, w: 120, h: 60 },
    },
  });
  expect(res.ok).toBe(true);
  const store = getRoomStore(); // helper from harness
  // find the two geo children by meta.didrawLabel
  const apiShape = findShapeByLabel(store, "API");
  const dbShape = findShapeByLabel(store, "DB");
  // injected coords landed (frame-relative, no subgraph here)
  expect(apiShape.x).toBe(0);
  expect(dbShape.x).toBe(400); // NOT ELK-computed — proves ELK skipped
  // frame sized to union + pad (db right = 520 + pad)
  const frame = findFrame(store);
  expect((frame.props.w as number)).toBeGreaterThanOrEqual(520);
});
```

> Если в suite нет готовых хелперов `postSchemaCreate/getRoomStore/findShapeByLabel` — реализовать их по образцу соседних тестов в том же файле (НЕ вводить новый harness).

- [ ] **Step 2: Run — expect FAIL** (`positionsOverride` игнорируется, координаты от ELK): `bun test apps/backend/src/routes/schema.test.ts -t "positionsOverride"`. Expected: FAIL (`dbShape.x` != 400, ELK переставил).

- [ ] **Step 3: Implement.** В handler `POST /api/schema/create`:

(3a) Прочитать `positionsOverride` из body. Найти место чтения body (рядом с `body.clientOpId`); расширить тип на чтении:

```ts
const positionsOverride = (body as { positionsOverride?: Record<string, import("@shemma/domain").NodePos> }).positionsOverride;
```

(3b) Получить `idMap` из parse-результата (Task 1). Handler использует РАЗДЕЛЬНЫЕ присваивания (`schema.ts:672-675`), не деструктуризацию — добавить строку `const idMap = parseResult.idMap;` после `:675` (до Task 1 это TS-красное — ожидаемо TDD).

(3c) После создания shape'ов (после цикла arrows, ~`:799`, ДО auto-upgrade `:803`) построить mermaid-id-keyed карты резолва:

```ts
// Stage 1 position-injection: build mermaid-id → shape.id resolution maps.
// All resolution maps stay mermaidId-keyed to match the positionsOverride contract;
// nodeIdToMermaidId is only an O(1) member→subgraph lookup (NOT a re-key of the contract).
const nodeIdToMermaidId = new Map<NodeId, string>();
for (const [mId, nId] of idMap) nodeIdToMermaidId.set(nId, mId);

const leafShapeIdByMermaidId = new Map<string, string>();
for (const [nodeId, shapeIdV] of nodeIdToShapeId) {
  const mId = nodeIdToMermaidId.get(nodeId);
  if (mId) leafShapeIdByMermaidId.set(mId, shapeIdV);
}

const containerShapeIdByMermaidId = new Map<string, string>();
const subgraphMermaidIdByMemberMermaidId = new Map<string, string>();
for (const action of parsedActions) {
  if (action.kind !== "schema-group" || !action.name) continue;
  const containerShapeIdV = groupActionToShapeId.get(action.name);
  const sgMermaidId = action.mermaidId;
  if (containerShapeIdV && sgMermaidId) {
    containerShapeIdByMermaidId.set(sgMermaidId, containerShapeIdV);
    for (const memberNodeId of action.nodeIds) {
      const memberMermaidId = nodeIdToMermaidId.get(memberNodeId);
      if (memberMermaidId) subgraphMermaidIdByMemberMermaidId.set(memberMermaidId, sgMermaidId);
    }
  }
}
```

(3d) Заменить `try { runLayout(...) } catch {}` блок (`:835-872`) на branch:

```ts
if (positionsOverride) {
  // Stage 1: apply injected mermaid-quality positions; ELK NOT run.
  const posBatch = applyImportPositions({
    store: room.store,
    frameId,
    positions: positionsOverride,
    leafShapeIdByMermaidId,
    containerShapeIdByMermaidId,
    subgraphMermaidIdByMemberMermaidId,
    framePad: 40,
  });
  if (posBatch.unmatched.length > 0) {
    console.warn(`[schema/create] positionsOverride: ${posBatch.unmatched.length} unmatched mermaid ids: ${posBatch.unmatched.join(", ")}`);
  }
  if (!isEmptyBatch(posBatch)) {
    room.store = applyStoreChanges(room.store, posBatch);
    room.didrawIndex = rebuildDidrawIndex(room.store);
    room.version += 1;
    pushOpLog(room, { ops: posBatch, source: "ai", version: room.version, at: Date.now() }, config.opLogMaxSize);
    room.dirty = true;
    scheduleSave(id, room);
    bus.publish(spaceId, id, { changes: posBatch, source: "ai", version: room.version });
  }
} else {
  try {
    // ... existing runLayout block unchanged ...
  } catch {
    // Layout failure is non-fatal; shapes remain at (0,0).
  }
}
```

> `isEmptyBatch`/`applyStoreChanges` смотрят только added/updated/removed — лишнее поле `unmatched` безопасно (verified: `store-ops.ts:14-22`). **Nested-subgraph reject — на фронте** (Task 5 §3b harvest guard), т.к. backend nesting уже flatten'ит и blueprint `parentId` в `positionsOverride` не передаётся.

(3e) Импортировать `applyImportPositions` сверху файла.

- [ ] **Step 4: Run — expect PASS.** `bun test apps/backend/src/routes/schema.test.ts -t "positionsOverride"`. Затем весь schema-suite зелёный (старый путь без `positionsOverride` не затронут — branch'ится).

- [ ] **Step 5: Commit.**

```bash
git add apps/backend/src/routes/schema.ts apps/backend/src/routes/schema.test.ts
git commit -m "feat(backend): inject positionsOverride into schema/create, bypass ELK on import"
```

---

## Task 5: Frontend harvest + wiring dagre/elk → backend (frontend)

Снять позиции из `createMermaidDiagram` через хук на offscreen-странице (cleanup throwaway), передать в backend через `createSchemaViaBackend`. Подключить в `importMermaidWithEngine` для движков dagre/elk.

**Files:**
- Modify: `apps/frontend/src/canvas/mermaid-import.ts` — `createSchemaViaBackend` (`:225-247`), новая `harvestMermaidPositions`, `importMermaidWithEngine` (dagre/elk ветка)
- Test: `apps/frontend/src/canvas/mermaid-import.test.ts` (pure-часть harvest-маппинга)

> **Зависит от Tasks 1-4** (idMap в ParseResult; NodePos+positionsOverride в контракте; applyImportPositions wired; handler принимает positionsOverride). Wiring (`createSchemaViaBackend`/`importMermaid`/dispatcher) валидируется tsc — поле `positionsOverride` обязано существовать в контракте (до Task 2 вызов = TS-ошибка = fail-first); чистый mapper покрыт unit-тестом ниже. **Источник harvest (hook vs deep-import) выбран в Task 0 Step 4.**

- [ ] **Step 1: Failing test (pure mapper).** Извлечь маппинг blueprint-node → запись в чистый хелпер `harvestRecordFromBlueprintNode(input)` и протестировать (DOM-инфры нет — тестируем чистую функцию, convention `panels.test.ts`):

```ts
test("harvestRecordFromBlueprintNode keeps mermaid id key + flat coords", () => {
  const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
  // tldraw 5.0.0 mapper input is a WRAPPER: { nodeId, node, diagramKind, kind }
  const input = { nodeId: "api", node: { id: "api", x: 10, y: 20, w: 120, h: 60, kind: "node" }, diagramKind: "flowchart", kind: "node" };
  const ret = harvestRecordFromBlueprintNode(out, input);
  expect(ret).toBeUndefined();          // default render preserved
  expect(out.api).toEqual({ x: 10, y: 20, w: 120, h: 60 });
});
```

- [ ] **Step 2: Run — expect FAIL** (`harvestRecordFromBlueprintNode` not defined): `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts -t "harvestRecord"`. Expected: FAIL.

- [ ] **Step 3: Implement.** В `mermaid-import.ts`:

(3a) Pure mapper:

```ts
/** tldraw 5.0.0 mapper input wrapper (MermaidNodeRenderMapper): geometry on .node, id on .nodeId. */
type MermaidMapperInput = {
  nodeId: string;
  node: { id: string; x: number; y: number; w: number; h: number; kind?: string; parentId?: string };
};

/** Records a blueprint node's flat layout coords into `out`, keyed by mermaid id.
 *  Returns undefined so createMermaidDiagram keeps its default render. */
export function harvestRecordFromBlueprintNode(
  out: Record<string, { x: number; y: number; w: number; h: number }>,
  input: MermaidMapperInput,
): undefined {
  const n = input.node;
  out[input.nodeId] = { x: n.x, y: n.y, w: n.w, h: n.h };
  return undefined;
}
```

(3b) `harvestMermaidPositions`. **PRIMARY вариант (hook) — если Task 0 gate (b) ✅** (subgraph'ы приходят через mapper с w/h):

```ts
import { PageRecordType } from "tldraw"; // tldraw 5.0.0: createPageId НЕ существует — id через PageRecordType.createId()

/** Snapshot mermaid dagre/elk layout positions keyed by mermaid id, WITHOUT
 *  leaving any shapes on the user's page. Runs createMermaidDiagram on a
 *  throwaway page, harvests via the public blueprintRender hook, then deletes
 *  the throwaway page entirely. Throws on nested subgraphs (Stage-1 одноуровневый). */
export async function harvestMermaidPositions(
  editor: Editor,
  source: string,
  opts: { layout?: "elk" } = {},
): Promise<Record<string, { x: number; y: number; w: number; h: number }>> {
  const mod = await loadMermaid();
  // biome-ignore lint/suspicious/noExplicitAny: createMermaidDiagram/blueprintRender не в public d.ts
  const mermaidMod = mod as any;

  const positions: Record<string, { x: number; y: number; w: number; h: number }> = {};
  // Track kind + parentId per mermaid id для nested-guard (R8) — не уходит в backend.
  const meta: Record<string, { kind?: string; parentId?: string }> = {};
  const createOptions: Record<string, unknown> = {
    blueprintRender: {
      mapNodeToRenderSpec: (input: MermaidMapperInput) => {
        meta[input.nodeId] = { kind: input.node.kind, parentId: input.node.parentId };
        return harvestRecordFromBlueprintNode(positions, input);
      },
    },
  };
  if (opts.layout === "elk") createOptions.mermaidConfig = { layout: "elk" };

  const prevPageId = editor.getCurrentPageId();
  const scratch = PageRecordType.createId();
  editor.run(
    () => {
      editor.createPage({ id: scratch, name: "__mermaid_harvest__" });
      editor.setCurrentPage(scratch);
    },
    { history: "ignore" },
  );
  try {
    await mermaidMod.createMermaidDiagram(editor, source, createOptions);
  } finally {
    // deletePage — no-op при единственной странице; сначала вернуть prev, потом удалить scratch.
    editor.run(
      () => {
        editor.setCurrentPage(prevPageId);
        editor.deletePage(scratch); // removes all throwaway shapes/groups/bindings at once
      },
      { history: "ignore" },
    );
  }

  // Nested-subgraph guard (R8): subgraph чей parentId — другой subgraph → не поддержано в Stage-1.
  const subgraphIds = new Set(Object.keys(meta).filter((id) => meta[id].kind === "subgraph"));
  for (const id of subgraphIds) {
    const p = meta[id].parentId;
    if (p && subgraphIds.has(p)) {
      throw new Error(`nested subgraphs not supported in Stage-1 import (${id} inside ${p})`);
    }
  }
  return positions;
}
```

> `PageRecordType.createId()` — корректный способ сгенерить `TLPageId` в tldraw 5.0.0 (`createPageId` НЕ экспортируется). `editor.run(fn, {history:'ignore'})` держит throwaway-страницу вне undo; `deletePage` сносит узлы+группы+bindings разом (закрывает R5). Mapper получает wrapper `{nodeId, node}` — geometry на `input.node`.

**ALT вариант (deep-import) — если Task 0 gate (b) ✗** (subgraph'ы не приходят через mapper): не создавать shape'ы вовсе — взять blueprint напрямую. Требует повторить `mermaid.initialize(MERMAID_CONFIG)` (FONT_INFLATE=1.4, nodeSpacing/rankSpacing=80) + offscreen DOM-mount + `mermaid.render` + `mermaid.mermaidAPI.getDiagramFromText`:

```ts
// @ts-expect-error deep import вне package exports map (приватный API; может сломаться на minor-bump)
import { parseFlowchartLayout, flowchartToBlueprint } from "@tldraw/mermaid/dist-esm/flowchartDiagram.mjs";
// ... render mermaid to offscreen SVG with MERMAID_CONFIG, then:
//   const blueprint = flowchartToBlueprint(parseFlowchartLayout(liveSvg), vertices, edges, subGraphs, classes);
//   blueprint.nodes  → positions[node.id] = {x,y,w,h}
//   blueprint.groups → positions[group.id] = {x,y,w,h}  // subgraph bounds, keyed by mermaid id
// Никакого scratch-page/throwaway. Точную MERMAID_CONFIG скопировать из createMermaidDiagram.ts:29-38.
```

(3c) `createSchemaViaBackend` — добавить `positionsOverride` в opts и в body:

```ts
export async function createSchemaViaBackend(opts: {
  label: string;
  raw: string;
  space?: string;
  room?: string;
  positionsOverride?: Record<string, { x: number; y: number; w?: number; h?: number }>;
}): Promise<SchemaCreateResponse> {
  // ... space/room resolution unchanged ...
  const r = await fetch(`/api/schema/create?${qs}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: opts.label, raw: opts.raw, positionsOverride: opts.positionsOverride }),
  });
  // ... rest unchanged ...
}
```

И прокинуть через `importMermaid` (добавить optional `positionsOverride` в его opts и передать в `createSchemaViaBackend`).

(3d) `importMermaidWithEngine` — для движков `dagre`/`elk`: вместо `importMermaidLegacy` (который оставляет native-болванки) сделать harvest → backend-build:

```ts
// dagre/elk branch (заменяет вызов importMermaidLegacy):
if (engine === "elk") { await ensureElkLoader(); }
const positions = await harvestMermaidPositions(editor, source, engine === "elk" ? { layout: "elk" } : {});
const res = await importMermaid(editor, source, { ...opts, positionsOverride: positions });
return { ...res, engineUsed: engine, engineFallback: false };
```

> **REPLACE, не add:** в текущем `importMermaidWithEngine` ветка dagre/elk зовёт `importMermaidLegacy` (оставляет native-болванки) — этот вызов нужно ЗАМЕНИТЬ на harvest→backend выше. Движок `custom` остаётся как есть (backend-ELK без позиций — для сравнения/debug). Прочитать текущее тело функции (sub-project A) и сохранить остальные ветки + возврат `engineUsed/engineFallback`.

- [ ] **Step 4: Run — expect PASS.** `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`. Pure-тест зелёный; существующие тесты файла не сломаны. tsc: `bun run --cwd apps/frontend tsc` чисто.

- [ ] **Step 5: Commit.**

```bash
git add apps/frontend/src/canvas/mermaid-import.ts apps/frontend/src/canvas/mermaid-import.test.ts
git commit -m "feat(frontend): harvest mermaid positions (offscreen) + feed dagre/elk import through backend v2 builder"
```

---

## Task 6: 1a checkpoint — live verify (controller, chrome-MCP)

**Цель:** глазами на доске подтвердить, что НАШИ объекты встали на dagre/elk-координаты, контейнеры обрамляют детей, frame обрамляет всё, ничего не клипается. Делает контроллер.

- [ ] **Step 1:** Поднять dev (если не поднят), открыть room в space `di-draw` (живой WS tab).
- [ ] **Step 2:** Импортировать sample-2 через paste-окно, движок **elk**.
- [ ] **Step 3 — verify (скриншот + сверка с эталоном A):**
  - subgraph'ы — это `schema-container` (наш shape), а не native group/geo;
  - узлы — `geo` с `meta.didrawId/didrawLabel` (проверить через `shemma_canvas_view` или evaluate_script на store);
  - расположение ≈ 1:1 с `docs/references/2026-05-29-engine-comparison.png` (elk);
  - каждый контейнер охватывает своих детей (нет вылезания за границы); frame охватывает всё; нет клипа.
  - **PASS-критерий (binary):** ВСЕ visible schema-container subgraph'ы корректно обёрнуты вокруг детей; frame bounds покрывают ВСЕ top-level элементы; NO clipping. Иначе → FAIL + iterate (Step 4).
- [ ] **Step 4:** Если frame/контейнеры малы/велики — подстроить `framePad` (Task 4 §3d) и/или container top-pad; перезапустить проверку. Зафиксировать вывод.

---

## Task 7: Плумбинг `midpointDistribution` через `runAndBroadcastAnchors` (backend)

**Files:**
- Modify: `apps/backend/src/routes/_anchors.ts:24-30,53`
- Test: `apps/backend/src/domain/midpoints.test.ts` (существующий — для `fixed-0.5` уже может быть; добавить проброс-кейс если нужно)

- [ ] **Step 1: Failing test.** В тесте для `runAndBroadcastAnchors` (или новом) проверить, что при `midpointDistribution: "fixed-0.5"` midpoint'ы НЕ распределяются (остаются 0.5). Если прямого теста на `runAndBroadcastAnchors` нет — добавить unit на то, что новый параметр пробрасывается в `computeElbowMidpoints` (можно через spy/мок или через эффект: fan-in из 2 стрелок при `fixed-0.5` → нет updated).

```ts
test("runAndBroadcastAnchors forwards midpointDistribution=fixed-0.5 (no fan spread)", () => {
  // build a room store with a 2-arrow fan-in (same target+side), elbow, with ports
  // ... (mirror existing midpoints.test fixtures) ...
  runAndBroadcastAnchors(room, bus, "sp", "rm", () => {}, { midpointDistribution: "fixed-0.5" });
  // assert no arrow's elbowMidPoint moved off 0.5
  for (const arrowId of arrowIds) {
    expect((room.store.store[arrowId] as any).props.elbowMidPoint).toBe(0.5);
  }
});
```

- [ ] **Step 2: Run — expect FAIL** (сигнатура без 6-го параметра / midpoints всё равно распределились): `bun test apps/backend/src/domain/midpoints.test.ts -t "forwards midpointDistribution"`. Expected: FAIL.

- [ ] **Step 3: Implement.** В `_anchors.ts` добавить optional param и передать:

```ts
import type { LayoutParams } from "@shemma/domain";

export function runAndBroadcastAnchors(
  room: RoomState,
  bus: StoreChangeBus,
  spaceId: string,
  roomId: string,
  scheduleSave: (id: string, room: RoomState) => void,
  params?: Pick<LayoutParams, "midpointDistribution">,
): void {
  // ... Step 1 anchors unchanged ...
  // Step 2:
  const midpointsBatch = computeElbowMidpoints(room.store, params);
  // ... unchanged ...
}
```

(Опционально) В `schema.ts` handler передать distribution из `room.meta.layoutParams` в `runAndBroadcastAnchors(... , room.meta?.layoutParams)`, чтобы import мог откатиться на `fixed-0.5`, если swapOrder-fix (Task 8) окажется неполным.

- [ ] **Step 4: Run — expect PASS.** `bun test apps/backend/src/domain/midpoints.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add apps/backend/src/routes/_anchors.ts apps/backend/src/domain/midpoints.test.ts
git commit -m "feat(backend): thread midpointDistribution through runAndBroadcastAnchors"
```

---

## Task 8: R2 — swapOrder-aware `computeElbowMidpoints` (backend)

`computeElbowMidpoints` пишет `(idx+1)/(N+1)` без компенсации внутреннего tldraw `swapOrder` → на веере со смешанной ориентацией сторон ладдер зеркалит. Починка: определить ориентацию per-arrow и инвертировать midpoint, когда нужно.

**Files:**
- Modify: `apps/backend/src/domain/midpoints.ts:111-128`
- Test: `apps/backend/src/domain/midpoints.test.ts`

- [ ] **Step 1: Investigation (bounded).** Найти и прочитать tldraw-правило `swapOrder` для elbow-стрелок: `grep -rn "swapOrder" node_modules/.bun/*/node_modules/@tldraw/editor node_modules/.bun/*/node_modules/tldraw 2>/dev/null` (cited `getElbowArrowInfo.tsx:217` — там `swapOrder ? 1 - elbowMidPoint : elbowMidPoint`). Определить, от чего зависит `swapOrder` (порядок сторон start/end в каноническом смысле). Зафиксировать правило в комментарии к фиксу.

- [ ] **Step 2: Failing test.** Построить mixed-orientation веер (хаб-target с двумя источниками — одна стрелка приходит сверху, другая снизу, т.е. `didrawSourcePort` разные, `didrawTargetPort` один) и проверить, что распределённые midpoint'ы дают **монотонный** (не зеркальный) визуальный сдвиг после учёта swapOrder:

```ts
test("computeElbowMidpoints: mixed-orientation fan-in is not mirrored (swapOrder-aware)", () => {
  // 2 elbow arrows into target T on side "left": A1 from source above, A2 from below.
  // After distribution, the EFFECTIVE midpoints (post-swapOrder) must be ordered,
  // not inverted relative to each other.
  const store = buildFanInMixedOrientation(); // helper mirroring existing fixtures
  const batch = computeElbowMidpoints(store);
  const m1 = effectiveMidpoint(batch, "shape:arr1"); // helper: applies swapOrder rule from Step 1
  const m2 = effectiveMidpoint(batch, "shape:arr2");
  expect(m1).toBeLessThan(m2); // monotonic, not mirrored
});
```

> `buildFanInMixedOrientation` и `effectiveMidpoint` — тестовые хелперы; `effectiveMidpoint` применяет правило swapOrder из Step 1 к записанному `elbowMidPoint`. Кейс **должен падать** на текущем коде (записывается голый `(idx+1)/(N+1)`, после swapOrder одно из значений инвертируется → `m1 > m2`).

- [ ] **Step 3: Run — expect FAIL:** `bun test apps/backend/src/domain/midpoints.test.ts -t "mixed-orientation"`. Expected: FAIL (mirrored).

- [ ] **Step 4: Implement.** В блоке записи (`:116-128`) определить swapOrder per-arrow (по правилу из Step 1, на основе `a.meta.didrawSourcePort/didrawTargetPort` + выбранной группы fan-in/fan-out) и инвертировать:

```ts
const rawMid = (idx + 1) / (n + 1);
// R2: tldraw renders elbowMidPoint as (swapOrder ? 1 - v : v). Pre-invert so the
// distributed ladder is visually monotonic regardless of terminal-side order.
const newMid = swapOrderForArrow(a) ? 1 - rawMid : rawMid;
```

где `swapOrderForArrow(a: ArrowRec): boolean` — приватный хелпер по правилу из Step 1. Если правило окажется неопределимым/нестабильным — fallback: оставить `rawMid` для same-orientation групп и инвертировать только в подтверждённо-зеркальных (документировать в комментарии + escape-hatch `fixed-0.5` из Task 7).

- [ ] **Step 5: Run — expect PASS:** `bun test apps/backend/src/domain/midpoints.test.ts`. Все кейсы (включая старые same-orientation) зелёные.

- [ ] **Step 6: Commit.**

```bash
git add apps/backend/src/domain/midpoints.ts apps/backend/src/domain/midpoints.test.ts
git commit -m "fix(backend): swapOrder-aware elbowMidPoint distribution (no mirrored fans)"
```

---

## Task 9: 1b checkpoint — live verify стрелок (controller, chrome-MCP)

- [ ] **Step 1:** Импортировать sample-2 (elk) на живой доске.
- [ ] **Step 2 — verify:**
  - стрелки угловые (elbow), port-locked к корректным сторонам (после `computeAnchors`);
  - веера (несколько стрелок на одну сторону) разведены и **консистентны** (не зеркалят) — особенно проверить хаб со смешанной ориентацией;
  - **labeled fan-in кейс:** импортировать граф с подписями на нескольких стрелках в один узел → зафиксировать, накладываются ли подписи (это **known limitation** Stage-1, не баг — §4.4 спеки);
  - нет диагональных «straight-fallback» стрелок (если есть — отметить узлы, где route заблокирован).
  - **PASS-критерий (binary):** все import-стрелки elbow + port-locked; веера консистентны (не зеркалят); diagonal-fallback'ов нет (label-overlap допустим как known limitation). Иначе → FAIL + Step 3.
- [ ] **Step 3:** Если веера зеркалят — вернуться к Task 8 (правило swapOrder неполное) ИЛИ временно включить `fixed-0.5` через `room.meta.layoutParams` (Task 7) и зафиксировать как known-limitation. Записать вывод.

---

## Task 10: Дефолт `arc` только для ручного создания (frontend)

**Files:**
- Modify: место creation-default стрелок (определяется в Step 1). Backend создаёт elbow (compile/schema) — НЕ трогать.
- Test: regression-тест ИЛИ probe+live (зависит от Step 1).

- [ ] **Step 1: Investigation gate (обязательный, ПЕРВЫМ — arc-default НЕ подтверждён).** Установить, какой `kind` получает НОВАЯ user-стрелка в tldraw 5.0.0:
  `grep -rn "getDefaultProps\|kind.*elbow\|kind.*arc" node_modules/.bun/@tldraw+editor@5.0.0*/**/dist-cjs` + проверить `ArrowShapeUtil.getDefaultProps()`; затем `grep -rn "setStyleForNextShapes\|stylesForNextShape\|ArrowShapeKindStyle" apps/frontend/src`.
  NB: `backfillStoreRecords` ставит `kind:'arc'` ТОЛЬКО для legacy-arrows (`schema-placeholder.ts:23`) — это data-path, НЕ creation-default; не трогаем.

- [ ] **Step 2: Decide по результату Step 1.**
  - **Если `getDefaultProps().kind === "arc"`** → ручные стрелки уже arc. Задача = regression-тест/probe, фиксирующий: новая стрелка = `arc`, import-стрелка (backend) = `elbow`. Закоммитить тест + коммент.
  - **Если `kind === "elbow"`/иной** → выставить `arc` как default-for-next-shapes ТОЛЬКО для интерактивного создания через `editor.setStyleForNextShapes(<ArrowShapeKindStyle>, "arc")` в месте init (backend/import/relayout остаются elbow). Failing-тест/probe → impl → verify.

- [ ] **Step 3: Commit.**

```bash
git add apps/frontend/src/...
git commit -m "feat(frontend): manual arrow creation defaults to arc (import/agent stay elbow)"
```

---

## Task 11: Стили + локализация — verify + добор (backend/frontend)

Стили узлов (`nodeStylesByNodeId`) и subgraph'ов (`subgraphStyles`) **уже применяются** в `makeChildShape`/`makeSchemaContainerShape`. Задача — подтвердить, что инъекция позиций/размеров их не перетёрла, и зафиксировать приоритет.

**Files:**
- Test: `apps/backend/src/routes/schema.test.ts` — кейс «import с positionsOverride сохраняет mermaid-стили узла».

- [ ] **Step 1: Failing test.**

```ts
test("positionsOverride import preserves mermaid node styles", async () => {
  const raw = "flowchart LR\n  api[API]:::hot --> db[DB]\n  classDef hot fill:#ffcccc";
  // (или style-директива; mirror существующих style-тестов парсера)
  const res = await postSchemaCreate(app, { label: "T", raw, positionsOverride: { api: {x:0,y:0,w:120,h:60}, db:{x:300,y:0,w:120,h:60} } });
  expect(res.ok).toBe(true);
  const apiShape = findShapeByLabel(getRoomStore(), "API");
  // style color resolved from mermaid fill, NOT overwritten by position injection
  expect((apiShape.props as any).fill).not.toBe("none"); // got the mermaid fill
});
```

- [ ] **Step 2: Run.** Если PASS сразу (стили уже сохраняются через `makeChildShape`, а `applyImportPositions` трогает только x/y/w/h/growY) — отлично, тест становится регрессией. Если FAIL (инъекция перетёрла props) — поправить `applyImportPositions.writeShape`, чтобы мержить только geometry-поля (он уже `{...oldProps, w, h, growY}` — стили сохраняются; убедиться).

- [ ] **Step 3: Commit.**

```bash
git add apps/backend/src/routes/schema.test.ts
git commit -m "test(backend): positionsOverride import preserves mermaid node styles"
```

---

## Task 12: 1c checkpoint — live verify (controller, chrome-MCP)

- [ ] **Step 1:** Импортировать стилизованный mermaid (sample-2 + style-директивы) на живой доске, движок elk.
- [ ] **Step 2 — verify:**
  - стили mermaid применены к узлам/контейнерам (цвет/fill), приоритет explicit > container > board > native;
  - схема локализована: внешняя граница = `frame`, subgraph'ы = `schema-container`;
  - нарисовать руками стрелку → `arc`; импортированные → `elbow`;
  - **PASS-критерий (binary):** mermaid-стили видны на узлах/контейнерах; локализация frame+container верна; manual-стрелка = arc И import-стрелка = elbow. Иначе → FAIL + iterate.
- [ ] **Step 3:** Зафиксировать итог 1c.

---

## Phase-end (после Task 12)

1. `code-simplifier` agent по diff'у Stage 1 (`a05e2a1..HEAD`).
2. Единый spec+quality review одним проходом (как в A).
3. Fixes.
4. **НЕ** release/merge — per standing constraint «никаких релизов до решения задачи глобально». Stage 1 остаётся на ветке до Stage 2 «B» и user-сигнала «близко к образцу».

---

## Self-Review (выполнен при написании плана)

**1. Spec coverage:**
- §2.1 материализация backend → Task 4. §2.2 источник + parent-relative → Task 3/5. §2.3 elbow-риски → Task 8 (R2), order by construction (Task 4). §2.4 arc-default → Task 10. §2.5 frame/container → Task 6/12 (verify). §4.1 harvest+cleanup → Task 5. §4.2 inject+sizing+addressing → Task 3/4. §4.3 reuse → Task 4. §4.4 elbow+lever+edge-label-limit → Task 7/8/9. §4.5 styles+localize+defaults → Task 10/11/12. §7 testing → каждый task TDD + checkpoints. §8 R1-R9 → R1/R3/R4 (Task 3/4), R2 (Task 7/8), R5 (Task 5 offscreen), R6/R7 (Task 9 known-limit), R8 (Task 0), R9 (Task 5 primary-hook).
- Gap-check: spike (Task 0) валидирует источник до кода; sizing (R3) — Task 3/4; unmatched (minor) — Task 3/4.

**2. Placeholder scan:** код приведён для всех testable-units (`applyImportPositions`, `harvest*`, types, плумбинг). Library-internal `swapOrder` (Task 8) — bounded investigation с конкретной grep-локацией + falsifiable тест, не placeholder. Integration в большой handler (Task 4) — точные вставки с кодом + file:line.

**3. Type consistency:** `NodePos` (Task 2) ↔ `positionsOverride` (Task 4/5) ↔ `applyImportPositions.positions` (Task 3) — все `Record<string mermaidId, {x,y,w?,h?}>`. `idMap: Map<string, NodeId>` (Task 1) ↔ inversion в Task 4. `harvestMermaidPositions` возвращает `{x,y,w,h}` (w/h всегда) ↔ `positionsOverride` принимает `w?,h?` — совместимо. `runAndBroadcastAnchors(..., params?)` (Task 7) ↔ `computeElbowMidpoints(store, params)` (существующая сигнатура).
