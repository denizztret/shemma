import { describe, expect, it } from "bun:test";
import { compile } from "../src/domain/compile";
import { rebuildDidrawIndex } from "../src/store-ops";
import type { TLRecord, TLStoreSnapshot } from "../src/store-types";

const emptyStore = (): TLStoreSnapshot => ({
  schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
  store: {
    "document:document": { id: "document:document", typeName: "document" } as TLRecord,
    "page:page": { id: "page:page", typeName: "page" } as TLRecord,
  },
});

describe("compile.define", () => {
  it("creates a new geo shape with didrawName + role", () => {
    const s = emptyStore();
    const idx = rebuildDidrawIndex(s);
    const r = compile([{ kind: "define", name: "backend", role: "service" }], s, idx);
    const added = Object.values(r.batch.added);
    expect(added.length).toBe(1);
    expect(added[0]!.typeName).toBe("shape");
    expect(added[0]!.type).toBe("geo");
    expect(added[0]!.meta?.didrawName).toBe("backend");
    expect(added[0]!.meta?.role).toBe("service");
    expect(r.elementIds[0]).toBe("backend");
  });

  it("upsert mode — defining same name returns update, preserves meta.pinned/position", () => {
    const s = emptyStore();
    s.store["shape:abc"] = {
      id: "shape:abc",
      typeName: "shape",
      type: "geo",
      x: 100,
      y: 50,
      meta: { didrawName: "backend", pinned: true, position: { x: 100, y: 50 } },
    } as TLRecord;
    const idx = rebuildDidrawIndex(s);
    const r = compile(
      [{ kind: "define", name: "backend", role: "service", label: "Backend API" }],
      s,
      idx,
    );
    expect(Object.keys(r.batch.added).length).toBe(0);
    expect(r.batch.updated["shape:abc"]).toBeDefined();
    const newR = r.batch.updated["shape:abc"]![1];
    expect(newR.meta?.pinned).toBe(true);
    expect(newR.meta?.position).toEqual({ x: 100, y: 50 });
    expect(newR.meta?.role).toBe("service");
  });
});

describe("compile.connect", () => {
  it("creates arrow shape + 2 bindings", () => {
    const s = emptyStore();
    s.store["shape:f"] = {
      id: "shape:f",
      typeName: "shape",
      type: "geo",
      meta: { didrawName: "front" },
    } as TLRecord;
    s.store["shape:b"] = {
      id: "shape:b",
      typeName: "shape",
      type: "geo",
      meta: { didrawName: "back" },
    } as TLRecord;
    const idx = rebuildDidrawIndex(s);
    const r = compile(
      [{ kind: "connect", from: "front", to: "back", connectionKind: "data" }],
      s,
      idx,
    );
    const arrows = Object.values(r.batch.added).filter(
      (x) => x.typeName === "shape" && x.type === "arrow",
    );
    const bindings = Object.values(r.batch.added).filter((x) => x.typeName === "binding");
    expect(arrows.length).toBe(1);
    expect(arrows[0]!.meta?.connectionKind).toBe("data");
    expect(bindings.length).toBe(2);
  });
});

describe("compile.group", () => {
  it("creates frame + sets parentId on members", () => {
    const s = emptyStore();
    s.store["shape:a"] = {
      id: "shape:a",
      typeName: "shape",
      type: "geo",
      meta: { didrawName: "a" },
    } as TLRecord;
    s.store["shape:b"] = {
      id: "shape:b",
      typeName: "shape",
      type: "geo",
      meta: { didrawName: "b" },
    } as TLRecord;
    const idx = rebuildDidrawIndex(s);
    const r = compile(
      [{ kind: "group", name: "core", as: "boundary", ids: ["a", "b"] }],
      s,
      idx,
    );
    const frames = Object.values(r.batch.added).filter(
      (x) => x.typeName === "shape" && x.type === "frame",
    );
    expect(frames.length).toBe(1);
    const frameId = frames[0]!.id;
    expect(r.batch.updated["shape:a"]![1].parentId).toBe(frameId);
    expect(r.batch.updated["shape:b"]![1].parentId).toBe(frameId);
  });
});

describe("compile.note", () => {
  it("creates note shape with text", () => {
    const s = emptyStore();
    const idx = rebuildDidrawIndex(s);
    const r = compile([{ kind: "note", text: "todo: optimize" }], s, idx);
    const notes = Object.values(r.batch.added).filter(
      (x) => x.typeName === "shape" && x.type === "note",
    );
    expect(notes.length).toBe(1);
    expect((notes[0]!.props as Record<string, unknown>)?.richText).toBeDefined();
  });
});

describe("compile.delete", () => {
  it("cascades arrow bindings", () => {
    const s = emptyStore();
    s.store["shape:a"] = {
      id: "shape:a",
      typeName: "shape",
      type: "geo",
      meta: { didrawName: "a" },
    } as TLRecord;
    s.store["shape:b"] = {
      id: "shape:b",
      typeName: "shape",
      type: "geo",
      meta: { didrawName: "b" },
    } as TLRecord;
    s.store["shape:arr"] = {
      id: "shape:arr",
      typeName: "shape",
      type: "arrow",
      meta: { connectionKind: "sync" },
    } as TLRecord;
    s.store["binding:1"] = {
      id: "binding:1",
      typeName: "binding",
      fromId: "shape:arr",
      toId: "shape:a",
      props: { terminal: "start" },
    } as TLRecord;
    s.store["binding:2"] = {
      id: "binding:2",
      typeName: "binding",
      fromId: "shape:arr",
      toId: "shape:b",
      props: { terminal: "end" },
    } as TLRecord;
    const idx = rebuildDidrawIndex(s);
    const r = compile([{ kind: "delete", id: "a" }], s, idx);
    expect(r.batch.removed["shape:a"]).toBeDefined();
    expect(r.batch.removed["binding:1"]).toBeDefined();
    expect(r.batch.removed["shape:arr"]).toBeDefined(); // dangling arrow
  });
});

describe("compile.layout (no-op at compile stage)", () => {
  it("returns empty batch — ELK runs in orchestrator", () => {
    const s = emptyStore();
    const idx = rebuildDidrawIndex(s);
    const r = compile([{ kind: "layout", mode: "layered" }], s, idx);
    expect(Object.keys(r.batch.added).length).toBe(0);
    expect(Object.keys(r.batch.updated).length).toBe(0);
    expect(Object.keys(r.batch.removed).length).toBe(0);
  });
});
