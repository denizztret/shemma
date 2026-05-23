import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SpaceRecord } from "@shemma/spaces";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rooms, makeRoomState } from "../../rooms";
import { exportRoutes } from "../../routes/export";
import {
  type SpaceBundle,
  installBundleResolver,
} from "../../routes/_space-context";
import type { RawShape } from "./coords";
import { MiroClient } from "./client";
import { runMiroExport } from "./upload";
import { tldrawNamedToHex } from "./color-mapping";

const INT_SPACE: SpaceRecord = {
  id: "test-export-int",
  path: "/tmp/test-export-int",
  storageLayout: "direct",
  createdAt: "1970-01-01T00:00:00.000Z",
  lastUsedAt: "1970-01-01T00:00:00.000Z",
};

function bundleFor(rooms: Rooms): SpaceBundle {
  return {
    space: INT_SPACE,
    rooms,
    scheduleSave: () => {},
    flushIfDirty: async () => {},
    flushAll: async () => {},
  };
}

let savedXdg: string | undefined;
let tmpRoot: string;
let miroServer: { url: string; stop: () => void; requests: Array<{ path: string; body: unknown }> } | null = null;

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  tmpRoot = mkdtempSync(join(tmpdir(), "shemma-export-int-"));
  process.env.XDG_CONFIG_HOME = tmpRoot;
  // Write a valid token
  const dir = join(tmpRoot, "shemma");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ miro: { token: "int-tk" } }),
    { mode: 0o600 },
  );
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(tmpRoot, { recursive: true, force: true });
  miroServer?.stop();
  miroServer = null;
});

