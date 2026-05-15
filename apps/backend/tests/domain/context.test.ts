import { describe, expect, test } from "bun:test";
import { emptyCanvasState, makeRoomState } from "../../src/rooms";
import { buildContext } from "../../src/domain/context";

function seedState() {
  const s = makeRoomState();
  s.canvas.nodes.push({ id: "shape:e_auth", kind: "rect", x: 100, y: 100, w: 120, h: 60, label: "auth", meta: { name: "auth", role: "service" } });
  s.canvas.nodes.push({ id: "shape:e_db", kind: "rect", x: 300, y: 100, w: 120, h: 60, label: "users-db", meta: { name: "users-db", role: "datastore" } });
  s.canvas.edges.push({ id: "shape:c_0", from: { kind: "node", id: "shape:e_auth" }, to: { kind: "node", id: "shape:e_db" }, label: "reads", meta: { kind: "data" } });
  s.canvas.groups.push({ id: "shape:e_vpc", kind: "frame", children: ["shape:e_auth", "shape:e_db"], label: "vpc-prod" });
  (s.canvas.groups[0] as { meta?: Record<string, unknown> }).meta = { name: "vpc-prod", role: "network" };
  s.version = 7;
  return s;
}

describe("buildContext", () => {
  test("summary.byRole counts roles correctly", () => {
    const ctx = buildContext(seedState(), { viewport: null });
    expect(ctx.summary.byRole.service).toBe(1);
    expect(ctx.summary.byRole.datastore).toBe(1);
    expect(ctx.summary.byRole.network).toBe(1);
  });

  test("no geometry leaks (no x/y/w/h in ElementCompact)", () => {
    const ctx = buildContext(seedState(), { viewport: null });
    const json = JSON.stringify(ctx);
    expect(json).not.toMatch(/"x":/);
    expect(json).not.toMatch(/"w":/);
    expect(json).not.toMatch(/"h":/);
    expect(json).not.toMatch(/"fill":/);
  });

  test("inView excludes nodes outside viewport when set", () => {
    const ctx = buildContext(seedState(), {
      viewport: { x: 0, y: 0, w: 200, h: 200 },
    });
    const ids = ctx.inView.map((e) => e.id);
    expect(ids).toContain("auth");
    expect(ids).not.toContain("users-db");
  });

  test("derived parent from Group.children", () => {
    const ctx = buildContext(seedState(), { viewport: null });
    const auth = ctx.inView.find((e) => e.id === "auth");
    expect(auth?.parent).toBe("vpc-prod");
  });

  test("pinned flag — when meta.pinned true, ElementCompact carries pinned:true without coordinates", () => {
    const s = seedState();
    s.canvas.nodes[0].meta = { ...s.canvas.nodes[0].meta, pinned: true, position: { x: 100, y: 100 } };
    const ctx = buildContext(s, { viewport: null });
    const auth = ctx.inView.find((e) => e.id === "auth");
    expect(auth?.pinned).toBe(true);
    expect(JSON.stringify(auth)).not.toMatch(/"x":/);
  });

  test("token budget — 100 elements stays under 8KB", () => {
    const s = makeRoomState();
    for (let i = 0; i < 100; i++) {
      const role = i < 60 ? "service" : i < 80 ? "datastore" : "queue";
      s.canvas.nodes.push({ id: `shape:e_n${i}`, kind: "rect", x: i * 50, y: 0, w: 100, h: 50, label: `n${i}`, meta: { name: `n${i}`, role } });
    }
    s.version = 100;
    const ctx = buildContext(s, { viewport: { x: 0, y: 0, w: 800, h: 600 } });
    expect(JSON.stringify(ctx).length).toBeLessThan(8000);
  });
});
