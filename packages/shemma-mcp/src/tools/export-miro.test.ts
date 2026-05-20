import { describe, expect, it } from "bun:test";
import { CanvasClient } from "@shemma/client";
import { RoomResolver } from "../room-resolver";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExportMiroTool } from "./export-miro";

function startFakeDaemon(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

function makeResolver(room: string): RoomResolver {
  return new RoomResolver({
    sessionEnv: undefined,
    getActiveRooms: async () => ({ rooms: [{ room, clientCount: 1, lastFocusedAt: Date.now() }] }),
    getInProgressTasks: async () => [],
    configRoom: room,
  });
}

describe("registerExportMiroTool — success path", () => {
  it("invokes POST /api/export/miro with boardId + selection", async () => {
    let capturedBody: unknown = null;
    const daemon = startFakeDaemon(async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/export/miro" && req.method === "POST") {
        capturedBody = await req.json();
        return new Response(
          JSON.stringify({
            ok: true,
            boardId: "B1",
            boardUrl: "https://miro.com/app/board/B1/",
            itemsCreated: 5,
            connectorsCreated: 3,
            skipped: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.pathname === "/api/active-rooms") {
        return new Response(JSON.stringify({ rooms: [] }), { status: 200 });
      }
      return new Response("{}");
    });
    try {
      const client = new CanvasClient({ baseUrl: daemon.url, room: "default" });
      const server = new McpServer({ name: "test", version: "0" });
      const handles = registerExportMiroTool(server, {
        client,
        resolver: makeResolver("default"),
        defaultRoom: "default",
      });
      const res = await handles.exportMiro.call({
        boardId: "B1",
        selection: ["shape:a"],
      });
      expect(res.isError).toBeUndefined();
      const text = JSON.parse(
        (res.content[0] as { text: string }).text,
      ) as { ok: boolean; itemsCreated?: number };
      expect(text.ok).toBe(true);
      expect(text.itemsCreated).toBe(5);
      expect((capturedBody as { boardId: string }).boardId).toBe("B1");
    } finally {
      daemon.stop();
    }
  });
});

describe("registerExportMiroTool — error mapping", () => {
  it("412 miro-token-missing → ok:false with hint", async () => {
    const daemon = startFakeDaemon(async () => {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "miro-token-missing",
          hint: "Run: shemma config set miro.token <token>",
        }),
        { status: 412, headers: { "content-type": "application/json" } },
      );
    });
    try {
      const client = new CanvasClient({ baseUrl: daemon.url, room: "default" });
      const server = new McpServer({ name: "test", version: "0" });
      const handles = registerExportMiroTool(server, {
        client,
        resolver: makeResolver("default"),
        defaultRoom: "default",
      });
      const res = await handles.exportMiro.call({ boardId: "B1", selection: ["shape:a"] });
      const text = JSON.parse((res.content[0] as { text: string }).text) as {
        ok: boolean;
        error?: string;
      };
      expect(text.ok).toBe(false);
      expect(text.error).toBe("miro-token-missing");
    } finally {
      daemon.stop();
    }
  });
});

describe("registerExportMiroTool — dryRun", () => {
  it("passes dryRun=true to backend", async () => {
    let captured: { dryRun?: boolean } = {};
    const daemon = startFakeDaemon(async (req) => {
      captured = (await req.json()) as { dryRun?: boolean };
      return new Response(JSON.stringify({ ok: true, dryRun: true, itemCount: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const client = new CanvasClient({ baseUrl: daemon.url, room: "default" });
      const server = new McpServer({ name: "test", version: "0" });
      const handles = registerExportMiroTool(server, {
        client,
        resolver: makeResolver("default"),
        defaultRoom: "default",
      });
      await handles.exportMiro.call({ boardId: "B1", selection: ["shape:a"], dryRun: true });
      expect(captured.dryRun).toBe(true);
    } finally {
      daemon.stop();
    }
  });
});
