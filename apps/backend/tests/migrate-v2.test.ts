// apps/backend/tests/migrate-v2.test.ts
import { describe, expect, it } from "bun:test";
import { migrateV2ToV3 } from "../src/migrate-v2";

const v2Empty = {
  schemaVersion: 2,
  roomId: "r",
  version: 0,
  lastTouched: new Date().toISOString(),
  elementCount: 0,
  canvas: { version: 1, nodes: [], edges: [], groups: [] },
  prompts: [],
  opLog: [],
};

describe("migrate v2 → v3", () => {
  it("empty v2 → v3 with default document + page", () => {
    const v3 = migrateV2ToV3(v2Empty as any);
    expect(v3.schemaVersion).toBe(3);
    expect(v3.store.store["document:document"]).toBeDefined();
    expect(v3.store.store["page:page"]).toBeDefined();
    expect(v3.version).toBe(0);
    expect(v3.opLog).toEqual([]);
  });

  it("node → shape (geo), preserves didrawName/role/pinned in meta", () => {
    const v2 = {
      ...v2Empty,
      canvas: {
        version: 1,
        groups: [],
        edges: [],
        nodes: [
          {
            id: "shape:e_backend",
            kind: "rect",
            x: 100,
            y: 50,
            w: 160,
            h: 90,
            label: "backend",
            style: { fill: "lightBlue" },
            meta: { name: "backend", role: "service", pinned: true, position: { x: 100, y: 50 } },
          },
        ],
      },
    };
    const v3 = migrateV2ToV3(v2 as any);
    const shapes = Object.values(v3.store.store).filter((r) => r.typeName === "shape");
    expect(shapes.length).toBe(1);
    const s = shapes[0]!;
    expect(s.type).toBe("geo");
    expect(s.x).toBe(100);
    expect(s.y).toBe(50);
    expect(s.meta?.didrawName).toBe("backend");
    expect(s.meta?.role).toBe("service");
    expect(s.meta?.pinned).toBe(true);
    expect(s.meta?.position).toEqual({ x: 100, y: 50 });
    expect((s.props as any)?.geo).toBe("rectangle");
  });

  it("node kind → tldraw geo type mapping", () => {
    const v2 = {
      ...v2Empty,
      canvas: {
        version: 1,
        groups: [],
        edges: [],
        nodes: [
          { id: "shape:e_a", kind: "rect", x: 0, y: 0, label: "a" },
          { id: "shape:e_b", kind: "ellipse", x: 0, y: 0, label: "b" },
          { id: "shape:e_c", kind: "diamond", x: 0, y: 0, label: "c" },
          { id: "shape:e_d", kind: "sticky", x: 0, y: 0, label: "d" },
          { id: "shape:e_e", kind: "text", x: 0, y: 0, label: "e" },
        ],
      },
    };
    const v3 = migrateV2ToV3(v2 as any);
    const byName = (n: string) =>
      Object.values(v3.store.store).find((r) => r.meta?.didrawName === n);
    expect(byName("a")?.type).toBe("geo");
    expect((byName("a")?.props as any)?.geo).toBe("rectangle");
    expect((byName("b")?.props as any)?.geo).toBe("ellipse");
    expect((byName("c")?.props as any)?.geo).toBe("diamond");
    expect(byName("d")?.type).toBe("note");
    expect(byName("e")?.type).toBe("text");
  });

  it("group → frame shape; children get parentId", () => {
    const v2 = {
      ...v2Empty,
      canvas: {
        version: 1,
        edges: [],
        nodes: [
          { id: "shape:e_a", kind: "rect", x: 0, y: 0, label: "a" },
          { id: "shape:e_b", kind: "rect", x: 10, y: 10, label: "b" },
        ],
        groups: [
          {
            id: "shape:e_grp",
            kind: "frame",
            children: ["shape:e_a", "shape:e_b"],
            label: "Core",
          },
        ],
      },
    };
    const v3 = migrateV2ToV3(v2 as any);
    const frame = Object.values(v3.store.store).find(
      (r) => r.typeName === "shape" && r.type === "frame",
    );
    expect(frame).toBeDefined();
    // DRW-148: didrawIsGroup removed — field no longer written by migrator.
    expect(frame!.meta?.didrawIsGroup).toBeUndefined();
    expect(frame!.meta?.didrawName).toBe("grp");
    const children = Object.values(v3.store.store).filter(
      (r) => r.typeName === "shape" && r.parentId === frame!.id,
    );
    expect(children.length).toBe(2);
  });

  it("edge → arrow shape + 2 bindings", () => {
    const v2 = {
      ...v2Empty,
      canvas: {
        version: 1,
        groups: [],
        nodes: [
          { id: "shape:e_f", kind: "rect", x: 0, y: 0, label: "f" },
          { id: "shape:e_t", kind: "rect", x: 100, y: 0, label: "t" },
        ],
        edges: [
          {
            id: "shape:c_0",
            from: { kind: "node", id: "shape:e_f" },
            to: { kind: "node", id: "shape:e_t" },
            meta: { kind: "request" },
          },
        ],
      },
    };
    const v3 = migrateV2ToV3(v2 as any);
    const arrows = Object.values(v3.store.store).filter(
      (r) => r.typeName === "shape" && r.type === "arrow",
    );
    expect(arrows.length).toBe(1);
    expect(arrows[0]!.meta?.connectionKind).toBe("request");
    const bindings = Object.values(v3.store.store).filter((r) => r.typeName === "binding");
    expect(bindings.length).toBe(2);
  });

  it("preserves room id, version, prompts; opLog reset", () => {
    const v3 = migrateV2ToV3({ ...v2Empty, version: 42, prompts: [{ id: "p1", selection: [], text: "hi", createdAt: 0, status: "pending" }], opLog: [{}, {}] } as any);
    expect(v3.roomId).toBe("r");
    expect(v3.version).toBe(42);
    expect(v3.prompts.length).toBe(1);
    expect(v3.opLog).toEqual([]);
  });
});
