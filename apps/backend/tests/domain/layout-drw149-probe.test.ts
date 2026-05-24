// DRW-149 Phase 1: Probe integration tests on runLayoutSubgraph (via runLayout).
//
// Цель: задокументировать поведение runLayout для 6 use-cases frame-scoped layout.
// Короткие noops (< 2) сняты на probe ветке — каждый тест вызывает runLayout напрямую.
//
// IMPORTANT: тесты с console.log — вывод уходит в /tmp/drw-149-probe-output.txt
// при запуске с `bun test 2>&1 | tee /tmp/drw-149-probe-output.txt`.
//
// Assertion policy: only `expect(result.reason).toBeUndefined()` (loose).
// Конкретные ожидания задокументированы в findings doc.

import { describe, expect, test } from "bun:test";
import { runLayout } from "../../src/domain/layout";
import { applyStoreChanges, rebuildDidrawIndex } from "../../src/store-ops";
import type { TLRecord, TLStoreSnapshot } from "../../src/store-types";

// =====================================================================
// Helpers
// =====================================================================

function emptySnapshot(): TLStoreSnapshot {
  return {
    schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
    store: {
      "document:document": { id: "document:document", typeName: "document" } as TLRecord,
      "page:page": { id: "page:page", typeName: "page" } as TLRecord,
    },
  };
}

function snapshotWith(records: TLRecord[]): TLStoreSnapshot {
  const s = emptySnapshot();
  for (const r of records) s.store[r.id] = r;
  return s;
}

/** tldraw frame (container) */
function makeFrame(
  id: string,
  name: string,
  opts: { x?: number; y?: number; w?: number; h?: number; parentId?: string } = {},
): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "frame",
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    parentId: opts.parentId ?? "page:page",
    props: { w: opts.w ?? 400, h: opts.h ?? 300, name },
    meta: { didrawName: name, didrawIsGroup: true, role: "boundary" },
  } as TLRecord;
}

/** geo+role=boundary shape (acts as container) */
function makeContainer(
  id: string,
  name: string,
  opts: { x?: number; y?: number; w?: number; h?: number; parentId?: string } = {},
): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "geo",
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    parentId: opts.parentId ?? "page:page",
    props: { w: opts.w ?? 300, h: opts.h ?? 200, geo: "rectangle" },
    meta: { didrawName: name, role: "boundary" },
  } as TLRecord;
}

/** Plain service node */
function makeService(
  id: string,
  name: string,
  opts: { x?: number; y?: number; w?: number; h?: number; parentId?: string; pinned?: boolean } = {},
): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "geo",
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    parentId: opts.parentId ?? "page:page",
    props: { w: opts.w ?? 120, h: opts.h ?? 60, geo: "rectangle" },
    meta: {
      didrawName: name,
      role: "service",
      ...(opts.pinned ? { pinned: true, position: { x: opts.x ?? 0, y: opts.y ?? 0 } } : {}),
    },
  } as TLRecord;
}

function makeArrow(
  id: string,
  fromId: string,
  toId: string,
): { arrow: TLRecord; b1: TLRecord; b2: TLRecord } {
  const arrow: TLRecord = {
    id,
    typeName: "shape",
    type: "arrow",
    x: 0,
    y: 0,
    parentId: "page:page",
    props: {},
    meta: { connectionKind: "sync" },
  } as TLRecord;
  const b1: TLRecord = {
    id: `binding:${id}-s`,
    typeName: "binding",
    fromId: id,
    toId: fromId,
    props: { terminal: "start" },
  } as TLRecord;
  const b2: TLRecord = {
    id: `binding:${id}-e`,
    typeName: "binding",
    fromId: id,
    toId: toId,
    props: { terminal: "end" },
  } as TLRecord;
  return { arrow, b1, b2 };
}

// =====================================================================
// DRW-149 Probe Cases
// =====================================================================

