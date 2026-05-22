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

  it("v2 room (meta.didrawProtocol='v2', пустой store) → 200 с schemaVersion:v2, frames:[], free:[]", async () => {
    const rooms = makeRooms();
    const room = await rooms.get("v2empty");
    room.meta = { didrawProtocol: "v2" };

    const app = makeApp(rooms);
    const res = await app.request("/api/canvas/view?room=v2empty");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schemaVersion: string;
      frames: unknown[];
      free: unknown[];
    };
    expect(body.schemaVersion).toBe("v2");
    expect(Array.isArray(body.frames)).toBe(true);
    expect(body.frames).toHaveLength(0);
    expect(Array.isArray(body.free)).toBe(true);
    expect(body.free).toHaveLength(0);
  });

  it("v2 room с одним schema-frame → 200, frame в frames[], overlays exposed", async () => {
    const rooms = makeRooms();
    const room = await rooms.get("v2withframe");
    room.meta = { didrawProtocol: "v2" };

    // Добавляем schema-frame shape в store
    const frameShape = {
      id: "shape:frame1",
      typeName: "shape",
      type: "frame",
      parentId: "page:page",
      x: 10,
      y: 20,
      props: { name: "Auth flow", w: 640, h: 420 },
      meta: {
        didrawSchemaFrame: true,
        didrawProtocol: "v2",
        schemaProtocolVersion: "1.0",
        mermaidSource: "graph LR\n  user-x1y2 --> api-x9k2lm",
        didrawOverlays: { "api-x9k2lm": { position: { x: 380, y: 200 }, color: "red" } },
      },
    };
    room.store.store["shape:frame1"] = frameShape;

    const app = makeApp(rooms);
    const res = await app.request("/api/canvas/view?room=v2withframe");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      schemaVersion: string;
      frames: Array<{
        id: string;
        label: string;
        bbox: { x: number; y: number; w: number; h: number };
        raw: string;
        overlays: Record<string, unknown>;
      }>;
      free: unknown[];
    };

    expect(body.schemaVersion).toBe("v2");
    expect(body.frames).toHaveLength(1);
    expect(body.free).toHaveLength(0);

    const frame = body.frames[0];
    expect(frame.id).toBe("shape:frame1");
    expect(frame.label).toBe("Auth flow");
    expect(frame.raw).toBe("graph LR\n  user-x1y2 --> api-x9k2lm");
    expect(frame.overlays["api-x9k2lm"]).toEqual({ position: { x: 380, y: 200 }, color: "red" });
  });
});
