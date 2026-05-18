import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AutoOpenManager } from "../auto-open";
import { toolResult, type ToolResult } from "../errors";

export type OpenDeps = {
  autoOpen: AutoOpenManager;
  defaultRoom: string;
};

export type OpenHandles = {
  open: { call: (input: { room?: string; noBrowser?: boolean }) => Promise<ToolResult> };
};

export function registerOpenTool(server: McpServer, deps: OpenDeps): OpenHandles {
  async function openCall(input: { room?: string; noBrowser?: boolean }): Promise<ToolResult> {
    const room = input.room ?? deps.defaultRoom;
    if (input.noBrowser) {
      return toolResult({ ok: true, room, data: { spawned: false, reason: "noBrowser" } });
    }
    try {
      await deps.autoOpen.open(room);
      return toolResult({ ok: true, room, data: { spawned: true } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return toolResult({ ok: false, code: "unexpected-error", message: `failed to open: ${msg}` });
    }
  }

  server.registerTool(
    "shemma_open",
    {
      description: "Open a browser tab on the canvas. By default uses the resolved/default room.",
      inputSchema: { room: z.string().optional(), noBrowser: z.boolean().optional() },
      annotations: { openWorldHint: true },
    },
    async (args) => openCall(args as { room?: string; noBrowser?: boolean }),
  );

  return { open: { call: openCall } };
}
