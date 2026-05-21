import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { mapFetchError, toolResult, type ToolResult } from "../errors";
import { clientForRoom } from "../client-utils";
import { resolveSpace as defaultResolveSpace, type ResolveSpaceFn } from "../space-resolver";

export type PromptDeps = {
  client: CanvasClient;
  defaultRoom: string;
  /** DRW-116 Task 26: DI seam for tests; defaults to real resolver. */
  resolveSpace?: ResolveSpaceFn;
};

export type PromptHandles = {
  prompt_resolve: { call: (input: { id: string; response?: string; room?: string; space?: string }) => Promise<ToolResult> };
  prompt_dismiss: { call: (input: { id: string; room?: string; space?: string }) => Promise<ToolResult> };
  ai_activity_start: { call: (input: { actor: string; task: string; room?: string; space?: string }) => Promise<ToolResult> };
  ai_activity_stop: { call: (input: { room?: string; space?: string }) => Promise<ToolResult> };
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

export function registerPromptAndActivityTools(server: McpServer, deps: PromptDeps): PromptHandles {
  /** Wraps a room-scoped client call in the standard try/catch → toolResult pattern. */
  async function roomFetch(
    roomArg: string | undefined,
    spaceArg: string | undefined,
    fetch: (c: CanvasClient) => Promise<unknown>,
  ): Promise<ToolResult> {
    const spaceRes = resolveSpaceOrError(deps, spaceArg);
    if ("error" in spaceRes) return spaceRes.error;
    try {
      const c = clientForRoom(deps.client, roomArg, spaceRes.spaceId);
      const data = await fetch(c);
      const room = roomArg ?? deps.defaultRoom;
      return toolResult({ ok: true, room, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  // ── shemma_prompt_resolve ──────────────────────────────────────────────────
  async function promptResolveCall(input: { id: string; response?: string; room?: string; space?: string }): Promise<ToolResult> {
    return roomFetch(input.room, input.space, (c) => c.resolvePrompt(input.id, input.response));
  }

  server.registerTool(
    "shemma_prompt_resolve",
    {
      description: "Resolve a canvas prompt with an optional response text.",
      inputSchema: {
        id: z.string().min(1),
        response: z.string().optional(),
        room: z.string().optional(),
        space: z.string().optional(),
      },
    },
    async (args) => promptResolveCall(args as { id: string; response?: string; room?: string; space?: string }),
  );

  // ── shemma_prompt_dismiss ──────────────────────────────────────────────────
  async function promptDismissCall(input: { id: string; room?: string; space?: string }): Promise<ToolResult> {
    return roomFetch(input.room, input.space, (c) => c.dismissPrompt(input.id));
  }

  server.registerTool(
    "shemma_prompt_dismiss",
    {
      description: "Dismiss a canvas prompt.",
      inputSchema: {
        id: z.string().min(1),
        room: z.string().optional(),
        space: z.string().optional(),
      },
    },
    async (args) => promptDismissCall(args as { id: string; room?: string; space?: string }),
  );

  // ── shemma_ai_activity_start ───────────────────────────────────────────────
  async function aiActivityStartCall(input: { actor: string; task: string; room?: string; space?: string }): Promise<ToolResult> {
    return roomFetch(input.room, input.space, (c) => c.aiStart(input.actor, input.task));
  }

  server.registerTool(
    "shemma_ai_activity_start",
    {
      description: "Show the AI activity badge in the UI.",
      inputSchema: {
        actor: z.string().min(1),
        task: z.string().min(1),
        room: z.string().optional(),
        space: z.string().optional(),
      },
    },
    async (args) => aiActivityStartCall(args as { actor: string; task: string; room?: string; space?: string }),
  );

  // ── shemma_ai_activity_stop ────────────────────────────────────────────────
  async function aiActivityStopCall(input: { room?: string; space?: string }): Promise<ToolResult> {
    return roomFetch(input.room, input.space, (c) => c.aiStop());
  }

  server.registerTool(
    "shemma_ai_activity_stop",
    {
      description: "Clear the AI activity badge.",
      inputSchema: {
        room: z.string().optional(),
        space: z.string().optional(),
      },
    },
    async (args) => aiActivityStopCall(args as { room?: string; space?: string }),
  );

  return {
    prompt_resolve: { call: promptResolveCall },
    prompt_dismiss: { call: promptDismissCall },
    ai_activity_start: { call: aiActivityStartCall },
    ai_activity_stop: { call: aiActivityStopCall },
  };
}
