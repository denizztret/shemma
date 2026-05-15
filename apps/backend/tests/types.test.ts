import { describe, expect, test } from "bun:test";
import type {
  CanvasState,
  Edge,
  Endpoint,
  Group,
  Node,
  PatchOp,
  Prompt,
  RoomState,
} from "../src/types";

describe("types — shape", () => {
  test("CanvasState has version=1 and three arrays", () => {
    const s: CanvasState = { version: 1, nodes: [], edges: [], groups: [] };
    expect(s.version).toBe(1);
  });

  test("Endpoint accepts node and point variants", () => {
    const e1: Endpoint = { kind: "node", id: "n1" };
    const e2: Endpoint = { kind: "point", x: 0, y: 0 };
    expect(e1.kind).toBe("node");
    expect(e2.kind).toBe("point");
  });

  test("Node kinds cover MVP set", () => {
    const kinds: Node["kind"][] = [
      "rect",
      "ellipse",
      "diamond",
      "sticky",
      "text",
      "image",
      "freeform",
    ];
    expect(kinds.length).toBe(7);
  });

  test("Group supports frame and group", () => {
    const g: Group = {
      id: "g1",
      kind: "frame",
      children: [],
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    };
    expect(g.kind).toBe("frame");
  });

  test("PatchOp union", () => {
    const ops: PatchOp[] = [
      {
        op: "add",
        target: "node",
        value: { id: "n1", kind: "rect", x: 0, y: 0 },
      },
      { op: "update", target: "node", id: "n1", set: { x: 10 } },
      { op: "delete", target: "edge", id: "e1" },
    ];
    expect(ops).toHaveLength(3);
  });

  test("Prompt fields", () => {
    const p: Prompt = {
      id: "p1",
      selection: ["n1"],
      text: "x",
      createdAt: 0,
      status: "pending",
    };
    expect(p.status).toBe("pending");
  });
});
