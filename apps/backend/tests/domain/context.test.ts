import { describe, expect, it } from "bun:test";
import { buildContext, richTextToString } from "../../src/domain/context";
import type { TLStoreSnapshot } from "../../src/store-types";

const richText = (t: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
});

const baseStore = (): TLStoreSnapshot => ({
  schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
  store: {
    "document:document": { id: "document:document", typeName: "document" } as any,
    "page:page": { id: "page:page", typeName: "page" } as any,
  },
});

describe("context view-builder", () => {
  it("emits shape element with role from meta", () => {
    const s = baseStore();
    s.store["shape:x"] = {
      id: "shape:x",
      typeName: "shape",
      type: "geo",
      x: 1,
      y: 2,
      props: { w: 100, h: 60, geo: "rectangle", richText: richText("Backend") },
      meta: { didrawName: "backend", role: "service" },
    } as any;
    const v = buildContext(s, {});
    const e = v.elements.find((el) => el.id === "backend")!;
    expect(e.type).toBe("shape");
    expect(e.role).toBe("service");
    expect(e.label).toBe("Backend");
    expect((e as any).bounds).toBeUndefined();
  });

  it("includeGeometry adds bounds", () => {
    const s = baseStore();
    s.store["shape:x"] = {
      id: "shape:x",
      typeName: "shape",
      type: "geo",
      x: 1,
      y: 2,
      props: { w: 100, h: 60 },
      meta: { didrawName: "a" },
    } as any;
    const v = buildContext(s, { includeGeometry: true });
    expect(v.elements[0]!.bounds).toEqual({ x: 1, y: 2, w: 100, h: 60 });
  });

  it("arrow → connection with from/to didrawName + connectionKind", () => {
    const s = baseStore();
    s.store["shape:f"] = {
      id: "shape:f",
      typeName: "shape",
      type: "geo",
      meta: { didrawName: "front" },
    } as any;
    s.store["shape:b"] = {
      id: "shape:b",
      typeName: "shape",
      type: "geo",
      meta: { didrawName: "back" },
    } as any;
    s.store["shape:arr"] = {
      id: "shape:arr",
      typeName: "shape",
      type: "arrow",
      meta: { connectionKind: "data" },
    } as any;
    s.store["binding:1"] = {
      id: "binding:1",
      typeName: "binding",
      fromId: "shape:arr",
      toId: "shape:f",
      props: { terminal: "start" },
    } as any;
    s.store["binding:2"] = {
      id: "binding:2",
      typeName: "binding",
      fromId: "shape:arr",
      toId: "shape:b",
      props: { terminal: "end" },
    } as any;
    const v = buildContext(s, {});
    const conn = v.elements.find((e) => e.type === "connection")!;
    expect(conn.from).toBe("front");
    expect(conn.to).toBe("back");
    expect(conn.connectionKind).toBe("data");
  });

  it("frame → group with children didrawNames", () => {
    const s = baseStore();
    s.store["shape:f"] = {
      id: "shape:f",
      typeName: "shape",
      type: "frame",
      meta: { didrawName: "core", didrawIsGroup: true, role: "boundary" },
    } as any;
    s.store["shape:a"] = {
      id: "shape:a",
      typeName: "shape",
      type: "geo",
      parentId: "shape:f",
      meta: { didrawName: "a" },
    } as any;
    s.store["shape:b"] = {
      id: "shape:b",
      typeName: "shape",
      type: "geo",
      parentId: "shape:f",
      meta: { didrawName: "b" },
    } as any;
    const v = buildContext(s, {});
    const g = v.elements.find((e) => e.id === "core")!;
    expect(g.type).toBe("group");
    expect(g.children).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("token budget — 100 shapes ≤ 8KB JSON without geometry", () => {
    const s = baseStore();
    for (let i = 0; i < 100; i++) {
      s.store[`shape:s${i}`] = {
        id: `shape:s${i}`,
        typeName: "shape",
        type: "geo",
        x: i,
        y: i,
        props: { w: 100, h: 60, richText: richText(`label-${i}`) },
        meta: { didrawName: `n${i}`, role: "service" },
      } as any;
    }
    const v = buildContext(s, {});
    const bytes = Buffer.byteLength(JSON.stringify(v), "utf-8");
    expect(bytes).toBeLessThanOrEqual(8192);
  });

  it("richTextToString handles empty/null gracefully", () => {
    expect(richTextToString(null)).toBe("");
    expect(richTextToString(undefined)).toBe("");
    expect(richTextToString({})).toBe("");
    expect(richTextToString({ content: [] })).toBe("");
    expect(richTextToString({ content: [{ content: [{ text: "hi" }] }] })).toBe("hi");
  });

  // DRW-084: backend integration test — mermaid subgraphs imported as frames
  // must appear in domain context as type:'group', role:'boundary', children:[ids].
  // This validates the full pipeline: importMermaid sets meta.role + parentId,
  // then context.ts buildContext reads frame → group with children.
  it("DRW-084: mermaid subgraph snapshot → domain context type:group, role:boundary, children", () => {
    // Simulate a snapshot that importMermaid would produce for:
    //   graph TD
    //   subgraph SG1["Layer A"]
    //     api
    //     db
    //   end
    //   subgraph SG2["Layer B"]
    //     worker
    //   end
    // After DRW-084: subgraph shapes are frame type, meta.role="boundary",
    // child nodes have parentId = subgraph frame shape id.
    const s = baseStore();

    // Subgraph 1 frame
    s.store["shape:sg1"] = {
      id: "shape:sg1",
      typeName: "shape",
      type: "frame",
      x: 0, y: 0,
      props: {
        w: 300, h: 200,
        richText: richText("Layer A"),
      },
      meta: { didrawName: "layer-a", role: "boundary" },
    } as any;

    // Subgraph 1 children
    s.store["shape:api"] = {
      id: "shape:api",
      typeName: "shape",
      type: "geo",
      parentId: "shape:sg1",
      x: 10, y: 50,
      props: { w: 120, h: 60, richText: richText("api") },
      meta: { didrawName: "api" },
    } as any;
    s.store["shape:db"] = {
      id: "shape:db",
      typeName: "shape",
      type: "geo",
      parentId: "shape:sg1",
      x: 150, y: 50,
      props: { w: 120, h: 60, richText: richText("db") },
      meta: { didrawName: "db" },
    } as any;

    // Subgraph 2 frame
    s.store["shape:sg2"] = {
      id: "shape:sg2",
      typeName: "shape",
      type: "frame",
      x: 400, y: 0,
      props: {
        w: 200, h: 150,
        richText: richText("Layer B"),
      },
      meta: { didrawName: "layer-b", role: "boundary" },
    } as any;

    // Subgraph 2 child
    s.store["shape:worker"] = {
      id: "shape:worker",
      typeName: "shape",
      type: "geo",
      parentId: "shape:sg2",
      x: 10, y: 50,
      props: { w: 120, h: 60, richText: richText("worker") },
      meta: { didrawName: "worker" },
    } as any;

    const v = buildContext(s, {});

    // Two subgraph frames must appear as type:group, role:boundary.
    const sg1 = v.elements.find((e) => e.id === "layer-a")!;
    const sg2 = v.elements.find((e) => e.id === "layer-b")!;

    expect(sg1).toBeDefined();
    expect(sg1.type).toBe("group");
    expect(sg1.role).toBe("boundary");
    expect(sg1.label).toBe("Layer A");
    expect(sg1.children).toEqual(expect.arrayContaining(["api", "db"]));
    expect(sg1.children!.length).toBe(2);

    expect(sg2).toBeDefined();
    expect(sg2.type).toBe("group");
    expect(sg2.role).toBe("boundary");
    expect(sg2.label).toBe("Layer B");
    expect(sg2.children).toEqual(["worker"]);

    // Inner nodes must NOT appear as groups.
    const apiEl = v.elements.find((e) => e.id === "api")!;
    expect(apiEl.type).toBe("shape");
    expect(apiEl.children).toBeUndefined();

    // Total 5 shapes: 2 frames + 3 children.
    expect(v.elements.length).toBe(5);
  });
});
