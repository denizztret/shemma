// apps/backend/tests/store-ops.test.ts
import { describe, expect, it } from "bun:test";
import { applyStoreChanges, cascadeDeleteShape, findShapeByDidrawName, rebuildDidrawIndex } from "../src/store-ops";
import type { TLStoreSnapshot } from "../src/store-types";

function emptyStore(): TLStoreSnapshot {
  return { schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} }, store: {} };
}

describe("applyStoreChanges", () => {
  it("adds new records", () => {
    const s = emptyStore();
    const ns = applyStoreChanges(s, { added: { "shape:a": { id: "shape:a", typeName: "shape" } }, updated: {}, removed: {} });
    expect(ns.store["shape:a"]).toBeDefined();
  });

  it("updates records (uses new value)", () => {
    const s = emptyStore();
    s.store["shape:a"] = { id: "shape:a", typeName: "shape", x: 0 };
    const ns = applyStoreChanges(s, { added: {}, updated: { "shape:a": [s.store["shape:a"], { id: "shape:a", typeName: "shape", x: 100 }] }, removed: {} });
    expect(ns.store["shape:a"]?.x).toBe(100);
  });

  it("removes records", () => {
    const s = emptyStore();
    s.store["shape:a"] = { id: "shape:a", typeName: "shape" };
    const ns = applyStoreChanges(s, { added: {}, updated: {}, removed: { "shape:a": s.store["shape:a"] } });
    expect(ns.store["shape:a"]).toBeUndefined();
  });

  it("rejects batch with same id in added and removed", () => {
    const s = emptyStore();
    expect(() =>
      applyStoreChanges(s, {
        added: { "shape:a": { id: "shape:a", typeName: "shape" } },
        updated: {},
        removed: { "shape:a": { id: "shape:a", typeName: "shape" } },
      }),
    ).toThrow(/conflicting/);
  });

  it("is pure — does not mutate input snapshot", () => {
    const s = emptyStore();
    s.store["shape:a"] = { id: "shape:a", typeName: "shape" };
    const before = JSON.stringify(s);
    applyStoreChanges(s, { added: { "shape:b": { id: "shape:b", typeName: "shape" } }, updated: {}, removed: {} });
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("findShapeByDidrawName + index", () => {
  it("returns shape with matching meta.didrawName", () => {
    const s = emptyStore();
    s.store["shape:x"] = { id: "shape:x", typeName: "shape", meta: { didrawName: "backend" } };
    s.store["shape:y"] = { id: "shape:y", typeName: "shape", meta: { didrawName: "frontend" } };
    const idx = rebuildDidrawIndex(s);
    expect(idx.get("backend")).toBe("shape:x");
    expect(idx.get("frontend")).toBe("shape:y");
    expect(findShapeByDidrawName(s, idx, "backend")?.id).toBe("shape:x");
    expect(findShapeByDidrawName(s, idx, "unknown")).toBeUndefined();
  });
});

describe("cascadeDeleteShape", () => {
  it("removes arrow bindings referencing the deleted shape", () => {
    const s = emptyStore();
    s.store["shape:a"] = { id: "shape:a", typeName: "shape", type: "geo" };
    s.store["shape:b"] = { id: "shape:b", typeName: "shape", type: "geo" };
    s.store["shape:arr"] = { id: "shape:arr", typeName: "shape", type: "arrow" };
    s.store["binding:1"] = { id: "binding:1", typeName: "binding", fromId: "shape:arr", toId: "shape:a", props: { terminal: "start" } } as any;
    s.store["binding:2"] = { id: "binding:2", typeName: "binding", fromId: "shape:arr", toId: "shape:b", props: { terminal: "end" } } as any;
    const batch = cascadeDeleteShape(s, "shape:a");
    expect(batch.removed["shape:a"]).toBeDefined();
    expect(batch.removed["binding:1"]).toBeDefined();
    // arrow itself removed (it now has only one binding, dangling)
    expect(batch.removed["shape:arr"]).toBeDefined();
    expect(batch.removed["binding:2"]).toBeDefined();
  });

  it("nested frame: deleting frame doesn't auto-delete children (children remain on page)", () => {
    const s = emptyStore();
    s.store["shape:f"] = { id: "shape:f", typeName: "shape", type: "frame" };
    s.store["shape:c"] = { id: "shape:c", typeName: "shape", type: "geo", parentId: "shape:f" };
    const batch = cascadeDeleteShape(s, "shape:f");
    expect(batch.removed["shape:f"]).toBeDefined();
    expect(batch.removed["shape:c"]).toBeUndefined();
    // updated: child gets parentId reset to page:page
    expect(batch.updated["shape:c"]).toBeDefined();
    expect(batch.updated["shape:c"]?.[1].parentId).toBe("page:page");
  });
});
