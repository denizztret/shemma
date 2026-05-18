import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { mapFetchError, toolResult } from "../errors";

export type ToolResult = ReturnType<typeof toolResult>;

export type ReadOnlyDeps = {
  client: CanvasClient;
  defaultRoom: string;
};

export type ReadOnlyHandles = {
  health: { call: (input: { ensure?: boolean; extended?: boolean }) => Promise<ToolResult> };
  version: { call: (input: Record<string, never>) => Promise<ToolResult> };
  rooms_list: { call: (input: Record<string, never>) => Promise<ToolResult> };
  active_rooms: { call: (input: Record<string, never>) => Promise<ToolResult> };
  context: { call: (input: { room?: string; since?: number; viewport?: string; select?: string[] }) => Promise<ToolResult> };
  prompts_list: { call: (input: { room?: string; status?: "pending" | "resolved" | "dismissed" | "all" }) => Promise<ToolResult> };
  ai_activity_status: { call: (input: { room?: string }) => Promise<ToolResult> };
};

function clientForRoom(deps: ReadOnlyDeps, room: string | undefined): CanvasClient {
  if (!room) return deps.client;
  const base = (deps.client as unknown as { base?: string }).base ?? "";
  return new CanvasClient({ baseUrl: base, room });
}

export function registerReadOnlyTools(server: McpServer, deps: ReadOnlyDeps): ReadOnlyHandles {
  // ── shemma_health ──────────────────────────────────────────────────────────
  async function healthCall(input: { ensure?: boolean; extended?: boolean }): Promise<ToolResult> {
    try {
      if (input.extended) {
        const info = await deps.client.getHealth();
        if (!info) {
          return toolResult({ ok: false, code: "daemon-unavailable", message: "daemon unreachable" });
        }
        return toolResult({ ok: true, data: info });
      }
      const healthy = await deps.client.health();
      return toolResult({ ok: true, data: { healthy } });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_health",
    {
      description: "Check daemon reachability. Optional: ensure=true to start daemon if down; extended=true to include profile/storage/version.",
      inputSchema: {
        ensure: z.boolean().optional(),
        extended: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => healthCall(args as { ensure?: boolean; extended?: boolean }),
  );

  // ── shemma_version ─────────────────────────────────────────────────────────
  async function versionCall(_input: Record<string, never>): Promise<ToolResult> {
    try {
      const data = await deps.client.getVersion();
      return toolResult({ ok: true, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_version",
    {
      description: "Return shemma CLI + MCP server version info.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_args) => versionCall({} as Record<string, never>),
  );

  // ── shemma_rooms_list ──────────────────────────────────────────────────────
  async function roomsListCall(_input: Record<string, never>): Promise<ToolResult> {
    try {
      const data = await deps.client.listRooms();
      return toolResult({ ok: true, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_rooms_list",
    {
      description: "List rooms known to the daemon.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_args) => roomsListCall({} as Record<string, never>),
  );

  // ── shemma_active_rooms ────────────────────────────────────────────────────
  async function activeRoomsCall(_input: Record<string, never>): Promise<ToolResult> {
    try {
      const data = await deps.client.getActiveRooms();
      return toolResult({ ok: true, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_active_rooms",
    {
      description: "List rooms currently focused in any tldraw UI tab, sorted by lastFocusedAt desc.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_args) => activeRoomsCall({} as Record<string, never>),
  );

  // ── shemma_context ─────────────────────────────────────────────────────────
  async function contextCall(input: { room?: string; since?: number; viewport?: string; select?: string[] }): Promise<ToolResult> {
    try {
      const client = clientForRoom(deps, input.room);
      const data = await client.getContext({ since: input.since, viewport: input.viewport, select: input.select });
      const room = input.room ?? deps.defaultRoom;
      return toolResult({ ok: true, room, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_context",
    {
      description: "Token-cheap domain context for a room. Optional: since=<version> for diff; viewport=x,y,w,h; select=<comma-separated ids>.",
      inputSchema: {
        room: z.string().optional(),
        since: z.number().optional(),
        viewport: z.string().optional(),
        select: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => contextCall(args as { room?: string; since?: number; viewport?: string; select?: string[] }),
  );

  // ── shemma_prompts_list ────────────────────────────────────────────────────
  async function promptsListCall(input: { room?: string; status?: "pending" | "resolved" | "dismissed" | "all" }): Promise<ToolResult> {
    try {
      const client = clientForRoom(deps, input.room);
      const data = await client.getPrompts(input.status ?? "pending");
      return toolResult({ ok: true, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_prompts_list",
    {
      description: "List canvas prompts. status ∈ pending|resolved|dismissed|all (default pending).",
      inputSchema: {
        room: z.string().optional(),
        status: z.enum(["pending", "resolved", "dismissed", "all"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => promptsListCall(args as { room?: string; status?: "pending" | "resolved" | "dismissed" | "all" }),
  );

  // ── shemma_ai_activity_status ──────────────────────────────────────────────
  async function aiActivityStatusCall(input: { room?: string }): Promise<ToolResult> {
    try {
      const client = clientForRoom(deps, input.room);
      const data = await client.aiActivity();
      return toolResult({ ok: true, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_ai_activity_status",
    {
      description: "Read current AI activity badge state.",
      inputSchema: {
        room: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => aiActivityStatusCall(args as { room?: string }),
  );

  return {
    health: { call: healthCall },
    version: { call: versionCall },
    rooms_list: { call: roomsListCall },
    active_rooms: { call: activeRoomsCall },
    context: { call: contextCall },
    prompts_list: { call: promptsListCall },
    ai_activity_status: { call: aiActivityStatusCall },
  };
}
