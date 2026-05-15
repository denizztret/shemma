import { describe, expect, test } from "bun:test";
import { emptyCanvasState } from "../../src/rooms";
import { compile, nameToShapeId } from "../../src/domain/compile";
import type { DomainAction } from "../../src/domain/types";

describe("nameToShapeId", () => {
  test("deterministic mapping", () => {
    expect(nameToShapeId("auth")).toBe(nameToShapeId("auth"));
    expect(nameToShapeId("auth")).not.toBe(nameToShapeId("users-db"));
  });
  test("prefix is shape:e_", () => {
    expect(nameToShapeId("auth")).toBe("shape:e_auth");
  });
});

describe("compile", () => {
  test("define service creates add-node op with role/name meta", () => {
    const acts: DomainAction[] = [{ kind: "define", role: "service", name: "auth" }];
    const r = compile(acts, emptyCanvasState());
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0]).toMatchObject({
      op: "add",
      target: "node",
      value: { id: "shape:e_auth" },
    });
    const value = (r.ops[0] as { value: { meta: Record<string, unknown>; kind: string; label: string } }).value;
    expect(value.meta.role).toBe("service");
    expect(value.meta.name).toBe("auth");
    expect(value.kind).toBe("rect");
    expect(value.label).toBe("auth");
  });

  test("define + connect — intra-batch ref resolves", () => {
    const acts: DomainAction[] = [
      { kind: "define", role: "service", name: "auth" },
      { kind: "define", role: "datastore", name: "db" },
      { kind: "connect", from: "auth", to: "db", connectionKind: "data" },
    ];
    const r = compile(acts, emptyCanvasState());
    const edgeOp = r.ops.find((o) => "target" in o && o.target === "edge") as { value: { from: { id: string }; to: { id: string } } };
    expect(edgeOp.value.from.id).toBe("shape:e_auth");
    expect(edgeOp.value.to.id).toBe("shape:e_db");
  });

  test("group creates add-group with children — children stored only in Group.children", () => {
    const acts: DomainAction[] = [
      { kind: "define", role: "service", name: "a" },
      { kind: "define", role: "service", name: "b" },
      { kind: "group", ids: ["a", "b"], as: "network", name: "vpc" },
    ];
    const r = compile(acts, emptyCanvasState());
    const grp = r.ops.find((o) => "target" in o && o.target === "group");
    expect(grp).toBeDefined();
    const v = (grp as { value: { children: string[]; kind: string } }).value;
    expect(v.children).toEqual(["shape:e_a", "shape:e_b"]);
    expect(v.kind).toBe("frame");
    // verify no Node.meta.parent leak
    const nodeOps = r.ops.filter((o) => "target" in o && o.target === "node");
    for (const op of nodeOps) {
      const set = (op as { value: { meta?: Record<string, unknown> } }).value.meta ?? {};
      expect((set as { parent?: string }).parent).toBeUndefined();
    }
  });

  test("upsert define — second define updates label and meta, NO new node", () => {
    const initial = emptyCanvasState();
    initial.nodes.push({
      id: "shape:e_auth",
      kind: "rect",
      x: 10,
      y: 20,
      label: "auth",
      meta: { name: "auth", role: "service", pinned: true, position: { x: 10, y: 20 } },
    });
    const r = compile(
      [{ kind: "define", role: "service", name: "auth", label: "AUTH-SVC" }],
      initial,
    );
    const upd = r.ops.find((o) => o.op === "update");
    expect(upd).toBeDefined();
    expect(((upd as { id: string }).id)).toBe("shape:e_auth");
    expect(((upd as { set: { label?: string } }).set).label).toBe("AUTH-SVC");
    // pin must NOT be overwritten:
    expect(((upd as { set: { meta?: Record<string, unknown> } }).set.meta ?? {}).pinned).toBeUndefined();
  });

  test("connect creates Edge with both endpoints; style derived from kind", () => {
    const acts: DomainAction[] = [
      { kind: "define", role: "service", name: "a" },
      { kind: "define", role: "service", name: "b" },
      { kind: "connect", from: "a", to: "b", connectionKind: "async" },
    ];
    const r = compile(acts, emptyCanvasState());
    const edge = r.ops.find((o) => "target" in o && o.target === "edge");
    const ev = (edge as { value: { style?: { dashed?: boolean }; meta?: Record<string, unknown> } }).value;
    expect(ev.style?.dashed).toBe(true);
    expect(((ev.meta ?? {}) as { kind?: string }).kind).toBe("async");
  });

  test("delete with cascade flag — only deletes id, does NOT cascade to children automatically (spec puts cascade in patch.ts)", () => {
    const initial = emptyCanvasState();
    initial.nodes.push({ id: "shape:e_x", kind: "rect", x: 0, y: 0, label: "x", meta: { name: "x", role: "service" } });
    const r = compile([{ kind: "delete", id: "x" }], initial);
    expect(r.ops[0]).toMatchObject({ op: "delete", target: "node", id: "shape:e_x" });
  });

  test("upsert with `in` parameter — re-adds element to new container's children", () => {
    const initial = emptyCanvasState();
    initial.nodes.push({ id: "shape:e_x", kind: "rect", x: 0, y: 0, label: "x", meta: { name: "x", role: "service" } });
    initial.groups.push({ id: "shape:e_g1", kind: "frame", children: ["shape:e_x"], label: "g1" });
    initial.groups.push({ id: "shape:e_g2", kind: "frame", children: [], label: "g2" });
    const r = compile([{ kind: "define", role: "service", name: "x", in: "g2" }], initial);
    const gUpdates = r.ops.filter(
      (o): o is { op: "update"; target: "group"; id: string; set: { children?: string[] } } =>
        o.op === "update" && "target" in o && o.target === "group",
    );
    expect(gUpdates).toHaveLength(2);
    const fromG1 = gUpdates.find((o) => o.id === "shape:e_g1")!;
    const toG2 = gUpdates.find((o) => o.id === "shape:e_g2")!;
    expect(fromG1.set.children).toEqual([]);
    expect(toG2.set.children).toEqual(["shape:e_x"]);
  });
});
