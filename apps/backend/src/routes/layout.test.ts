// apps/backend/src/routes/layout.test.ts
// Tests for POST /api/layout — LayoutParams body field validation (DRW-178 Task 3.3).

import { describe, expect, it } from "bun:test";
import type { SpaceRecord } from "@shemma/spaces";
import { Hono } from "hono";
import type { StoreChangeBus } from "../types";
import { Rooms } from "../rooms";
import { type SpaceBundle, installBundleResolver } from "./_space-context";
import { layoutRoutes } from "./layout";

const TEST_SPACE: SpaceRecord = {
  id: "test-layout",
  path: "/tmp/test-layout",
  storageLayout: "direct",
  createdAt: "1970-01-01T00:00:00.000Z",
  lastUsedAt: "1970-01-01T00:00:00.000Z",
};

function makeBundle(rooms: Rooms): SpaceBundle {
  return {
    space: TEST_SPACE,
    rooms,
    scheduleSave: () => {},
    flushIfDirty: async () => {},
    flushAll: async () => {},
  };
}

// Minimal StoreChangeBus mock for tests.
function makeBus(): StoreChangeBus {
  return {
    publish: () => {},
  } as StoreChangeBus;
}

function makeApp(rooms: Rooms) {
  const bus = makeBus();
  const bundle = makeBundle(rooms);
  const app = new Hono();
  app.use(
    "/api/*",
    installBundleResolver(() => bundle),
  );
  app.route("/", layoutRoutes(bus));
  return app;
}

function makeRooms(): Rooms {
  return new Rooms({ load: async () => null, save: async () => {} });
}

describe("POST /api/layout — LayoutParams body validation", () => {
  it("invalid params.nodeMinWidth = -1 → 400 with error message", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/layout?room=test-layout-1", {
      method: "POST",
      body: JSON.stringify({
        params: { nodeMinWidth: -1 },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeDefined();
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("invalid params.nodeMinHeight = -50 → 400 with error message", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/layout?room=test-layout-2", {
      method: "POST",
      body: JSON.stringify({
        params: { nodeMinHeight: -50 },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  it("valid params accepted; layout runs normally (200, ok:true)", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/layout?room=test-layout-3", {
      method: "POST",
      body: JSON.stringify({
        params: { nodeMinWidth: 200, rowMinSpacing: 60 },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      version?: number;
      count?: number;
      error?: string;
    };
    expect(body.ok).toBe(true);
  });

  it("empty params object → 200, backward compatible", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/layout?room=test-layout-4", {
      method: "POST",
      body: JSON.stringify({
        params: {},
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("missing params field → backward compatible (200, ok:true)", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/layout?room=test-layout-5", {
      method: "POST",
      body: JSON.stringify({
        mode: "layered-tb",
        scope: "all",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("invalid ?room= value → 422", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/layout?room=invalid/room!@", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });
});
