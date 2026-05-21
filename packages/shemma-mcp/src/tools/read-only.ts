import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { mapFetchError, toolResult, type ToolResult } from "../errors";
import { clientForRoom } from "../client-utils";
import { resolveSpace as defaultResolveSpace, type ResolveSpaceFn } from "../space-resolver";

export type ReadOnlyDeps = {
  client: CanvasClient;
  defaultRoom: string;
  /** DRW-116 Task 26: DI seam for tests; defaults to real resolver. */
  resolveSpace?: ResolveSpaceFn;
};

export type ReadOnlyHandles = {
  health: { call: (input: { ensure?: boolean; extended?: boolean }) => Promise<ToolResult> };
  version: { call: (input: Record<string, never>) => Promise<ToolResult> };
  rooms_list: { call: (input: { space?: string }) => Promise<ToolResult> };
  active_rooms: { call: (input: { space?: string }) => Promise<ToolResult> };
  context: { call: (input: { room?: string; space?: string; since?: number; viewport?: string; select?: string[] }) => Promise<ToolResult> };
  prompts_list: { call: (input: { room?: string; space?: string; status?: "pending" | "resolved" | "dismissed" | "all" }) => Promise<ToolResult> };
  ai_activity_status: { call: (input: { room?: string; space?: string }) => Promise<ToolResult> };
};

/** Resolve space via DI'd resolver and map ambiguity → ToolResult error. */
function resolveSpaceOrError(
  deps: { resolveSpace?: ResolveSpaceFn },
  argSpace: string | undefined,
): { spaceId: string } | { error: ToolResult } {
  const resolver = deps.resolveSpace ?? defaultResolveSpace;
  const r = resolver({ space: argSpace });
  if (r.error) {
    const code = r.source === "not_found" ? "space-not-found" : "ambiguous-space";
    return { error: toolResult({ ok: false, code, message: r.error }) };
  }
  return { spaceId: r.space.id };
}

export function registerReadOnlyTools(server: McpServer, deps: ReadOnlyDeps): ReadOnlyHandles {
  /** Wraps a no-argument client fetch in the standard try/catch → toolResult pattern. */
  async function fetchData(fetch: () => Promise<unknown>): Promise<ToolResult> {
    try {
      const data = await fetch();
      return toolResult({ ok: true, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  // ── shemma_health ──────────────────────────────────────────────────────────
  const ENSURE_WARNING = "ensure not yet implemented; pass --auto-ensure to shemma mcp start instead";

  async function healthCall(input: { ensure?: boolean; extended?: boolean }): Promise<ToolResult> {
    try {
      if (input.extended) {
        const info = await deps.client.getHealth();
        if (!info) {
          const details = input.ensure ? { warning: ENSURE_WARNING } : undefined;
          return toolResult({ ok: false, code: "daemon-unavailable", message: "daemon unreachable", details });
        }
        return toolResult({ ok: true, data: info });
      }
      const healthy = await deps.client.health();
      if (!healthy && input.ensure) {
        return toolResult({ ok: true, data: { healthy: false, warning: ENSURE_WARNING } });
      }
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
    return fetchData(() => deps.client.getVersion());
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
  async function roomsListCall(input: { space?: string }): Promise<ToolResult> {
    const spaceRes = resolveSpaceOrError(deps, input.space);
    if ("error" in spaceRes) return spaceRes.error;
    try {
      const client = new CanvasClient({ baseUrl: deps.client.baseUrl, space: spaceRes.spaceId });
      const data = await client.listRooms();
      return toolResult({ ok: true, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_rooms_list",
    {
      description: "List rooms known to the daemon for the resolved space.",
      inputSchema: {
        space: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => roomsListCall(args as { space?: string }),
  );

  // ── shemma_active_rooms ────────────────────────────────────────────────────
  async function activeRoomsCall(input: { space?: string }): Promise<ToolResult> {
    let spaceId: string | undefined;
    if (input.space) {
      const spaceRes = resolveSpaceOrError(deps, input.space);
      if ("error" in spaceRes) return spaceRes.error;
      spaceId = spaceRes.spaceId;
    }
    return fetchData(() => deps.client.getActiveRooms(spaceId !== undefined ? { space: spaceId } : {}));
  }

  server.registerTool(
    "shemma_active_rooms",
    {
      description: "List rooms currently focused in any tldraw UI tab, sorted by lastFocusedAt desc. Optional: space filter.",
      inputSchema: {
        space: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => activeRoomsCall(args as { space?: string }),
  );

  // ── shemma_context ─────────────────────────────────────────────────────────
  async function contextCall(input: { room?: string; space?: string; since?: number; viewport?: string; select?: string[] }): Promise<ToolResult> {
    const spaceRes = resolveSpaceOrError(deps, input.space);
    if ("error" in spaceRes) return spaceRes.error;
    try {
      const client = clientForRoom(deps.client, input.room, spaceRes.spaceId);
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
        space: z.string().optional(),
        since: z.number().optional(),
        viewport: z.string().optional(),
        select: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => contextCall(args as { room?: string; space?: string; since?: number; viewport?: string; select?: string[] }),
  );

  // ── shemma_prompts_list ────────────────────────────────────────────────────
  async function promptsListCall(input: { room?: string; space?: string; status?: "pending" | "resolved" | "dismissed" | "all" }): Promise<ToolResult> {
    const spaceRes = resolveSpaceOrError(deps, input.space);
    if ("error" in spaceRes) return spaceRes.error;
    try {
      const client = clientForRoom(deps.client, input.room, spaceRes.spaceId);
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
        space: z.string().optional(),
        status: z.enum(["pending", "resolved", "dismissed", "all"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => promptsListCall(args as { room?: string; space?: string; status?: "pending" | "resolved" | "dismissed" | "all" }),
  );

  // ── shemma_ai_activity_status ──────────────────────────────────────────────
  async function aiActivityStatusCall(input: { room?: string; space?: string }): Promise<ToolResult> {
    const spaceRes = resolveSpaceOrError(deps, input.space);
    if ("error" in spaceRes) return spaceRes.error;
    return fetchData(() => clientForRoom(deps.client, input.room, spaceRes.spaceId).aiActivity());
  }

  server.registerTool(
    "shemma_ai_activity_status",
    {
      description: "Read current AI activity badge state.",
      inputSchema: {
        room: z.string().optional(),
        space: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => aiActivityStatusCall(args as { room?: string; space?: string }),
  );

  return {
    health: { call: healthCall },
    version: { call: versionCall },
    rooms_list: { call: (input: { space?: string }) => roomsListCall(input) },
    active_rooms: { call: (input: { space?: string }) => activeRoomsCall(input) },
    context: { call: contextCall },
    prompts_list: { call: promptsListCall },
    ai_activity_status: { call: aiActivityStatusCall },
  };
}
