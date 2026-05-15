import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

describe("GET /api/agent/context", () => {
  test("returns domain-summary; no x/y/w/h fields", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("c1");
    r.canvas.nodes.push({ id: "shape:e_a", kind: "rect", x: 0, y: 0, label: "a", meta: { name: "a", role: "service" } });
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=c1"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/"x":/);
    expect(text).not.toMatch(/"y":/);
    expect(text).not.toMatch(/"w":/);
    expect(text).not.toMatch(/"h":/);
  });

  test("uses last-known viewport if not given in query", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    rooms.setViewport("c1", { x: 0, y: 0, w: 100, h: 100, zoom: 1 });
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=c1"));
    const body = (await res.json()) as { viewport: { w: number } | null };
    expect(body.viewport?.w).toBe(100);
  });

  test("viewport query param overrides server-stored", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    rooms.setViewport("c1", { x: 0, y: 0, w: 100, h: 100 });
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=c1&viewport=10,20,30,40"));
    const body = (await res.json()) as { viewport: { x: number; y: number; w: number; h: number } | null };
    expect(body.viewport).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  test("invalid room → 422", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=" + encodeURIComponent("bad name")));
    expect(res.status).toBe(422);
  });

  test("?since=N filters recentOps to versions > N", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("c1");
    r.opLog.push({ ops: [], source: "ai", version: 1, at: 100 });
    r.opLog.push({ ops: [], source: "ai", version: 2, at: 200 });
    r.opLog.push({ ops: [], source: "ai", version: 3, at: 300 });
    r.version = 3;
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=c1&since=1"));
    const body = (await res.json()) as { recentOps: Array<{ version: number }> };
    expect(body.recentOps.map((o) => o.version)).toEqual([2, 3]);
  });
});
