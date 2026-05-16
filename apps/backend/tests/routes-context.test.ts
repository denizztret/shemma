import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";
import type { RoomState } from "../src/types";

function seedShape(s: RoomState, id: string, name: string, role: string) {
  s.store.store[id] = {
    id,
    typeName: "shape",
    type: "geo",
    x: 0,
    y: 0,
    parentId: "page:page",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { w: 100, h: 60, geo: "rectangle" },
    meta: { didrawName: name, role },
  };
  s.didrawIndex.set(name, id);
}

describe("GET /api/agent/context", () => {
  test("returns domain-summary; no bounds field by default", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("c1");
    seedShape(r, "shape:e_a", "a", "service");
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=c1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; elements: Array<{ id: string; bounds?: unknown }> };
    expect(body.ok).toBe(true);
    expect(body.elements.length).toBeGreaterThan(0);
    const a = body.elements.find((e) => e.id === "a");
    expect(a).toBeDefined();
    expect(a?.bounds).toBeUndefined();
  });

  test("include=geometry includes bounds", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("c2");
    seedShape(r, "shape:e_b", "b", "service");
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=c2&include=geometry"));
    const body = (await res.json()) as { elements: Array<{ id: string; bounds?: { w: number } }> };
    const b = body.elements.find((e) => e.id === "b");
    expect(b?.bounds).toBeDefined();
    expect(b?.bounds?.w).toBe(100);
  });

  test("invalid room → 422", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=" + encodeURIComponent("bad name")));
    expect(res.status).toBe(422);
  });

  test("?since=N is echoed in response (diffSince)", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("c3");
    r.version = 5;
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=c3&since=2"));
    const body = (await res.json()) as { diffSince?: number; version: number };
    expect(body.diffSince).toBe(2);
    expect(body.version).toBe(5);
  });

  test("?since= non-numeric → 400", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=c4&since=abc"));
    expect(res.status).toBe(400);
  });
});
