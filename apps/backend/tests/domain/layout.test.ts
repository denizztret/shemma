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
    const frame = makeShape("shape:e_vpc", "vpc", { type: "frame", w: 400, h: 200, meta: { role: "boundary" } });
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
    const frameA = makeShape("shape:e_fa", "fa", { type: "frame", w: 300, h: 200, meta: { role: "boundary" } });
    const frameB = makeShape("shape:e_fb", "fb", { type: "frame", w: 300, h: 200, meta: { role: "boundary" } });
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

  // =====================================================================
  // DRW-099: Hierarchical multi-pass layout for nested compounds
  // =====================================================================

  // Test 1: Два контейнера с детьми + cross-compound edge.
  // Select all children + both containers.
  // Expected: children расставлены внутри своих контейнеров (parent-relative),
  // контейнеры расставлены относительно друг друга в Pass B.
  test("DRW-099 hierarchical: two containers with children + cross-compound edge — all selected", async () => {
    // Container A: frame с 3 детьми
    const frameA = makeShape("shape:e_fa", "fa", {
      type: "frame", x: 0, y: 0, w: 400, h: 300,
    });
    const a1 = makeShape("shape:e_a1", "a1", { parentId: "shape:e_fa", x: 0, y: 0 });
    const a2 = makeShape("shape:e_a2", "a2", { parentId: "shape:e_fa", x: 5, y: 0 });
    const a3 = makeShape("shape:e_a3", "a3", { parentId: "shape:e_fa", x: 0, y: 5 });
    // Container B: frame с 2 детьми
    const frameB = makeShape("shape:e_fb", "fb", {
      type: "frame", x: 500, y: 0, w: 400, h: 300,
    });
    const b1 = makeShape("shape:e_b1", "b1", { parentId: "shape:e_fb", x: 0, y: 0 });
    const b2 = makeShape("shape:e_b2", "b2", { parentId: "shape:e_fb", x: 5, y: 0 });
    // Cross-compound edge: a1 → b1
    const { arrow, b1: ba, b2: bb } = makeArrow("shape:c_0", "shape:e_a1", "shape:e_b1");

    const s = snapshotWith([frameA, a1, a2, a3, frameB, b1, b2, arrow, ba, bb]);
    const idx = rebuildDidrawIndex(s);

    // Select all children + both frames
    const affectedIds = new Set([
      "shape:e_fa", "shape:e_fb",
      "shape:e_a1", "shape:e_a2", "shape:e_a3",
      "shape:e_b1", "shape:e_b2",
    ]);
    const r = await runLayout(s, {
      mode: "layered-tb",
      scope: "affected",
      spacing: "normal",
      affectedIds,
    }, idx);

    expect(r.reason).toBeUndefined();
    const ns = applyStoreChanges(s, r.batch);

    // Children должны оставаться parent-relative внутри своих контейнеров
    const fa = ns.store["shape:e_fa"] as { x: number; y: number; props: { w: number; h: number } };
    const fb = ns.store["shape:e_fb"] as { x: number; y: number; props: { w: number; h: number } };

    // Frames должны иметь корректные размеры (non-zero)
    expect(fa.props.w).toBeGreaterThan(0);
    expect(fa.props.h).toBeGreaterThan(0);
    expect(fb.props.w).toBeGreaterThan(0);
    expect(fb.props.h).toBeGreaterThan(0);

    // Дети frameA parent-relative и внутри bounds
    for (const cid of ["shape:e_a1", "shape:e_a2", "shape:e_a3"]) {
      const c = ns.store[cid] as { x: number; y: number; parentId: string; props: { w: number; h: number } };
      expect(c.parentId).toBe("shape:e_fa");
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + (c.props?.w ?? 100)).toBeLessThanOrEqual(fa.props.w + 5);
      expect(c.y + (c.props?.h ?? 60)).toBeLessThanOrEqual(fa.props.h + 5);
    }

    // Дети frameB parent-relative и внутри bounds
    for (const cid of ["shape:e_b1", "shape:e_b2"]) {
      const c = ns.store[cid] as { x: number; y: number; parentId: string; props: { w: number; h: number } };
      expect(c.parentId).toBe("shape:e_fb");
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + (c.props?.w ?? 100)).toBeLessThanOrEqual(fb.props.w + 5);
      expect(c.y + (c.props?.h ?? 60)).toBeLessThanOrEqual(fb.props.h + 5);
    }

    // Frames должны быть расставлены (хотя бы один переместился от исходных coords)
    // Обе frames в batch.updated
    expect(r.batch.updated["shape:e_fa"]).toBeDefined();
    expect(r.batch.updated["shape:e_fb"]).toBeDefined();
  });

  // Test 2: Mixed selection — 1 frame at root + 1 bare shape at root + edge between.
  // DRW-149 G3 update: frame-expand applies unconditionally — frame.children also get
  // laid out (Pass A inside frame), frame resizes, frame + bare laid out at top level (Pass B).
  test("DRW-099 hierarchical: mixed root selection (frame + bare shape) — both laid out at top level (G3 expansion)", async () => {
    const frame = makeShape("shape:e_frm", "frm", {
      type: "frame", x: 500, y: 500, w: 300, h: 200,
    });
    // Child of frame — NOT in selection, but G3 frame-expand will include it
    const child = makeShape("shape:e_ch", "ch", { parentId: "shape:e_frm", x: 10, y: 10 });
    // Bare shape at root — offset so it will need to move
    const bare = makeShape("shape:e_bare", "bare", { x: 500, y: 500 });
    // Edge: frame → bare
    const { arrow, b1, b2 } = makeArrow("shape:c_0", "shape:e_frm", "shape:e_bare");

    const s = snapshotWith([frame, child, bare, arrow, b1, b2]);
    const idx = rebuildDidrawIndex(s);

    // Select frame + bare (NOT child) — G3 frame-expand добавит child в Pass A
    const affectedIds = new Set(["shape:e_frm", "shape:e_bare"]);
    const r = await runLayout(s, {
      mode: "layered-lr",
      scope: "affected",
      spacing: "normal",
      affectedIds,
    }, idx);

    expect(r.reason).toBeUndefined();
    const ns = applyStoreChanges(s, r.batch);

    // Хотя бы один из двух (frame или bare) должен быть laid out (оба в Pass B)
    // ELK может сохранить один из них на старом месте если они уже оптимально расположены,
    // но оба overlapping (500,500) — layout разделит их.
    const anyMoved =
      r.batch.updated["shape:e_frm"] !== undefined ||
      r.batch.updated["shape:e_bare"] !== undefined;
    expect(anyMoved).toBe(true);

    // Результат не должен иметь overlapping (frame + bare не перекрываются)
    const frmAfter = ns.store["shape:e_frm"] as { x: number; y: number; props: { w: number; h: number } };
    const bareAfter = ns.store["shape:e_bare"] as { x: number; y: number; props: { w: number; h: number } };
    const frmW = frmAfter.props?.w ?? 300;
    const frmH = frmAfter.props?.h ?? 200;
    const bareW = bareAfter.props?.w ?? 100;
    const bareH = bareAfter.props?.h ?? 60;
    const noOverlap =
      frmAfter.x + frmW <= bareAfter.x + 5 ||
      bareAfter.x + bareW <= frmAfter.x + 5 ||
      frmAfter.y + frmH <= bareAfter.y + 5 ||
      bareAfter.y + bareH <= frmAfter.y + 5;
    expect(noOverlap).toBe(true);
  });

  // Test 3: Anchor frame nested — frame F1 содержит frame F2 содержит 2 детей.
  // Select только 2 детей → Pass A recursive: F2 растёт, F1 растёт под F2.
  test("DRW-099 hierarchical: nested anchor frames — inner frame grows, children stay inside", async () => {
    // Outer frame F1 (not selected)
    const f1 = makeShape("shape:e_f1", "f1", {
      type: "frame", x: 100, y: 100, w: 600, h: 500,
    });
    // Inner frame F2, child of F1 (not selected)
    const f2 = makeShape("shape:e_f2", "f2", {
      type: "frame", x: 10, y: 10, w: 400, h: 300,
      parentId: "shape:e_f1",
    });
    // Children of F2 (selected)
    const c1 = makeShape("shape:e_c1", "c1", { parentId: "shape:e_f2", x: 0, y: 0 });
    const c2 = makeShape("shape:e_c2", "c2", { parentId: "shape:e_f2", x: 5, y: 0 });
    const { arrow, b1, b2 } = makeArrow("shape:c_0", "shape:e_c1", "shape:e_c2");

    const s = snapshotWith([f1, f2, c1, c2, arrow, b1, b2]);
    const idx = rebuildDidrawIndex(s);

    // Только children в selection
    const affectedIds = new Set(["shape:e_c1", "shape:e_c2"]);
    const r = await runLayout(s, {
      mode: "layered-lr",
      scope: "affected",
      spacing: "normal",
      affectedIds,
    }, idx);

    expect(r.reason).toBeUndefined();
    const ns = applyStoreChanges(s, r.batch);

    // Children должны быть parent-relative внутри F2
    const f2after = ns.store["shape:e_f2"] as { x: number; y: number; parentId: string; props: { w: number; h: number } };
    expect(f2after.parentId).toBe("shape:e_f1");

    for (const cid of ["shape:e_c1", "shape:e_c2"]) {
      const c = ns.store[cid] as { x: number; y: number; parentId: string; props: { w: number; h: number } };
      expect(c.parentId).toBe("shape:e_f2");
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
    }

    // F2 должен получить w/h под содержимое
    expect(f2after.props.w).toBeGreaterThan(0);
    expect(f2after.props.h).toBeGreaterThan(0);

    // F1 остаётся на месте (anchor) — x/y не меняются
    const f1after = ns.store["shape:e_f1"] as { x: number; y: number };
    expect(f1after.x).toBe(100);
    expect(f1after.y).toBe(100);
  });

  // Test 4: Cross-compound edges с оба containers в Pass B.
  // Containers + children all selected. Edge child_A → child_B создаёт
  // container-to-container edge в Pass B.
  test("DRW-099 hierarchical: cross-compound edges create container-to-container edge in Pass B", async () => {
    const fA = makeShape("shape:e_fA", "fA", {
      type: "frame", x: 0, y: 0, w: 300, h: 200,
    });
    const fB = makeShape("shape:e_fB", "fB", {
      type: "frame", x: 0, y: 0, w: 300, h: 200,
    });
    const cA = makeShape("shape:e_cA", "cA", { parentId: "shape:e_fA", x: 0, y: 0 });
    const cB = makeShape("shape:e_cB", "cB", { parentId: "shape:e_fB", x: 0, y: 0 });
    // Cross-compound edge: cA → cB (in layered-lr this should push fA left of fB)
    const { arrow, b1, b2 } = makeArrow("shape:c_0", "shape:e_cA", "shape:e_cB");

    const s = snapshotWith([fA, fB, cA, cB, arrow, b1, b2]);
    const idx = rebuildDidrawIndex(s);

    const affectedIds = new Set(["shape:e_fA", "shape:e_fB", "shape:e_cA", "shape:e_cB"]);
    const r = await runLayout(s, {
      mode: "layered-lr",
      scope: "affected",
      spacing: "normal",
      affectedIds,
    }, idx);

    expect(r.reason).toBeUndefined();
    const ns = applyStoreChanges(s, r.batch);

    // Both frames should be laid out
    expect(r.batch.updated["shape:e_fA"]).toBeDefined();
    expect(r.batch.updated["shape:e_fB"]).toBeDefined();

    // Frames should not overlap each other (with slack)
    const faAfter = ns.store["shape:e_fA"] as { x: number; y: number; props: { w: number; h: number } };
    const fbAfter = ns.store["shape:e_fB"] as { x: number; y: number; props: { w: number; h: number } };
    const noOverlap =
      faAfter.x + faAfter.props.w <= fbAfter.x + 5 ||
      fbAfter.x + fbAfter.props.w <= faAfter.x + 5 ||
      faAfter.y + faAfter.props.h <= fbAfter.y + 5 ||
      fbAfter.y + fbAfter.props.h <= faAfter.y + 5;
    expect(noOverlap).toBe(true);

    // Children stay inside respective frames
    const cAf = ns.store["shape:e_cA"] as { x: number; y: number; parentId: string; props: { w: number; h: number } };
    const cBf = ns.store["shape:e_cB"] as { x: number; y: number; parentId: string; props: { w: number; h: number } };
    expect(cAf.parentId).toBe("shape:e_fA");
    expect(cBf.parentId).toBe("shape:e_fB");
    expect(cAf.x + (cAf.props?.w ?? 100)).toBeLessThanOrEqual(faAfter.props.w + 5);
    expect(cBf.x + (cBf.props?.w ?? 100)).toBeLessThanOrEqual(fbAfter.props.w + 5);
  });

  // =====================================================================
  // DRW-152: per-subgraph direction → ELK inner pass uses container direction
  // =====================================================================

  // Test DRW-152-A: geo+boundary container with meta.didrawSubgraphDirection=LR
  // → children should spread horizontally (diffX > diffY).
  test("DRW-152: subgraph with direction LR → children spread horizontally", async () => {
    // geo+boundary container with LR direction (mermaid subgraph)
    const container = makeShape("shape:e_sg", "sg", {
      type: "geo",
      x: 0, y: 0, w: 400, h: 300,
      meta: { role: "boundary", didrawSubgraphDirection: "LR" },
    });
    const a = makeShape("shape:e_a", "a", { parentId: "shape:e_sg", x: 0, y: 0 });
    const b = makeShape("shape:e_b", "b", { parentId: "shape:e_sg", x: 5, y: 0 });
    const c = makeShape("shape:e_c", "c", { parentId: "shape:e_sg", x: 0, y: 5 });
    // Chain: a → b → c (so ELK has to rank them in LR order)
    const { arrow: arr1, b1: ba1, b2: bb1 } = makeArrow("shape:c_0", "shape:e_a", "shape:e_b");
    const { arrow: arr2, b1: ba2, b2: bb2 } = makeArrow("shape:c_1", "shape:e_b", "shape:e_c");

    const s = snapshotWith([container, a, b, c, arr1, ba1, bb1, arr2, ba2, bb2]);
    const idx = rebuildDidrawIndex(s);

    const affectedIds = new Set(["shape:e_sg"]);
    const r = await runLayout(s, {
      mode: "layered-tb",  // outer mode is TB but inner should override to LR
      scope: "affected",
      spacing: "normal",
      affectedIds,
    }, idx);

    expect(r.reason).toBeUndefined();
    const ns = applyStoreChanges(s, r.batch);

    const aAfter = ns.store["shape:e_a"] as { x: number; y: number };
    const bAfter = ns.store["shape:e_b"] as { x: number; y: number };
    const cAfter = ns.store["shape:e_c"] as { x: number; y: number };

    // LR: nodes should differ more in X than Y (horizontal spread dominant)
    const xRange = Math.max(aAfter.x, bAfter.x, cAfter.x) - Math.min(aAfter.x, bAfter.x, cAfter.x);
    const yRange = Math.max(aAfter.y, bAfter.y, cAfter.y) - Math.min(aAfter.y, bAfter.y, cAfter.y);
    expect(xRange).toBeGreaterThan(yRange);
  });

  // Test DRW-152-B: geo+boundary container with meta.didrawSubgraphDirection=TB
  // → children should spread vertically (diffY > diffX).
  test("DRW-152: subgraph with direction TB → children spread vertically", async () => {
    const container = makeShape("shape:e_sg", "sg", {
      type: "geo",
      x: 0, y: 0, w: 400, h: 300,
      meta: { role: "boundary", didrawSubgraphDirection: "TB" },
    });
    const a = makeShape("shape:e_a", "a", { parentId: "shape:e_sg", x: 0, y: 0 });
    const b = makeShape("shape:e_b", "b", { parentId: "shape:e_sg", x: 5, y: 0 });
    const c = makeShape("shape:e_c", "c", { parentId: "shape:e_sg", x: 0, y: 5 });
    const { arrow: arr1, b1: ba1, b2: bb1 } = makeArrow("shape:c_0", "shape:e_a", "shape:e_b");
    const { arrow: arr2, b1: ba2, b2: bb2 } = makeArrow("shape:c_1", "shape:e_b", "shape:e_c");

    const s = snapshotWith([container, a, b, c, arr1, ba1, bb1, arr2, ba2, bb2]);
    const idx = rebuildDidrawIndex(s);

    const affectedIds = new Set(["shape:e_sg"]);
    const r = await runLayout(s, {
      mode: "layered-lr",  // outer mode is LR but inner should override to TB
      scope: "affected",
      spacing: "normal",
      affectedIds,
    }, idx);

    expect(r.reason).toBeUndefined();
    const ns = applyStoreChanges(s, r.batch);

    const aAfter = ns.store["shape:e_a"] as { x: number; y: number };
    const bAfter = ns.store["shape:e_b"] as { x: number; y: number };
    const cAfter = ns.store["shape:e_c"] as { x: number; y: number };

    // TB: nodes should differ more in Y than X (vertical spread dominant)
    const xRange = Math.max(aAfter.x, bAfter.x, cAfter.x) - Math.min(aAfter.x, bAfter.x, cAfter.x);
    const yRange = Math.max(aAfter.y, bAfter.y, cAfter.y) - Math.min(aAfter.y, bAfter.y, cAfter.y);
    expect(yRange).toBeGreaterThan(xRange);
  });

  // Test DRW-152-C: two containers with different per-subgraph directions — each uses its own.
  test("DRW-152: two subgraphs with mixed directions — each uses its own direction", async () => {
    // Container A: direction LR
    const sgA = makeShape("shape:e_sgA", "sgA", {
      type: "geo",
      x: 0, y: 0, w: 400, h: 300,
      meta: { role: "boundary", didrawSubgraphDirection: "LR" },
    });
    const a1 = makeShape("shape:e_a1", "a1", { parentId: "shape:e_sgA", x: 0, y: 0 });
    const a2 = makeShape("shape:e_a2", "a2", { parentId: "shape:e_sgA", x: 5, y: 0 });
    const a3 = makeShape("shape:e_a3", "a3", { parentId: "shape:e_sgA", x: 0, y: 5 });
    const { arrow: ar1, b1: ab1, b2: ab2 } = makeArrow("shape:c_0", "shape:e_a1", "shape:e_a2");
    const { arrow: ar2, b1: ab3, b2: ab4 } = makeArrow("shape:c_1", "shape:e_a2", "shape:e_a3");

    // Container B: direction TB
    const sgB = makeShape("shape:e_sgB", "sgB", {
      type: "geo",
      x: 500, y: 0, w: 400, h: 300,
      meta: { role: "boundary", didrawSubgraphDirection: "TB" },
    });
    const b1 = makeShape("shape:e_b1", "b1", { parentId: "shape:e_sgB", x: 0, y: 0 });
    const b2 = makeShape("shape:e_b2", "b2", { parentId: "shape:e_sgB", x: 5, y: 0 });
    const b3 = makeShape("shape:e_b3", "b3", { parentId: "shape:e_sgB", x: 0, y: 5 });
    const { arrow: br1, b1: bb1, b2: bb2 } = makeArrow("shape:c_2", "shape:e_b1", "shape:e_b2");
    const { arrow: br2, b1: bb3, b2: bb4 } = makeArrow("shape:c_3", "shape:e_b2", "shape:e_b3");

    const s = snapshotWith([
      sgA, a1, a2, a3, ar1, ab1, ab2, ar2, ab3, ab4,
      sgB, b1, b2, b3, br1, bb1, bb2, br2, bb3, bb4,
    ]);
    const idx = rebuildDidrawIndex(s);

    const affectedIds = new Set(["shape:e_sgA", "shape:e_sgB"]);
    const r = await runLayout(s, {
      mode: "layered-tb",
      scope: "affected",
      spacing: "normal",
      affectedIds,
    }, idx);

    expect(r.reason).toBeUndefined();
    const ns = applyStoreChanges(s, r.batch);

    // Container A children (LR): x-spread dominant
    const a1f = ns.store["shape:e_a1"] as { x: number; y: number };
    const a2f = ns.store["shape:e_a2"] as { x: number; y: number };
    const a3f = ns.store["shape:e_a3"] as { x: number; y: number };
    const axRange = Math.max(a1f.x, a2f.x, a3f.x) - Math.min(a1f.x, a2f.x, a3f.x);
    const ayRange = Math.max(a1f.y, a2f.y, a3f.y) - Math.min(a1f.y, a2f.y, a3f.y);
    expect(axRange).toBeGreaterThan(ayRange);

    // Container B children (TB): y-spread dominant
    const b1f = ns.store["shape:e_b1"] as { x: number; y: number };
    const b2f = ns.store["shape:e_b2"] as { x: number; y: number };
    const b3f = ns.store["shape:e_b3"] as { x: number; y: number };
    const bxRange = Math.max(b1f.x, b2f.x, b3f.x) - Math.min(b1f.x, b2f.x, b3f.x);
    const byRange = Math.max(b1f.y, b2f.y, b3f.y) - Math.min(b1f.y, b2f.y, b3f.y);
    expect(byRange).toBeGreaterThan(bxRange);
  });

  // Test DRW-152-D: container WITHOUT direction → uses outer layout mode direction (no regression).
  test("DRW-152: subgraph WITHOUT direction uses outer layout mode (no regression)", async () => {
    const container = makeShape("shape:e_sg", "sg", {
      type: "geo",
      x: 0, y: 0, w: 400, h: 300,
      meta: { role: "boundary" },  // no didrawSubgraphDirection
    });
    const a = makeShape("shape:e_a", "a", { parentId: "shape:e_sg", x: 0, y: 0 });
    const b = makeShape("shape:e_b", "b", { parentId: "shape:e_sg", x: 5, y: 0 });
    const c = makeShape("shape:e_c", "c", { parentId: "shape:e_sg", x: 0, y: 5 });
    const { arrow: arr1, b1: ba1, b2: bb1 } = makeArrow("shape:c_0", "shape:e_a", "shape:e_b");
    const { arrow: arr2, b1: ba2, b2: bb2 } = makeArrow("shape:c_1", "shape:e_b", "shape:e_c");

    const s = snapshotWith([container, a, b, c, arr1, ba1, bb1, arr2, ba2, bb2]);
    const idx = rebuildDidrawIndex(s);

    // Use layered-lr as outer mode — without subgraph direction, inner should also be LR
    const affectedIds = new Set(["shape:e_sg"]);
    const r = await runLayout(s, {
      mode: "layered-lr",
      scope: "affected",
      spacing: "normal",
      affectedIds,
    }, idx);

    expect(r.reason).toBeUndefined();
    const ns = applyStoreChanges(s, r.batch);

    const aAfter = ns.store["shape:e_a"] as { x: number; y: number };
    const bAfter = ns.store["shape:e_b"] as { x: number; y: number };
    const cAfter = ns.store["shape:e_c"] as { x: number; y: number };

    // LR (outer inherited): x-spread dominant
    const xRange = Math.max(aAfter.x, bAfter.x, cAfter.x) - Math.min(aAfter.x, bAfter.x, cAfter.x);
    const yRange = Math.max(aAfter.y, bAfter.y, cAfter.y) - Math.min(aAfter.y, bAfter.y, cAfter.y);
    expect(xRange).toBeGreaterThan(yRange);
  });

  // Test 5: scope='all' path NOT broken — still single-pass, все shapes laid out.
  test("DRW-099 hierarchical: scope=all still works as single-pass (regression)", async () => {
    const frameA = makeShape("shape:e_fa", "fa", {
      type: "frame", x: 0, y: 0, w: 300, h: 200,
    });
    const frameB = makeShape("shape:e_fb", "fb", {
      type: "frame", x: 0, y: 0, w: 300, h: 200,
    });
    const a1 = makeShape("shape:e_a1", "a1", { parentId: "shape:e_fa", x: 0, y: 0 });
    const b1 = makeShape("shape:e_b1", "b1", { parentId: "shape:e_fb", x: 0, y: 0 });
    const { arrow, b1: ba, b2: bb } = makeArrow("shape:c_0", "shape:e_a1", "shape:e_b1");

    const s = snapshotWith([frameA, frameB, a1, b1, arrow, ba, bb]);
    const idx = rebuildDidrawIndex(s);

    const r = await runLayout(s, {
      mode: "layered-lr",
      scope: "all",
      spacing: "normal",
    }, idx);

    expect(r.reason).toBeUndefined();
    // All nodes should appear in batch
    const updatedKeys = Object.keys(r.batch.updated);
    // At minimum frames should be updated (or all shapes)
    expect(updatedKeys.length).toBeGreaterThan(0);

    const ns = applyStoreChanges(s, r.batch);
    // Children still have parent-relative coords
    const fa = ns.store["shape:e_fa"] as { x: number; y: number; props: { w: number; h: number } };
    const fb = ns.store["shape:e_fb"] as { x: number; y: number; props: { w: number; h: number } };
    const a1ns = ns.store["shape:e_a1"] as { x: number; y: number; parentId: string };
    const b1ns = ns.store["shape:e_b1"] as { x: number; y: number; parentId: string };
    expect(a1ns.parentId).toBe("shape:e_fa");
    expect(b1ns.parentId).toBe("shape:e_fb");
    // layered-lr: frameA should be left of frameB
    expect(fa.x).toBeLessThan(fb.x);
  });
});
