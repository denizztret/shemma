import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rooms } from "../../rooms";
import { exportRoutes } from "../../routes/export";
import type { RawShape } from "./coords";

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

    const app = new Hono().route("/", exportRoutes(rooms, { miroBaseUrl: miroServer.url }));
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
    const a1Items = bulks[0].body as Array<{ type: string }>;
    expect(a1Items.every((it) => it.type === "frame")).toBe(true);
    const a2Items = bulks[1].body as Array<{ type: string; parent?: { id: string } }>;
    expect(a2Items.some((it) => it.parent?.id !== undefined)).toBe(true);

    // Tracking written to room.meta.miroExports
    expect(room.meta?.miroExports?.["B1"]).toBeDefined();
    const tr = room.meta?.miroExports?.["B1"];
    expect(tr?.boardName).toBe("Test Board");
    expect(Object.keys(tr?.items ?? {}).length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(tr?.connectors ?? {}).length).toBe(3);
  });
});
