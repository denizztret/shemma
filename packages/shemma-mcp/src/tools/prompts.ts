import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { mapFetchError, toolResult } from "../errors";
import { clientForRoom } from "../client-utils";

export type PromptDeps = { client: CanvasClient; defaultRoom: string };

export type ToolResult = ReturnType<typeof toolResult>;

export type PromptHandles = {
  prompt_resolve: { call: (input: { id: string; response?: string; room?: string }) => Promise<ToolResult> };
  prompt_dismiss: { call: (input: { id: string; room?: string }) => Promise<ToolResult> };
  ai_activity_start: { call: (input: { actor: string; task: string; room?: string }) => Promise<ToolResult> };
  ai_activity_stop: { call: (input: { room?: string }) => Promise<ToolResult> };
};

export function registerPromptAndActivityTools(server: McpServer, deps: PromptDeps): PromptHandles {
  // ── shemma_prompt_resolve ──────────────────────────────────────────────────
  async function promptResolveCall(input: { id: string; response?: string; room?: string }): Promise<ToolResult> {
    try {
      const c = clientForRoom(deps.client, input.room);
      const data = await c.resolvePrompt(input.id, input.response);
      const room = input.room ?? deps.defaultRoom;
      return toolResult({ ok: true, room, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_prompt_resolve",
    {
      description: "Resolve a canvas prompt with an optional response text.",
      inputSchema: {
        id: z.string().min(1),
        response: z.string().optional(),
        room: z.string().optional(),
      },
    },
    async (args) => promptResolveCall(args as { id: string; response?: string; room?: string }),
  );

  // ── shemma_prompt_dismiss ──────────────────────────────────────────────────
  async function promptDismissCall(input: { id: string; room?: string }): Promise<ToolResult> {
    try {
      const c = clientForRoom(deps.client, input.room);
      const data = await c.dismissPrompt(input.id);
      const room = input.room ?? deps.defaultRoom;
      return toolResult({ ok: true, room, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_prompt_dismiss",
    {
      description: "Dismiss a canvas prompt.",
      inputSchema: {
        id: z.string().min(1),
        room: z.string().optional(),
      },
    },
    async (args) => promptDismissCall(args as { id: string; room?: string }),
  );

  // ── shemma_ai_activity_start ───────────────────────────────────────────────
  async function aiActivityStartCall(input: { actor: string; task: string; room?: string }): Promise<ToolResult> {
    try {
      const c = clientForRoom(deps.client, input.room);
      const data = await c.aiStart(input.actor, input.task);
      const room = input.room ?? deps.defaultRoom;
      return toolResult({ ok: true, room, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_ai_activity_start",
    {
      description: "Show the AI activity badge in the UI.",
      inputSchema: {
        actor: z.string().min(1),
        task: z.string().min(1),
        room: z.string().optional(),
      },
    },
    async (args) => aiActivityStartCall(args as { actor: string; task: string; room?: string }),
  );

  // ── shemma_ai_activity_stop ────────────────────────────────────────────────
  async function aiActivityStopCall(input: { room?: string }): Promise<ToolResult> {
    try {
      const c = clientForRoom(deps.client, input.room);
      const data = await c.aiStop();
      const room = input.room ?? deps.defaultRoom;
      return toolResult({ ok: true, room, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_ai_activity_stop",
    {
      description: "Clear the AI activity badge.",
      inputSchema: {
        room: z.string().optional(),
      },
    },
    async (args) => aiActivityStopCall(args as { room?: string }),
  );

  return {
    prompt_resolve: { call: promptResolveCall },
    prompt_dismiss: { call: promptDismissCall },
    ai_activity_start: { call: aiActivityStartCall },
    ai_activity_stop: { call: aiActivityStopCall },
  };
}
