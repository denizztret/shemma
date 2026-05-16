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
});
