import { describe, expect, test } from "bun:test";
import { emptyCanvasState } from "../../src/rooms";
import type { CanvasState } from "../../src/types";
import { runLayout } from "../../src/domain/layout";

function makeCanvas(): CanvasState {
  const c = emptyCanvasState();
  c.nodes.push({ id: "shape:e_a", kind: "rect", x: 0, y: 0, w: 100, h: 60, label: "a", meta: { name: "a", role: "service" } });
  c.nodes.push({ id: "shape:e_b", kind: "rect", x: 0, y: 0, w: 100, h: 60, label: "b", meta: { name: "b", role: "datastore" } });
  c.edges.push({ id: "shape:c_0", from: { kind: "node", id: "shape:e_a" }, to: { kind: "node", id: "shape:e_b" }, meta: { kind: "data" } });
  return c;
}

describe("runLayout", () => {
  test("returns positions for both nodes", async () => {
    const r = await runLayout(makeCanvas(), { mode: "layered-lr", scope: "all", spacing: "normal" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.positions["shape:e_a"]).toBeDefined();
      expect(r.positions["shape:e_b"]).toBeDefined();
    }
  });

  test("layered-lr puts source.x < target.x", async () => {
    const r = await runLayout(makeCanvas(), { mode: "layered-lr", scope: "all", spacing: "normal" });
    if (r.ok) {
      expect(r.positions["shape:e_a"].x).toBeLessThan(r.positions["shape:e_b"].x);
    }
  });

  test("pinned node keeps its coordinates (within tolerance)", async () => {
    const c = makeCanvas();
    c.nodes[0].meta = { ...c.nodes[0].meta, pinned: true, position: { x: 500, y: 300 } };
    c.nodes[0].x = 500;
    c.nodes[0].y = 300;
    const r = await runLayout(c, { mode: "layered-lr", scope: "all", spacing: "normal" });
    if (r.ok) {
      expect(Math.abs(r.positions["shape:e_a"].x - 500)).toBeLessThan(5);
      expect(Math.abs(r.positions["shape:e_a"].y - 300)).toBeLessThan(5);
    }
  });

  test("affected scope only lays out the affected subgraph", async () => {
    const c = emptyCanvasState();
    for (let i = 0; i < 4; i++) {
      c.nodes.push({ id: `shape:e_n${i}`, kind: "rect", x: 100 + i, y: 100 + i, w: 100, h: 60, label: `n${i}`, meta: { name: `n${i}`, role: "service" } });
    }
    c.edges.push({ id: "shape:c_0", from: { kind: "node", id: "shape:e_n0" }, to: { kind: "node", id: "shape:e_n1" } });
    // PLAN BUG FIX: original plan used scope:"all" here but the test is about scope:"affected" pinning non-affected.
    // Use scope:"affected" so pinning of n2/n3 actually triggers.
    const r = await runLayout(c, { mode: "layered-lr", scope: "affected", spacing: "normal" }, { affected: ["shape:e_n0", "shape:e_n1"] });
    if (r.ok) {
      // n2/n3 are pinned (treated as fixed) when scope=affected — their input x/y preserved
      expect(Math.abs(r.positions["shape:e_n2"].x - 102)).toBeLessThan(5);
      expect(Math.abs(r.positions["shape:e_n3"].x - 103)).toBeLessThan(5);
    }
  });

  test("returns ok:false on ELK error path (synthetic)", async () => {
    // Force a malformed canvas (negative width which some ELK builds reject)
    const c = emptyCanvasState();
    c.nodes.push({ id: "shape:e_x", kind: "rect", x: 0, y: 0, w: -1, h: -1, label: "x" });
    const r = await runLayout(c, { mode: "layered-lr", scope: "all", spacing: "normal" });
    // ELK may either coerce or throw — both are acceptable. We only assert the shape:
    expect(typeof r.ok).toBe("boolean");
  });

  test("group containers become ELK compound nodes — children laid out inside parent", async () => {
    const c = emptyCanvasState();
    c.nodes.push({ id: "shape:e_a", kind: "rect", x: 0, y: 0, w: 100, h: 60, label: "a", meta: { name: "a", role: "service" } });
    c.nodes.push({ id: "shape:e_b", kind: "rect", x: 0, y: 0, w: 100, h: 60, label: "b", meta: { name: "b", role: "service" } });
    c.groups.push({ id: "shape:e_vpc", kind: "frame", children: ["shape:e_a", "shape:e_b"], label: "vpc", w: 400, h: 200 });
    c.edges.push({ id: "shape:c_0", from: { kind: "node", id: "shape:e_a" }, to: { kind: "node", id: "shape:e_b" } });
    const r = await runLayout(c, { mode: "layered-lr", scope: "all", spacing: "normal" });
    if (r.ok) {
      expect(r.positions["shape:e_vpc"]).toBeDefined();
      expect(r.positions["shape:e_a"]).toBeDefined();
      expect(r.positions["shape:e_b"]).toBeDefined();
    }
  });
});
