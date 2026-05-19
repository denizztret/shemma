// Phase 3.0: unit tests for runLayout over TLStoreSnapshot.

import { describe, expect, test } from "bun:test";
import { runLayout } from "../../src/domain/layout";
import { applyStoreChanges, rebuildDidrawIndex } from "../../src/store-ops";
import type { TLRecord, TLStoreSnapshot } from "../../src/store-types";

function emptySnapshot(): TLStoreSnapshot {
  return {
    schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
    store: {
      "document:document": { id: "document:document", typeName: "document" } as TLRecord,
      "page:page": { id: "page:page", typeName: "page" } as TLRecord,
    },
  };
}

function makeShape(
  id: string,
  name: string,
  opts: { x?: number; y?: number; w?: number; h?: number; type?: string; parentId?: string; meta?: Record<string, unknown> } = {},
): TLRecord {
  return {
    id,
    typeName: "shape",
    type: opts.type ?? "geo",
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    parentId: opts.parentId ?? "page:page",
    props: { w: opts.w ?? 100, h: opts.h ?? 60, geo: "rectangle" },
    meta: { didrawName: name, ...(opts.meta ?? {}) },
  } as TLRecord;
}

function makeArrow(id: string, fromId: string, toId: string): { arrow: TLRecord; b1: TLRecord; b2: TLRecord } {
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

function snapshotWith(records: TLRecord[]): TLStoreSnapshot {
  const s = emptySnapshot();
  for (const r of records) s.store[r.id] = r;
  return s;
}

function makeCanvas(): TLStoreSnapshot {
  const a = makeShape("shape:e_a", "a", { meta: { role: "service" } });
  const b = makeShape("shape:e_b", "b", { meta: { role: "datastore" } });
  const { arrow, b1, b2 } = makeArrow("shape:c_0", "shape:e_a", "shape:e_b");
  return snapshotWith([a, b, arrow, b1, b2]);
}

describe("runLayout", () => {
  test("returns positions (via batch updates) for both nodes", async () => {
    const s = makeCanvas();
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all", spacing: "normal" }, idx);
    expect(r.reason).toBeUndefined();
    const ns = applyStoreChanges(s, r.batch);
    expect(ns.store["shape:e_a"]).toBeDefined();
    expect(ns.store["shape:e_b"]).toBeDefined();
  });

  test("layered-lr puts source.x < target.x", async () => {
    const s = makeCanvas();
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all", spacing: "normal" }, idx);
    const ns = applyStoreChanges(s, r.batch);
    expect(ns.store["shape:e_a"]!.x!).toBeLessThan(ns.store["shape:e_b"]!.x!);
  });

  test("pinned node keeps its coordinates (within tolerance)", async () => {
    const a = makeShape("shape:e_a", "a", { x: 500, y: 300, meta: { role: "service", pinned: true, position: { x: 500, y: 300 } } });
    const b = makeShape("shape:e_b", "b", { meta: { role: "datastore" } });
    const { arrow, b1, b2 } = makeArrow("shape:c_0", "shape:e_a", "shape:e_b");
    const s = snapshotWith([a, b, arrow, b1, b2]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all", spacing: "normal" }, idx);
    const ns = applyStoreChanges(s, r.batch);
    expect(Math.abs(ns.store["shape:e_a"]!.x! - 500)).toBeLessThan(5);
    expect(Math.abs(ns.store["shape:e_a"]!.y! - 300)).toBeLessThan(5);
  });

  test("returns reason 'elk-error' when ELK fails (edge references missing node)", async () => {
    const a = makeShape("shape:e_a", "a");
    // Arrow с bindings на отсутствующий target → ELK кинет ошибку.
    const arrow: TLRecord = {
      id: "shape:c_0",
      typeName: "shape",
      type: "arrow",
      x: 0,
      y: 0,
      parentId: "page:page",
      props: {},
      meta: {},
    } as TLRecord;
    const b1: TLRecord = {
      id: "binding:b1",
      typeName: "binding",
      fromId: "shape:c_0",
      toId: "shape:e_a",
      props: { terminal: "start" },
    } as TLRecord;
    const b2: TLRecord = {
      id: "binding:b2",
      typeName: "binding",
      fromId: "shape:c_0",
      toId: "shape:e_missing",
      props: { terminal: "end" },
    } as TLRecord;
    const s = snapshotWith([a, arrow, b1, b2]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all", spacing: "normal" }, idx);
    expect(r.reason).toBe("elk-error");
    expect(Object.keys(r.batch.updated)).toEqual([]);
  });

  test("frame containers become ELK compound nodes — children laid out inside parent", async () => {
    const frame = makeShape("shape:e_vpc", "vpc", { type: "frame", w: 400, h: 200, meta: { didrawIsGroup: true, role: "boundary" } });
    const a = makeShape("shape:e_a", "a", { parentId: "shape:e_vpc", meta: { role: "service" } });
    const b = makeShape("shape:e_b", "b", { parentId: "shape:e_vpc", meta: { role: "service" } });
    const { arrow, b1, b2 } = makeArrow("shape:c_0", "shape:e_a", "shape:e_b");
    const s = snapshotWith([frame, a, b, arrow, b1, b2]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all", spacing: "normal" }, idx);
    const ns = applyStoreChanges(s, r.batch);
    expect(ns.store["shape:e_vpc"]).toBeDefined();
    expect(ns.store["shape:e_a"]).toBeDefined();
    expect(ns.store["shape:e_b"]).toBeDefined();
  });

  // DRW-091: subgraph mode — только selected shapes в batch.updated, non-affected не трогаются.
  test("DRW-091: subgraph mode — non-affected ids absent from batch.updated", async () => {
    const a = makeShape("shape:e_a", "a", { x: 0, y: 0 });
    const b = makeShape("shape:e_b", "b", { x: 50, y: 0 });
    const c = makeShape("shape:e_c", "c", { x: 500, y: 500 });
    const d = makeShape("shape:e_d", "d", { x: 550, y: 500 });
    const s = snapshotWith([a, b, c, d]);
    const idx = rebuildDidrawIndex(s);
    // Only a and b are selected (affected)
    const r = await runLayout(s, {
      mode: "layered-tb",
      scope: "affected",
      spacing: "normal",
      affectedIds: new Set(["shape:e_a", "shape:e_b"]),
    }, idx);
    expect(r.reason).toBeUndefined();
    // c and d must NOT appear in batch.updated
    expect(r.batch.updated["shape:e_c"]).toBeUndefined();
    expect(r.batch.updated["shape:e_d"]).toBeUndefined();
    // c and d must keep original coords
    const ns = applyStoreChanges(s, r.batch);
    expect(ns.store["shape:e_c"]!.x).toBe(500);
    expect(ns.store["shape:e_c"]!.y).toBe(500);
    expect(ns.store["shape:e_d"]!.x).toBe(550);
    expect(ns.store["shape:e_d"]!.y).toBe(500);
  });

  // DRW-091: subgraph mode — selected shapes do not overlap non-selected after layout.
  test("DRW-091: selected laid out independently, do not jump to non-selected territory", async () => {
    const a = makeShape("shape:e_a", "a", { x: 0, y: 0 });
    const b = makeShape("shape:e_b", "b", { x: 10, y: 0 });
    // non-selected far right
    const c = makeShape("shape:e_c", "c", { x: 800, y: 0 });
    const d = makeShape("shape:e_d", "d", { x: 850, y: 0 });
    const s = snapshotWith([a, b, c, d]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, {
      mode: "layered-tb",
      scope: "affected",
      spacing: "normal",
      affectedIds: new Set(["shape:e_a", "shape:e_b"]),
    }, idx);
    const ns = applyStoreChanges(s, r.batch);
    const aAfter = ns.store["shape:e_a"] as { x: number; y: number };
    const bAfter = ns.store["shape:e_b"] as { x: number; y: number };
    // Selected should NOT end up at x >= 800 (non-selected zone)
    expect(aAfter.x).toBeLessThan(700);
    expect(bAfter.x).toBeLessThan(700);
  });

  // DRW-092 v3: anchor frame stays at original x/y, w/h grow under ELK-computed
  // layered output. Children parent-relative against ELK-output frame compound.
  test("DRW-092: anchor frame stays put (x/y), grows to fit children (w/h)", async () => {
    const frame = makeShape("shape:e_frame", "fr", { type: "frame", x: 100, y: 200, w: 400, h: 300 });
    // 4 children clustered at (0,0) relative — disconnected (no edges)
    const c1 = makeShape("shape:e_c1", "c1", { x: 0, y: 0, parentId: "shape:e_frame" });
    const c2 = makeShape("shape:e_c2", "c2", { x: 5, y: 0, parentId: "shape:e_frame" });
    const c3 = makeShape("shape:e_c3", "c3", { x: 0, y: 5, parentId: "shape:e_frame" });
    const c4 = makeShape("shape:e_c4", "c4", { x: 5, y: 5, parentId: "shape:e_frame" });
    const s = snapshotWith([frame, c1, c2, c3, c4]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, {
      mode: "layered-tb",
      scope: "affected",
      spacing: "normal",
      affectedIds: new Set(["shape:e_c1", "shape:e_c2", "shape:e_c3", "shape:e_c4"]),
    }, idx);
    expect(r.reason).toBeUndefined();

    const ns = applyStoreChanges(s, r.batch);
    const fr = ns.store["shape:e_frame"] as { x: number; y: number; props: { w: number; h: number } };
    // Frame x/y unchanged
    expect(fr.x).toBe(100);
    expect(fr.y).toBe(200);
    // Frame w/h may have grown (ELK compound size); MUST be sized to fit children.
    expect(fr.props.w).toBeGreaterThan(0);
    expect(fr.props.h).toBeGreaterThan(0);

    for (const cid of ["shape:e_c1", "shape:e_c2", "shape:e_c3", "shape:e_c4"]) {
      const c = ns.store[cid] as { x: number; y: number; parentId: string; props: { w: number; h: number } };
      expect(c.parentId).toBe("shape:e_frame");
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + (c.props?.w ?? 100)).toBeLessThanOrEqual(fr.props.w + 1);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y + (c.props?.h ?? 60)).toBeLessThanOrEqual(fr.props.h + 1);
    }
  });

  // DRW-082: tldraw shape с parentId=frame хранит x/y RELATIVE к frame.
  // ELK возвращает absolute page coords для всех shapes (collectPositions walks
  // дерево с offset accumulator). Apply должен ВЫЧЕСТЬ frame's abs position из
  // child's abs position перед записью. Иначе при render child уезжает в
  // parent.x + child.x, удваивая offset (видно как off-screen children в 2+
  // groups schemes вроде InlineAdLoader).
  test("DRW-082: frame children stored with parent-relative coords", async () => {
    // 2 frames чтобы поймать кейс где первый frame случайно покрывает диапазон
    // child'а — нужен второй frame в стороне от origin.
    const frameA = makeShape("shape:e_fa", "fa", { type: "frame", w: 300, h: 200, meta: { didrawIsGroup: true, role: "boundary" } });
    const frameB = makeShape("shape:e_fb", "fb", { type: "frame", w: 300, h: 200, meta: { didrawIsGroup: true, role: "boundary" } });
    const a1 = makeShape("shape:e_a1", "a1", { parentId: "shape:e_fa", meta: { role: "service" } });
    const a2 = makeShape("shape:e_a2", "a2", { parentId: "shape:e_fa", meta: { role: "service" } });
    const b1c = makeShape("shape:e_b1", "b1", { parentId: "shape:e_fb", meta: { role: "service" } });
    const b2c = makeShape("shape:e_b2", "b2", { parentId: "shape:e_fb", meta: { role: "service" } });
    // Edge между разными фреймами чтобы ELK раскинул их хорошо.
    const { arrow, b1: ba, b2: bb } = makeArrow("shape:c_0", "shape:e_a1", "shape:e_b1");
    const s = snapshotWith([frameA, frameB, a1, a2, b1c, b2c, arrow, ba, bb]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all", spacing: "normal" }, idx);
    const ns = applyStoreChanges(s, r.batch);
    const fa = ns.store["shape:e_fa"] as { x: number; y: number; props: { w: number; h: number } };
    const fb = ns.store["shape:e_fb"] as { x: number; y: number; props: { w: number; h: number } };
    for (const childId of ["shape:e_a1", "shape:e_a2"]) {
      const c = ns.store[childId] as { x: number; y: number; parentId: string };
      expect(c.parentId).toBe("shape:e_fa");
      // Render position (parent abs + child relative) должна попасть внутрь
      // frame's abs bounds [fa.x, fa.x + fa.props.w] × [fa.y, fa.y + fa.props.h].
      const renderX = fa.x + c.x;
      const renderY = fa.y + c.y;
      expect(renderX).toBeGreaterThanOrEqual(fa.x);
      expect(renderX).toBeLessThan(fa.x + fa.props.w);
      expect(renderY).toBeGreaterThanOrEqual(fa.y);
      expect(renderY).toBeLessThan(fa.y + fa.props.h);
    }
    for (const childId of ["shape:e_b1", "shape:e_b2"]) {
      const c = ns.store[childId] as { x: number; y: number; parentId: string };
      expect(c.parentId).toBe("shape:e_fb");
      const renderX = fb.x + c.x;
      const renderY = fb.y + c.y;
      expect(renderX).toBeGreaterThanOrEqual(fb.x);
      expect(renderX).toBeLessThan(fb.x + fb.props.w);
      expect(renderY).toBeGreaterThanOrEqual(fb.y);
      expect(renderY).toBeLessThan(fb.y + fb.props.h);
    }
  });
});