describe("DRW-149 probe: runLayoutSubgraph — 6 use cases", () => {

  // -----------------------------------------------------------------------
  // Case 1: single frame selected
  // filterToIds = { frame }
  // Что проверяем: дети layout + frame resize (Pass A), Pass B single-node path
  // -----------------------------------------------------------------------
  test("Case 1: single frame selected — children get laid out, frame resizes", async () => {
    const frame = makeFrame("shape:frame1", "frame1", { x: 100, y: 100, w: 400, h: 300 });
    const c1 = makeService("shape:c1", "c1", { x: 0, y: 0, parentId: "shape:frame1" });
    const c2 = makeService("shape:c2", "c2", { x: 5, y: 0, parentId: "shape:frame1" });
    const c3 = makeService("shape:c3", "c3", { x: 0, y: 5, parentId: "shape:frame1" });

    const s = snapshotWith([frame, c1, c2, c3]);
    const idx = rebuildDidrawIndex(s);

    const result = await runLayout(s, {
      mode: "layered-tb",
      scope: "affected",
      spacing: "normal",
      affectedIds: new Set(["shape:frame1"]),
    }, idx);

    const ns = applyStoreChanges(s, result.batch);
    const updatedKeys = Object.keys(result.batch.updated);

    console.log("[DRW-149 Case 1] reason:", result.reason);
    console.log("[DRW-149 Case 1] batch.updated keys:", updatedKeys);
    const fr = ns.store["shape:frame1"] as TLRecord & { x: number; y: number; props: { w: number; h: number } };
    const ch1 = ns.store["shape:c1"] as TLRecord & { x: number; y: number };
    const ch2 = ns.store["shape:c2"] as TLRecord & { x: number; y: number };
    const ch3 = ns.store["shape:c3"] as TLRecord & { x: number; y: number };
    console.log("[DRW-149 Case 1] frame x/y/w/h:", fr?.x, fr?.y, fr?.props?.w, fr?.props?.h);
    console.log("[DRW-149 Case 1] c1 x/y:", ch1?.x, ch1?.y);
    console.log("[DRW-149 Case 1] c2 x/y:", ch2?.x, ch2?.y);
    console.log("[DRW-149 Case 1] c3 x/y:", ch3?.x, ch3?.y);

    // Loose assertion
    expect(result.reason).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Case 2: single geo+boundary container selected
  // filterToIds = { container }
  // Что проверяем: inner Pass A + container resize (geo boundary type)
  // -----------------------------------------------------------------------
  test("Case 2: single geo+boundary container selected — inner Pass A + container resize", async () => {
    const container = makeContainer("shape:cont1", "cont1", { x: 200, y: 200, w: 300, h: 200 });
    const c1 = makeService("shape:s1", "s1", { x: 0, y: 0, parentId: "shape:cont1" });
    const c2 = makeService("shape:s2", "s2", { x: 5, y: 0, parentId: "shape:cont1" });

    const s = snapshotWith([container, c1, c2]);
    const idx = rebuildDidrawIndex(s);

    const result = await runLayout(s, {
      mode: "layered-tb",
      scope: "affected",
      spacing: "normal",
      affectedIds: new Set(["shape:cont1"]),
    }, idx);

    const ns = applyStoreChanges(s, result.batch);
    const updatedKeys = Object.keys(result.batch.updated);

    console.log("[DRW-149 Case 2] reason:", result.reason);
    console.log("[DRW-149 Case 2] batch.updated keys:", updatedKeys);
    const cont = ns.store["shape:cont1"] as TLRecord & { x: number; y: number; props: { w: number; h: number } };
    const s1 = ns.store["shape:s1"] as TLRecord & { x: number; y: number };
    const s2 = ns.store["shape:s2"] as TLRecord & { x: number; y: number };
    console.log("[DRW-149 Case 2] container x/y/w/h:", cont?.x, cont?.y, cont?.props?.w, cont?.props?.h);
    console.log("[DRW-149 Case 2] s1 x/y:", s1?.x, s1?.y);
    console.log("[DRW-149 Case 2] s2 x/y:", s2?.x, s2?.y);

    expect(result.reason).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Case 3: frame + external shape selected
  // filterToIds = { frame, external_shape }
  // Что проверяем: Pass B на 2 top-level + frame inner Pass A
  // -----------------------------------------------------------------------
  test("Case 3: frame + external shape selected — Pass B on 2 top-level + inner Pass A", async () => {
    const frame = makeFrame("shape:frame3", "frame3", { x: 0, y: 0, w: 400, h: 300 });
    const inner1 = makeService("shape:i1", "i1", { x: 0, y: 0, parentId: "shape:frame3" });
    const inner2 = makeService("shape:i2", "i2", { x: 5, y: 0, parentId: "shape:frame3" });
    const external = makeService("shape:ext", "ext", { x: 600, y: 0 });
    // Edge: inner1 → external (cross-boundary)
    const { arrow, b1, b2 } = makeArrow("shape:arr3", "shape:i1", "shape:ext");

    const s = snapshotWith([frame, inner1, inner2, external, arrow, b1, b2]);
    const idx = rebuildDidrawIndex(s);

    const result = await runLayout(s, {
      mode: "layered-tb",
      scope: "affected",
      spacing: "normal",
      affectedIds: new Set(["shape:frame3", "shape:ext"]),
    }, idx);

    const ns = applyStoreChanges(s, result.batch);
    const updatedKeys = Object.keys(result.batch.updated);

    console.log("[DRW-149 Case 3] reason:", result.reason);
    console.log("[DRW-149 Case 3] batch.updated keys:", updatedKeys);
    const fr = ns.store["shape:frame3"] as TLRecord & { x: number; y: number; props: { w: number; h: number } };
    const ext = ns.store["shape:ext"] as TLRecord & { x: number; y: number };
    const i1 = ns.store["shape:i1"] as TLRecord & { x: number; y: number };
    const i2 = ns.store["shape:i2"] as TLRecord & { x: number; y: number };
    console.log("[DRW-149 Case 3] frame x/y/w/h:", fr?.x, fr?.y, fr?.props?.w, fr?.props?.h);
    console.log("[DRW-149 Case 3] ext x/y:", ext?.x, ext?.y);
    console.log("[DRW-149 Case 3] i1 x/y:", i1?.x, i1?.y);
    console.log("[DRW-149 Case 3] i2 x/y:", i2?.x, i2?.y);

    expect(result.reason).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Case 4: two children without frame selected
  // filterToIds = { child1, child2 } (both inside a frame that is NOT selected)
  // Что проверяем: anchor detection — frame станет anchor, children двигаются
  // -----------------------------------------------------------------------
  test("Case 4: two children selected without frame — anchor detection", async () => {
    const frame = makeFrame("shape:frame4", "frame4", { x: 50, y: 50, w: 400, h: 300 });
    const child1 = makeService("shape:ch1", "ch1", { x: 0, y: 0, parentId: "shape:frame4" });
    const child2 = makeService("shape:ch2", "ch2", { x: 5, y: 0, parentId: "shape:frame4" });
    const nonSelected = makeService("shape:ns1", "ns1", { x: 0, y: 100, parentId: "shape:frame4" });

    const s = snapshotWith([frame, child1, child2, nonSelected]);
    const idx = rebuildDidrawIndex(s);

    const result = await runLayout(s, {
      mode: "layered-tb",
      scope: "affected",
      spacing: "normal",
      affectedIds: new Set(["shape:ch1", "shape:ch2"]),
    }, idx);

    const ns = applyStoreChanges(s, result.batch);
    const updatedKeys = Object.keys(result.batch.updated);

    console.log("[DRW-149 Case 4] reason:", result.reason);
    console.log("[DRW-149 Case 4] batch.updated keys:", updatedKeys);
    const fr = ns.store["shape:frame4"] as TLRecord & { x: number; y: number; props: { w: number; h: number } };
    const c1 = ns.store["shape:ch1"] as TLRecord & { x: number; y: number };
    const c2 = ns.store["shape:ch2"] as TLRecord & { x: number; y: number };
    const ns1 = ns.store["shape:ns1"] as TLRecord & { x: number; y: number };
    console.log("[DRW-149 Case 4] frame x/y/w/h:", fr?.x, fr?.y, fr?.props?.w, fr?.props?.h);
    console.log("[DRW-149 Case 4] ch1 x/y:", c1?.x, c1?.y);
    console.log("[DRW-149 Case 4] ch2 x/y:", c2?.x, c2?.y);
    console.log("[DRW-149 Case 4] ns1 x/y (should be unchanged):", ns1?.x, ns1?.y);

    expect(result.reason).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Case 5: external arrow inner → outer, inner shape selected
  // filterToIds = { inner } (inner inside frame, outer outside, neither frame selected)
  // Что проверяем: inner shape не двигается (frame = anchor, single top-level node)
  // -----------------------------------------------------------------------
  test("Case 5: external arrow inner→outer, only inner shape selected — inner preserved", async () => {
    const frame = makeFrame("shape:frame5", "frame5", { x: 0, y: 0, w: 400, h: 300 });
    const inner = makeService("shape:inner5", "inner5", { x: 100, y: 100, parentId: "shape:frame5" });
    const outer = makeService("shape:outer5", "outer5", { x: 600, y: 0 });
    // Arrow: inner → outer
    const { arrow, b1, b2 } = makeArrow("shape:arr5", "shape:inner5", "shape:outer5");

    const s = snapshotWith([frame, inner, outer, arrow, b1, b2]);
    const idx = rebuildDidrawIndex(s);

    const result = await runLayout(s, {
      mode: "layered-tb",
      scope: "affected",
      spacing: "normal",
      affectedIds: new Set(["shape:inner5"]),
    }, idx);

    const ns = applyStoreChanges(s, result.batch);
    const updatedKeys = Object.keys(result.batch.updated);

    console.log("[DRW-149 Case 5] reason:", result.reason);
    console.log("[DRW-149 Case 5] batch.updated keys:", updatedKeys);
    const inn = ns.store["shape:inner5"] as TLRecord & { x: number; y: number };
    const outerShape = ns.store["shape:outer5"] as TLRecord & { x: number; y: number };
    const fr = ns.store["shape:frame5"] as TLRecord & { x: number; y: number; props: { w: number; h: number } };
    console.log("[DRW-149 Case 5] inner x/y:", inn?.x, inn?.y, "(original: 100, 100)");
    console.log("[DRW-149 Case 5] outer x/y:", outerShape?.x, outerShape?.y, "(should be unchanged: 600, 0)");
    console.log("[DRW-149 Case 5] frame x/y/w/h:", fr?.x, fr?.y, fr?.props?.w, fr?.props?.h);

    expect(result.reason).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Case 6: pinned envelope — frame is pinned, children selected
  // filterToIds = { child1, child2 }
  // Что проверяем: x/y of pinned frame (anchor) восстанавливается после layout
  // -----------------------------------------------------------------------
  test("Case 6: pinned frame — anchor x/y restored after layout", async () => {
    // Frame at specific coords, pinned
    const frame = makeFrame("shape:frame6", "frame6", { x: 300, y: 400, w: 400, h: 300 });
    // Manually mark it pinned
    (frame as Record<string, unknown>).meta = {
      ...(frame as Record<string, unknown>).meta as object,
      pinned: true,
      position: { x: 300, y: 400 },
    };
    const child1 = makeService("shape:pch1", "pch1", { x: 0, y: 0, parentId: "shape:frame6" });
    const child2 = makeService("shape:pch2", "pch2", { x: 5, y: 0, parentId: "shape:frame6" });

    const s = snapshotWith([frame, child1, child2]);
    const idx = rebuildDidrawIndex(s);

    const result = await runLayout(s, {
      mode: "layered-tb",
      scope: "affected",
      spacing: "normal",
      affectedIds: new Set(["shape:pch1", "shape:pch2"]),
    }, idx);

    const ns = applyStoreChanges(s, result.batch);
    const updatedKeys = Object.keys(result.batch.updated);

    console.log("[DRW-149 Case 6] reason:", result.reason);
    console.log("[DRW-149 Case 6] batch.updated keys:", updatedKeys);
    const fr = ns.store["shape:frame6"] as TLRecord & { x: number; y: number; props: { w: number; h: number } };
    const pc1 = ns.store["shape:pch1"] as TLRecord & { x: number; y: number };
    const pc2 = ns.store["shape:pch2"] as TLRecord & { x: number; y: number };
    console.log("[DRW-149 Case 6] frame x/y/w/h:", fr?.x, fr?.y, fr?.props?.w, fr?.props?.h, "(original x=300, y=400)");
    console.log("[DRW-149 Case 6] pch1 x/y:", pc1?.x, pc1?.y);
    console.log("[DRW-149 Case 6] pch2 x/y:", pc2?.x, pc2?.y);

    expect(result.reason).toBeUndefined();
  });

});