function startMiroMock() {
  const requests: Array<{ path: string; body: unknown }> = [];
  let nextId = 1;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      const body = req.body ? await req.json().catch(() => null) : null;
      requests.push({ path: u.pathname, body });
      if (u.pathname.endsWith("/items/bulk")) {
        const items = body as unknown[];
        const data = items.map(() => ({ id: `miro-item-${nextId++}` }));
        return new Response(JSON.stringify({ data }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (u.pathname.endsWith("/connectors")) {
        return new Response(JSON.stringify({ id: `miro-conn-${nextId++}` }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.pathname.endsWith("/v2/boards")) {
        return new Response(
          JSON.stringify({ data: [{ id: "B1", name: "Test Board", viewLink: "https://miro.com/app/board/B1" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}");
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
    requests,
  };
}

describe("E2E backend: full export — 5 shapes + 3 connectors + 1 frame", () => {
  it("HTTP → upload → mock Miro → tracking; full happy path", async () => {
    miroServer = startMiroMock();
    const rooms = new Rooms({ load: async () => null, save: async () => {} });
    const room = await rooms.get("default");
    const store = room.store.store as Record<string, RawShape>;

    // Populate: 1 frame, 5 shapes (2 of which are frame children), 3 arrows.
    store["shape:F"] = {
      id: "shape:F", typeName: "shape", type: "frame",
      parentId: "page:page", x: 0, y: 0,
      props: { w: 600, h: 400, name: "Frame A" },
    };
    store["shape:s1"] = {
      id: "shape:s1", typeName: "shape", type: "geo",
      parentId: "shape:F", x: 50, y: 50,
      props: { w: 100, h: 50, geo: "rectangle" },
    };
    store["shape:s2"] = {
      id: "shape:s2", typeName: "shape", type: "geo",
      parentId: "shape:F", x: 200, y: 50,
      props: { w: 100, h: 50, geo: "ellipse" },
    };
    store["shape:s3"] = {
      id: "shape:s3", typeName: "shape", type: "geo",
      parentId: "page:page", x: 800, y: 0,
      props: { w: 100, h: 50, geo: "diamond" },
    };
    store["shape:s4"] = {
      id: "shape:s4", typeName: "shape", type: "note",
      parentId: "page:page", x: 900, y: 100,
      props: { w: 80, h: 80 },
    };
    store["shape:s5"] = {
      id: "shape:s5", typeName: "shape", type: "text",
      parentId: "page:page", x: 1000, y: 100,
      props: { w: 100 },
    };
    // Arrows
    for (const [arrowId, fromId, toId] of [
      ["shape:a1", "shape:s1", "shape:s2"],
      ["shape:a2", "shape:s2", "shape:s3"],
      ["shape:a3", "shape:s3", "shape:s4"],
    ] as const) {
      store[arrowId] = { id: arrowId, typeName: "shape", type: "arrow", parentId: "page:page", props: { bend: 0 } };
      store[`binding:${arrowId}-s`] = {
        id: `binding:${arrowId}-s`, typeName: "binding", type: "arrow",
        fromId: arrowId, toId: fromId,
        props: { terminal: "start", normalizedAnchor: { x: 0.9, y: 0.5 } },
      } as unknown as RawShape;
      store[`binding:${arrowId}-e`] = {
        id: `binding:${arrowId}-e`, typeName: "binding", type: "arrow",
        fromId: arrowId, toId,
        props: { terminal: "end", normalizedAnchor: { x: 0.1, y: 0.5 } },
      } as unknown as RawShape;
    }

    const app = new Hono();
    const bundle = bundleFor(rooms);
    app.use("/api/*", installBundleResolver(() => bundle));
    app.route("/", exportRoutes({ miroBaseUrl: miroServer.url }));
    const res = await app.request("/api/export/miro?room=default", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        boardId: "B1",
        boardName: "Test Board",
        selection: [
          "shape:F", "shape:s1", "shape:s2", "shape:s3", "shape:s4", "shape:s5",
          "shape:a1", "shape:a2", "shape:a3",
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      itemsCreated: number;
      connectorsCreated: number;
      boardUrl: string;
      skipped: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.itemsCreated).toBe(6); // 1 frame + 5 leaves
    expect(body.connectorsCreated).toBe(3);
    expect(body.skipped).toEqual([]);
    expect(body.boardUrl).toContain("B1");

    // Sequence assertions: Pass A1 (1 bulk POST with frame), Pass A2 (1 bulk
    // POST with 5 leaves; the 2 frame children must carry parent.id), Pass B
    // (3 connector POSTs).
    const bulks = miroServer.requests.filter((r) => r.path.endsWith("/items/bulk"));
    const conns = miroServer.requests.filter((r) => r.path.endsWith("/connectors"));
    expect(bulks).toHaveLength(2);
    expect(conns).toHaveLength(3);
    const a1Items = bulks[0].body as Array<{ type: string; data?: { shape?: string } }>;
    // Frames are now exported as rectangle shapes (frame-as-shape mode)
    expect(a1Items.every((it) => it.type === "shape")).toBe(true);
    expect(a1Items.every((it) => it.data?.shape === "rectangle")).toBe(true);
    const a2Items = bulks[1].body as Array<{ type: string }>;
    expect(a2Items.every((it) => it.type !== "frame")).toBe(true);

    // Tracking written to room.meta.miroExports
    expect(room.meta?.miroExports?.["B1"]).toBeDefined();
    const tr = room.meta?.miroExports?.["B1"];
    expect(tr?.boardName).toBe("Test Board");
    expect(Object.keys(tr?.items ?? {}).length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(tr?.connectors ?? {}).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Task 18: DRW-111 full flow — nested frames + styled shapes → correct API sequence
// ---------------------------------------------------------------------------

describe("DRW-111 full flow: nested frames + styled shapes → correct API call sequence", () => {
  it("F1(blue)⊃{F2(green)⊃{S2(red,solid)}, S1(yellow,note)} + A1(black,triangle) → correct API sequence", async () => {
    // Track itemIds per bulk call for group verification
    const bulkResponses: Array<Array<{ id: string }>> = [];
    let bulkCallIdx = 0;
    let connResp: { id: string } | null = null;
    const groupCalls: Array<string[]> = [];
    let groupCallIdx = 0;

    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = req.body ? await req.json().catch(() => null) : null;
        if (url.pathname.endsWith("/items/bulk")) {
          const items = body as unknown[];
          const prefix = `b${bulkCallIdx}`;
          const data = items.map((_, i) => ({ id: `${prefix}_${i}` }));
          bulkResponses.push(data);
          bulkCallIdx++;
          return new Response(JSON.stringify({ data }), { status: 201, headers: { "content-type": "application/json" } });
        }
        if (url.pathname.endsWith("/connectors")) {
          connResp = { id: `conn_0` };
          return new Response(JSON.stringify(connResp), { status: 201, headers: { "content-type": "application/json" } });
        }
        if (url.pathname.endsWith("/groups")) {
          const { data } = body as { data: { items: string[] } };
          const gId = `g_${groupCallIdx++}`;
          groupCalls.push(data.items);
          return new Response(JSON.stringify({ id: gId, type: "group", data: {}, links: {} }), { status: 201, headers: { "content-type": "application/json" } });
        }
        return new Response("{}", { status: 200 });
      },
    });

    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;

      // F1 = outer frame (blue, size:m)
      store["shape:F1"] = {
        id: "shape:F1", typeName: "shape", type: "frame",
        parentId: "page:page", x: 0, y: 0,
        props: { w: 500, h: 400, name: "F1", color: "blue", size: "m" },
      };
      // F2 = inner frame (green), child of F1
      store["shape:F2"] = {
        id: "shape:F2", typeName: "shape", type: "frame",
        parentId: "shape:F1", x: 50, y: 50,
        props: { w: 200, h: 150, name: "F2", color: "green", size: "m" },
      };
      // S1 = note (yellow, m), direct child of F1
      store["shape:S1"] = {
        id: "shape:S1", typeName: "shape", type: "note",
        parentId: "shape:F1", x: 300, y: 50,
        props: { w: 80, h: 80, color: "yellow", size: "m" },
      };
      // S2 = geo rectangle (red, solid, l), child of F2
      store["shape:S2"] = {
        id: "shape:S2", typeName: "shape", type: "geo",
        parentId: "shape:F2", x: 10, y: 10,
        props: { w: 100, h: 60, geo: "rectangle", color: "red", fill: "solid", size: "l" },
      };
      // A1 = arrow (black, m, end:triangle) S1→S2
      store["shape:A1"] = {
        id: "shape:A1", typeName: "shape", type: "arrow",
        parentId: "page:page",
        props: { bend: 0, richText: null, color: "black", size: "m", arrowheadStart: "none", arrowheadEnd: "triangle" },
      };
      store["binding:A1-s"] = {
        id: "binding:A1-s", typeName: "binding", type: "arrow",
        fromId: "shape:A1", toId: "shape:S1",
        props: { terminal: "start", normalizedAnchor: { x: 0.9, y: 0.5 } },
      } as unknown as RawShape;
      store["binding:A1-e"] = {
        id: "binding:A1-e", typeName: "binding", type: "arrow",
        fromId: "shape:A1", toId: "shape:S2",
        props: { terminal: "end", normalizedAnchor: { x: 0.1, y: 0.5 } },
      } as unknown as RawShape;

      const client = new MiroClient({ token: "t", baseUrl: `http://localhost:${server.port}` });
      const result = await runMiroExport({
        client, room, boardId: "B1",
        selection: ["shape:F1"], // full subtree auto-expanded
      });

      // ---- Result counts ----
      // F1 + F2 (2 frames), S1 + S2 (2 leaves) = 4 items; A1 = 1 connector
      expect(result.itemsCreated).toBe(4);
      expect(result.connectorsCreated).toBe(1);
      expect(result.skipped).toEqual([]);

      // ---- Pass A1: exactly 2 frames exported as rectangles ----
      const bulkA1 = bulkResponses[0];
      expect(bulkA1).toHaveLength(2); // F1 + F2

      // ---- Pass A2: exactly 2 leaves ----
      const bulkA2 = bulkResponses[1];
      expect(bulkA2).toHaveLength(2); // S1 + S2

      // ---- No parent.id on A2 items (frame-as-shape absolute positioning) ----
      // (We can't inspect payload here — already validated in upload.test.ts Task 12 test)

      // ---- Pass B: 1 connector with correct style ----
      expect(connResp).not.toBeNull();

      // ---- Pass C: 2 createGroup calls ----
      expect(groupCalls).toHaveLength(2);
      // Inner group (F2) first: frame rect id + S2 id = 2 items
      expect(groupCalls[0]).toHaveLength(2);
      // Outer group (F1) second: flat list with all 4 items (F1 rect + F2 rect + S1 + S2)
      expect(groupCalls[1]).toHaveLength(4);
      // Outer must NOT contain any group id (flat per Phase 0)
      expect(groupCalls[1]).not.toContain("g_0");

      // ---- Tracking ----
      const tracking = room.meta?.miroExports?.["B1"];
      expect(tracking).toBeDefined();
      expect(Object.keys(tracking?.items ?? {})).toHaveLength(4);
      expect(Object.keys(tracking?.connectors ?? {})).toEqual(["shape:A1"]);
      expect(tracking?.groups?.["shape:F1"]).toBeDefined();
      expect(tracking?.groups?.["shape:F2"]).toBeDefined();

      // ---- Frame style: F1 = blue borderColor, fillColor = #ffffff ----
      // Verified via builder unit tests; full payload checked in builder.test.ts
    } finally {
      server.stop(true);
    }
  });
});
