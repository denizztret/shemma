import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Rooms } from "../rooms";
import { exportRoutes } from "./export";

let savedXdg: string | undefined;
let tmpRoot: string;

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  tmpRoot = mkdtempSync(join(tmpdir(), "shemma-export-test-"));
  process.env.XDG_CONFIG_HOME = tmpRoot;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeApp(rooms: Rooms, miroBaseUrl: string) {
  return new Hono().route("/", exportRoutes(rooms, { miroBaseUrl }));
}

function writeToken(token: string) {
  const dir = join(tmpRoot, "shemma");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ miro: { token } }),
    { mode: 0o600 },
  );
}

function mockMiro(handler: (req: Request) => Promise<Response> | Response) {
  const server = Bun.serve({ port: 0, fetch: handler });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

describe("POST /api/export/miro — missing token", () => {
  it("returns 412 with miro-token-missing error + hint", async () => {
    const rooms = new Rooms({ load: async () => null, save: async () => {} });
    const m = mockMiro(() => new Response("{}"));
    try {
      const res = await makeApp(rooms, m.url).request("/api/export/miro?room=default", {
        method: "POST",
        body: JSON.stringify({ boardId: "B1", selection: [] }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(412);
      const body = (await res.json()) as { error: string; hint?: string };
      expect(body.error).toBe("miro-token-missing");
      expect(body.hint).toMatch(/shemma config set miro\.token/);
    } finally {
      m.stop();
    }
  });
});

describe("POST /api/export/miro — happy path", () => {
  it("invokes runMiroExport and returns result + boardUrl + flushes persistence per commit", async () => {
    writeToken("tk");
    const onDirtyCalls: string[] = [];
    const rooms = new Rooms({ load: async () => null, save: async () => {} });
    const r = await rooms.get("default");
    // populate one shape
    r.store.store["shape:a"] = {
      id: "shape:a", typeName: "shape", type: "geo", parentId: "page:page",
      x: 0, y: 0, props: { w: 100, h: 50, geo: "rectangle" },
    } as never;

    const m = mockMiro((req) => {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/items/bulk")) {
        return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 201 });
      }
      return new Response("{}", { status: 200 });
    });
    try {
      const app = new Hono().route(
        "/",
        exportRoutes(rooms, { miroBaseUrl: m.url, onDirty: (id) => onDirtyCalls.push(id) }),
      );
      const res = await app.request("/api/export/miro?room=default", {
        method: "POST",
        body: JSON.stringify({ boardId: "B1", selection: ["shape:a"] }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; itemsCreated: number; boardUrl: string };
      expect(body.ok).toBe(true);
      expect(body.itemsCreated).toBe(1);
      expect(body.boardUrl).toContain("B1");
      // onDirty called at least once per commit (A2 chunk) + final flush.
      expect(onDirtyCalls.length).toBeGreaterThanOrEqual(1);
      expect(onDirtyCalls.every((id) => id === "default")).toBe(true);
    } finally {
      m.stop();
    }
  });

  it("mid-flight A2 abort (401) → onDirty fired before crash so A1 tracking persists", async () => {
    writeToken("tk");
    const onDirtyCalls: Array<{ room: string; itemCount: number }> = [];
    const rooms = new Rooms({ load: async () => null, save: async () => {} });
    const r = await rooms.get("default");
    r.store.store["shape:F"] = {
      id: "shape:F", typeName: "shape", type: "frame", parentId: "page:page",
      x: 0, y: 0, props: { w: 400, h: 300, name: "F" },
    } as never;
    r.store.store["shape:c"] = {
      id: "shape:c", typeName: "shape", type: "geo", parentId: "shape:F",
      x: 10, y: 10, props: { w: 100, h: 50, geo: "rectangle" },
    } as never;

    let bulkCount = 0;
    const m = mockMiro(async (req) => {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/items/bulk")) {
        bulkCount += 1;
        if (bulkCount === 1) {
          const body = (await req.json()) as { data: unknown[] };
          return new Response(JSON.stringify({ data: body.data.map((_, i) => ({ id: `f-${i}` })) }), { status: 201 });
        }
        return new Response("{\"message\":\"unauthorized\"}", { status: 401 });
      }
      return new Response("{}");
    });
    try {
      const app = new Hono().route(
        "/",
        exportRoutes(rooms, {
          miroBaseUrl: m.url,
          onDirty: (id, room) => {
            onDirtyCalls.push({
              room: id,
              itemCount: Object.keys(room.meta?.miroExports?.["B1"]?.items ?? {}).length,
            });
          },
        }),
      );
      await app.request("/api/export/miro?room=default", {
        method: "POST",
        body: JSON.stringify({ boardId: "B1", selection: ["shape:F", "shape:c"] }),
        headers: { "Content-Type": "application/json" },
      });
      // Even though A2 aborted with 401, A1 commit flushed via onCommit:
      // at least one onDirty must report itemCount >= 1 (frame tracked).
      expect(onDirtyCalls.some((c) => c.itemCount >= 1)).toBe(true);
    } finally {
      m.stop();
    }
  });
});

describe("GET /api/export/miro/boards — board list + TTL cache", () => {
  it("returns list of boards from Miro API", async () => {
    writeToken("tk");
    const m = mockMiro((req) => {
      if (req.url.includes("/v2/boards")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "B1", name: "Board 1", viewLink: "https://miro.com/app/board/B1" }],
          }),
          { status: 200 },
        );
      }
      return new Response("{}");
    });
    try {
      const rooms = new Rooms({ load: async () => null, save: async () => {} });
      const res = await makeApp(rooms, m.url).request("/api/export/miro/boards");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { boards: Array<{ id: string; name: string }> };
      expect(body.boards).toHaveLength(1);
      expect(body.boards[0].name).toBe("Board 1");
    } finally {
      m.stop();
    }
  });

  it("missing token: returns 412", async () => {
    const m = mockMiro(() => new Response("{}"));
    try {
      const rooms = new Rooms({ load: async () => null, save: async () => {} });
      const res = await makeApp(rooms, m.url).request("/api/export/miro/boards");
      expect(res.status).toBe(412);
    } finally {
      m.stop();
    }
  });
});
