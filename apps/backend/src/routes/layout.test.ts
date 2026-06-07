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

// ---------------------------------------------------------------------------
// DRW-209: layout writeback в didrawOverlays — после POST /api/layout позиции
// didraw-узлов schema-фрейма в сторе совпадают с overlay.position (один
// источник правды для reload-hydrate).
// ---------------------------------------------------------------------------

function schemaFrameStore(): Record<string, unknown> {
  const mkChild = (id: string, nodeId: string, x: number, y: number) => ({
    id,
    typeName: "shape",
    type: "geo",
    x,
    y,
    parentId: "shape:frame",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { geo: "rectangle", w: 220, h: 80 },
    meta: {
      didrawId: nodeId,
      didrawLabel: nodeId,
      didrawSchemaParent: "shape:frame",
    },
  });
  return {
    "shape:frame": {
      id: "shape:frame",
      typeName: "shape",
      type: "frame",
      x: 100,
      y: 50,
      parentId: "page:page",
      index: "a1",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: { w: 1200, h: 800, name: "F" },
      meta: {
        didrawSchemaFrame: true,
        didrawProtocol: "v2",
        schemaProtocolVersion: "1.0",
        mermaidSource: "graph LR\n  a --> b",
        didrawOverlays: {
          "node-a-aaaaaa": { position: { x: 999, y: 999 }, color: "red" },
        },
      },
    },
    "shape:n0": mkChild("shape:n0", "node-a-aaaaaa", 10, 10),
    "shape:n1": mkChild("shape:n1", "node-b-bbbbbb", 20, 20),
    "shape:a0": {
      id: "shape:a0",
      typeName: "shape",
      type: "arrow",
      x: 0,
      y: 0,
      parentId: "shape:frame",
      index: "a3",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: {
        kind: "elbow",
        color: "black",
        fill: "none",
        dash: "draw",
        size: "m",
        labelColor: "black",
        font: "draw",
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
        bend: 0,
        elbowMidPoint: 0.5,
        labelPosition: 0.5,
        scale: 1,
        richText: { type: "doc", content: [{ type: "paragraph" }] },
        arrowheadStart: "none",
        arrowheadEnd: "arrow",
      },
      meta: {},
    },
    "binding:s0": {
      id: "binding:s0",
      typeName: "binding",
      type: "arrow",
      fromId: "shape:a0",
      toId: "shape:n0",
      props: {
        terminal: "start",
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: "none",
      },
    },
    "binding:e0": {
      id: "binding:e0",
      typeName: "binding",
      type: "arrow",
      fromId: "shape:a0",
      toId: "shape:n1",
      props: {
        terminal: "end",
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: "none",
      },
    },
  };
}

describe("POST /api/layout — didrawOverlays writeback (DRW-209)", () => {
  it("after layout, overlay positions in the applied store match shape positions", async () => {
    const rooms = makeRooms();
    const r = await rooms.get("test-layout-ov");
    r.store = {
      store: schemaFrameStore(),
      schema: {
        schemaVersion: 1,
        sequenceNumber: 0,
        storeVersion: 1,
        recordVersions: {},
      },
    } as unknown as typeof r.store;

    const app = makeApp(rooms);
    const res = await app.request("/api/layout?room=test-layout-ov", {
      method: "POST",
      body: JSON.stringify({ mode: "layered-lr", scope: "all" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; count: number };
    expect(body.ok).toBe(true);
    expect(body.count).toBeGreaterThan(0);

    // biome-ignore lint/suspicious/noExplicitAny: store introspection
    const store = (r.store as any).store as Record<string, any>;
    const overlays = store["shape:frame"].meta.didrawOverlays as Record<
      string,
      { position?: { x: number; y: number }; color?: string }
    >;
    for (const sid of ["shape:n0", "shape:n1"]) {
      const rec = store[sid];
      const entry = overlays[rec.meta.didrawId];
      expect(entry?.position).toEqual({ x: rec.x, y: rec.y });
    }
    // Merge: существующий style-блок не потерян.
    expect(overlays["node-a-aaaaaa"]?.color).toBe("red");
  });
});
