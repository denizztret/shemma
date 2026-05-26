// apps/backend/src/routes/smart-insert.test.ts
// Tests for POST /api/smart-insert — light-insert endpoint (DRW-178 Task 4.2).

import { describe, expect, it } from "bun:test";
import type { SpaceRecord } from "@shemma/spaces";
import { Hono } from "hono";
import type { StoreChangeBus } from "../types";
import { Rooms } from "../rooms";
import { type SpaceBundle, installBundleResolver } from "./_space-context";
import { smartInsertRoutes } from "./smart-insert";
import type { TLRecord } from "../store-types";

const TEST_SPACE: SpaceRecord = {
  id: "test-smart-insert",
  path: "/tmp/test-smart-insert",
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

function makeBus(): StoreChangeBus {
  return {
    publish: () => {},
  } as StoreChangeBus;
}

function makeApp(rooms: Rooms) {
  const bus = makeBus();
  const bundle = makeBundle(rooms);
  const app = new Hono();
  app.use("/api/*", installBundleResolver(() => bundle));
  app.route("/", smartInsertRoutes(bus));
  return app;
}

function makeRooms(): Rooms {
  return new Rooms({ load: async () => null, save: async () => {} });
}

/** Build a Rooms instance pre-seeded with one room containing a container shape. */
function makeRoomsWithContainer(opts: {
  roomId: string;
  containerId: string;
  containerW: number;
  containerH: number;
  childShapes?: Array<{ id: string; parentId: string; x: number; y: number; w: number; h: number; type?: string }>;
  containerMeta?: Record<string, unknown>;
  containerProps?: Record<string, unknown>;
}): Rooms {
  const shapes: Record<string, TLRecord> = {};

  // Container shape
  shapes[opts.containerId] = {
    id: opts.containerId,
    typeName: "shape",
    type: "geo",
    x: 100,
    y: 100,
    parentId: "page:page",
    props: { w: opts.containerW, h: opts.containerH, ...opts.containerProps },
    meta: opts.containerMeta ?? {},
  };

  // Child shapes
  for (const ch of opts.childShapes ?? []) {
    shapes[ch.id] = {
      id: ch.id,
      typeName: "shape",
      type: ch.type ?? "geo",
      x: ch.x,
      y: ch.y,
      parentId: ch.parentId,
      props: { w: ch.w, h: ch.h },
      meta: {},
    };
  }

  const rooms = new Rooms({ load: async () => null, save: async () => {} });
  // Pre-seed via internal access — same approach as other route tests that
  // synthesize rooms without file I/O.
  const state = {
    store: {
      schema: { schemaVersion: 2, storeVersion: 4, recordVersions: {} },
      store: shapes,
    },
    opLog: [],
    prompts: [],
    version: 1,
    dirty: false,
    lastTouched: Date.now(),
    didrawIndex: new Map<string, string>(),
  };
  // Inject directly into the internal map.
  (rooms as unknown as { map: Map<string, unknown> }).map.set(opts.roomId, state);
  return rooms;
}

// ─── Error paths ──────────────────────────────────────────────────────────────

describe("POST /api/smart-insert — error paths", () => {
  it("returns 422 for invalid room id", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/smart-insert?room=invalid/room!@", {
      method: "POST",
      body: JSON.stringify({
        containerId: "shape:abc",
        size: { w: 100, h: 60 },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeDefined();
  });

  it("returns 400 when containerId is missing", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/smart-insert?room=room1", {
      method: "POST",
      body: JSON.stringify({ size: { w: 100, h: 60 } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/containerId/);
  });

  it("returns 400 when containerId is empty string", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/smart-insert?room=room1", {
      method: "POST",
      body: JSON.stringify({ containerId: "", size: { w: 100, h: 60 } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/containerId/);
  });

  it("returns 400 when size is missing", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/smart-insert?room=room1", {
      method: "POST",
      body: JSON.stringify({ containerId: "shape:abc" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/size/);
  });

  it("returns 400 when size.w is not a number", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/smart-insert?room=room1", {
      method: "POST",
      body: JSON.stringify({ containerId: "shape:abc", size: { w: "big", h: 60 } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("returns 400 when size dimensions are non-positive", async () => {
    const app = makeApp(makeRooms());
    const res = await app.request("/api/smart-insert?room=room1", {
      method: "POST",
      body: JSON.stringify({ containerId: "shape:abc", size: { w: 0, h: 60 } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("returns 404 when containerId does not exist in store", async () => {
    const rooms = makeRoomsWithContainer({
      roomId: "room-404",
      containerId: "shape:container1",
      containerW: 400,
      containerH: 300,
    });
    const app = makeApp(rooms);
    const res = await app.request("/api/smart-insert?room=room-404", {
      method: "POST",
      body: JSON.stringify({
        containerId: "shape:nonexistent",
        size: { w: 100, h: 60 },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not found/i);
  });
});

// ─── Happy path: slot fits ────────────────────────────────────────────────────

describe("POST /api/smart-insert — slot fits (no expansion)", () => {
  it("returns 200 with position and null expansion for empty container", async () => {
    const rooms = makeRoomsWithContainer({
      roomId: "room-fit",
      containerId: "shape:c1",
      containerW: 400,
      containerH: 300,
    });
    const app = makeApp(rooms);
    const res = await app.request("/api/smart-insert?room=room-fit", {
      method: "POST",
      body: JSON.stringify({
        containerId: "shape:c1",
        size: { w: 100, h: 60 },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      position: { x: number; y: number };
      expansion: null;
    };
    expect(body.ok).toBe(true);
    expect(body.expansion).toBeNull();
    expect(typeof body.position.x).toBe("number");
    expect(typeof body.position.y).toBe("number");
  });

  it("position is parent-local (not page coords) — starts near 0,0 not 100,100", async () => {
    // Container is placed at page (100, 100) but the returned position must be
    // parent-local (relative to container origin), so x and y should be ≥ 0.
    const rooms = makeRoomsWithContainer({
      roomId: "room-local",
      containerId: "shape:c2",
      containerW: 400,
      containerH: 300,
    });
    const app = makeApp(rooms);
    const res = await app.request("/api/smart-insert?room=room-local", {
      method: "POST",
      body: JSON.stringify({
        containerId: "shape:c2",
        size: { w: 80, h: 50 },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      position: { x: number; y: number };
    };
    // Parent-local: must be within [0, containerW) and [0, containerH)
    expect(body.position.x).toBeGreaterThanOrEqual(0);
    expect(body.position.x).toBeLessThan(400);
    expect(body.position.y).toBeGreaterThanOrEqual(0);
    expect(body.position.y).toBeLessThan(300);
  });

  it("respects custom padding parameter", async () => {
    const rooms = makeRoomsWithContainer({
      roomId: "room-padding",
      containerId: "shape:c3",
      containerW: 400,
      containerH: 300,
    });
    const app = makeApp(rooms);
    const res = await app.request("/api/smart-insert?room=room-padding", {
      method: "POST",
      body: JSON.stringify({
        containerId: "shape:c3",
        size: { w: 80, h: 50 },
        padding: 40,
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      position: { x: number; y: number };
    };
    // With padding=40 position must be >= 40
    expect(body.position.x).toBeGreaterThanOrEqual(40);
    expect(body.position.y).toBeGreaterThanOrEqual(40);
  });

  it("arrows are excluded from occupant list — don't block slot search", async () => {
    // Fill container with arrow shapes; they should not count as obstacles.
    const rooms = makeRoomsWithContainer({
      roomId: "room-arrows",
      containerId: "shape:c4",
      containerW: 300,
      containerH: 200,
      childShapes: [
        { id: "shape:a1", parentId: "shape:c4", x: 10, y: 10, w: 280, h: 180, type: "arrow" },
        { id: "shape:a2", parentId: "shape:c4", x: 5, y: 5, w: 280, h: 180, type: "routed-arrow" },
      ],
    });
    const app = makeApp(rooms);
    const res = await app.request("/api/smart-insert?room=room-arrows", {
      method: "POST",
      body: JSON.stringify({
        containerId: "shape:c4",
        size: { w: 80, h: 50 },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; expansion: null };
    // Arrow occupants excluded → slot found, no expansion needed.
    expect(body.ok).toBe(true);
    expect(body.expansion).toBeNull();
  });
});

// ─── Expansion path ───────────────────────────────────────────────────────────

describe("POST /api/smart-insert — expansion when no slot fits", () => {
  it("returns expansion object when container is full", async () => {
    // Fill container entirely with one large child so no slot fits.
    const rooms = makeRoomsWithContainer({
      roomId: "room-full",
      containerId: "shape:c5",
      containerW: 200,
      containerH: 150,
      childShapes: [
        { id: "shape:ch1", parentId: "shape:c5", x: 0, y: 0, w: 200, h: 150 },
      ],
    });
    const app = makeApp(rooms);
    const res = await app.request("/api/smart-insert?room=room-full", {
      method: "POST",
      body: JSON.stringify({
        containerId: "shape:c5",
        size: { w: 100, h: 80 },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      position: { x: number; y: number };
      expansion: { dw: number; dh: number } | null;
    };
    expect(body.ok).toBe(true);
    expect(body.expansion).not.toBeNull();
    expect(typeof body.expansion!.dw).toBe("number");
    expect(typeof body.expansion!.dh).toBe("number");
    // At least one dimension must grow.
    expect(body.expansion!.dw + body.expansion!.dh).toBeGreaterThan(0);
  });

  it("TB direction expands height (dh > 0, dw = 0)", async () => {
    const rooms = makeRoomsWithContainer({
      roomId: "room-tb",
      containerId: "shape:c6",
      containerW: 200,
      containerH: 150,
      childShapes: [
        { id: "shape:ch2", parentId: "shape:c6", x: 0, y: 0, w: 200, h: 150 },
      ],
    });
    const app = makeApp(rooms);
    const res = await app.request("/api/smart-insert?room=room-tb", {
      method: "POST",
      body: JSON.stringify({
        containerId: "shape:c6",
        size: { w: 80, h: 60 },
        biasDirection: "TB",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      expansion: { dw: number; dh: number };
    };
    expect(body.expansion.dh).toBeGreaterThan(0);
    expect(body.expansion.dw).toBe(0);
  });

  it("LR direction expands width (dw > 0, dh = 0)", async () => {
    const rooms = makeRoomsWithContainer({
      roomId: "room-lr",
      containerId: "shape:c7",
      containerW: 200,
      containerH: 150,
      childShapes: [
        { id: "shape:ch3", parentId: "shape:c7", x: 0, y: 0, w: 200, h: 150 },
      ],
    });
    const app = makeApp(rooms);
    const res = await app.request("/api/smart-insert?room=room-lr", {
      method: "POST",
      body: JSON.stringify({
        containerId: "shape:c7",
        size: { w: 80, h: 60 },
        biasDirection: "LR",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      expansion: { dw: number; dh: number };
    };
    expect(body.expansion.dw).toBeGreaterThan(0);
    expect(body.expansion.dh).toBe(0);
  });

  it("biasDirection falls back to TB when not specified", async () => {
    const rooms = makeRoomsWithContainer({
      roomId: "room-default-dir",
      containerId: "shape:c8",
      containerW: 200,
      containerH: 150,
      childShapes: [
        { id: "shape:ch4", parentId: "shape:c8", x: 0, y: 0, w: 200, h: 150 },
      ],
    });
    const app = makeApp(rooms);
    const res = await app.request("/api/smart-insert?room=room-default-dir", {
      method: "POST",
      body: JSON.stringify({
        containerId: "shape:c8",
        size: { w: 80, h: 60 },
        // No biasDirection
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      expansion: { dw: number; dh: number };
    };
    // Default is TB → height grows
    expect(body.expansion.dh).toBeGreaterThan(0);
    expect(body.expansion.dw).toBe(0);
  });
});
