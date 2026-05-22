// apps/backend/src/routes/canvas-view.test.ts
// Tests for GET /api/canvas/view — polymorphic v1/v2 handler (DRW-134 Task 1.5).

import { describe, expect, it } from "bun:test";
import type { SpaceRecord } from "@shemma/spaces";
import { Hono } from "hono";
import { Rooms } from "../rooms";
import type { RoomState } from "../types";
import { type SpaceBundle, installBundleResolver } from "./_space-context";
import { canvasViewRoutes } from "./canvas-view";

const TEST_SPACE: SpaceRecord = {
  id: "test-canvas-view",
  path: "/tmp/test-canvas-view",
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

function makeApp(rooms: Rooms) {
  const bundle = makeBundle(rooms);
  const app = new Hono();
  app.use(
    "/api/*",
    installBundleResolver(() => bundle),
  );
  app.route("/", canvasViewRoutes());
  return app;
}

function makeRooms(): Rooms {
  return new Rooms({ load: async () => null, save: async () => {} });
}

describe("GET /api/canvas/view", () => {
  it("invalid ?room= value → 422", async () => {
    // resolveRoomId(undefined) falls back to DEFAULT_ROOM; pass an invalid id to trigger 422.
    const app = makeApp(makeRooms());
    const res = await app.request("/api/canvas/view?room=invalid/room!@");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  it("v1 room (no didrawProtocol marker) → 200 with schemaVersion:v1 and legacy.ok:true", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/canvas/view?room=testroom");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schemaVersion: string;
      legacy: { ok: boolean; version: number; elements: unknown[] };
      hint: string;
    };
    expect(body.schemaVersion).toBe("v1");
    expect(body.legacy).toBeDefined();
    expect(body.legacy.ok).toBe(true);
    expect(Array.isArray(body.legacy.elements)).toBe(true);
    expect(typeof body.hint).toBe("string");
    expect(body.hint).toContain("legacy protocol");
  });

  it("v1 room — legacy body matches shape of /api/agent/context response", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/canvas/view?room=testroom2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schemaVersion: string;
      legacy: Record<string, unknown>;
    };
    // context endpoint returns { ok: true, version, elements }
    expect(body.legacy).toHaveProperty("ok", true);
    expect(body.legacy).toHaveProperty("version");
    expect(body.legacy).toHaveProperty("elements");
  });

  it("v2 room (meta.didrawProtocol='v2') → 501 with Task 2.1 message", async () => {
    // Создаём room с v2 маркером через прямой доступ к internal map после get()
    const rooms = makeRooms();
    // Pre-create the room with v2 marker by getting it first, then patching meta
    const room = await rooms.get("v2room");
    room.meta = { didrawProtocol: "v2" };

    const app = makeApp(rooms);
    const res = await app.request("/api/canvas/view?room=v2room");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Task 2.1");
  });
});
