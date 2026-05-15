import { describe, expect, test } from "bun:test";
import { applyPatch } from "../src/patch";
import type { CanvasState } from "../src/types";

const empty = (): CanvasState => ({
  version: 1,
  nodes: [],
  edges: [],
  groups: [],
});

describe("applyPatch", () => {
  test("add node", () => {
    const r = applyPatch(empty(), [
      {
        op: "add",
        target: "node",
        value: { id: "n1", kind: "rect", x: 0, y: 0 },
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.nodes).toHaveLength(1);
  });

  test("update with style deep-merges", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [
        {
          id: "n1",
          kind: "rect",
          x: 0,
          y: 0,
          style: { stroke: "#000", fontSize: 14 },
        },
      ],
      edges: [],
      groups: [],
    };
    const r = applyPatch(s, [
      {
        op: "update",
        target: "node",
        id: "n1",
        set: { style: { fill: "#888" } },
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.state.nodes[0].style).toEqual({
        stroke: "#000",
        fontSize: 14,
        fill: "#888",
      });
  });

  test("update style.fill=undefined deletes key", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [
        {
          id: "n1",
          kind: "rect",
          x: 0,
          y: 0,
          style: { fill: "#888", stroke: "#000" },
        },
      ],
      edges: [],
      groups: [],
    };
    const r = applyPatch(s, [
      {
        op: "update",
        target: "node",
        id: "n1",
        set: { style: { fill: undefined } },
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.nodes[0].style).toEqual({ stroke: "#000" });
  });

  test("edge.from references unknown node — fails atomically", () => {
    const r = applyPatch(empty(), [
      {
        op: "add",
        target: "edge",
        value: {
          id: "e1",
          from: { kind: "node", id: "missing" },
          to: { kind: "node", id: "n1" },
        },
      },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("missing");
  });

  test("edge with point endpoint — allowed", () => {
    const r = applyPatch(empty(), [
      {
        op: "add",
        target: "edge",
        value: {
          id: "e1",
          from: { kind: "point", x: 0, y: 0 },
          to: { kind: "point", x: 100, y: 0 },
        },
      },
    ]);
    expect(r.ok).toBe(true);
  });

  test("rollback on later op failure", () => {
    const r = applyPatch(empty(), [
      {
        op: "add",
        target: "node",
        value: { id: "n1", kind: "rect", x: 0, y: 0 },
      },
      {
        op: "add",
        target: "edge",
        value: {
          id: "e1",
          from: { kind: "node", id: "missing" },
          to: { kind: "node", id: "n1" },
        },
      },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.state.nodes).toHaveLength(0);
  });

  test("delete removes", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [{ id: "n1", kind: "rect", x: 0, y: 0 }],
      edges: [],
      groups: [],
    };
    const r = applyPatch(s, [{ op: "delete", target: "node", id: "n1" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.nodes).toHaveLength(0);
  });

  test("cascade: delete node removes referencing edges", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [
        { id: "n1", kind: "rect", x: 0, y: 0 },
        { id: "n2", kind: "rect", x: 100, y: 0 },
      ],
      edges: [
        {
          id: "e1",
          from: { kind: "node", id: "n1" },
          to: { kind: "node", id: "n2" },
        },
        {
          id: "e2",
          from: { kind: "node", id: "n2" },
          to: { kind: "point", x: 0, y: 0 },
        },
      ],
      groups: [],
    };
    const r = applyPatch(s, [{ op: "delete", target: "node", id: "n1" }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.nodes.map((n) => n.id)).toEqual(["n2"]);
      expect(r.state.edges.map((e) => e.id)).toEqual(["e2"]); // e1 удалён каскадом
    }
  });

  test("cascade: delete node removes id from group.children", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [
        { id: "n1", kind: "rect", x: 0, y: 0 },
        { id: "n2", kind: "rect", x: 0, y: 0 },
      ],
      edges: [],
      groups: [{ id: "g1", kind: "group", children: ["n1", "n2"] }],
    };
    const r = applyPatch(s, [{ op: "delete", target: "node", id: "n1" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.groups[0].children).toEqual(["n2"]);
  });

  test("cascade: delete group keeps children", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [{ id: "n1", kind: "rect", x: 0, y: 0 }],
      edges: [],
      groups: [{ id: "g1", kind: "group", children: ["n1"] }],
    };
    const r = applyPatch(s, [{ op: "delete", target: "group", id: "g1" }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.groups).toHaveLength(0);
      expect(r.state.nodes).toHaveLength(1); // node остался плавающим
    }
  });
});
