
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CanvasClient } from "@shemma/client";
import { mapFetchError, toolResult, type ToolResult } from "../errors";
import type { RoomResolver } from "../room-resolver";
import { ExportMiroArgs } from "../schemas";

export type ExportMiroDeps = {
  client: CanvasClient;
  resolver: RoomResolver;
  defaultRoom: string;
};

type ExportMiroInput = z.infer<z.ZodObject<typeof ExportMiroArgs>>;

export type ExportMiroHandles = {
  exportMiro: { call: (input: ExportMiroInput) => Promise<ToolResult> };
};

export function registerExportMiroTool(
  server: McpServer,
  deps: ExportMiroDeps,
): ExportMiroHandles {
  async function exportMiroCall(input: ExportMiroInput): Promise<ToolResult> {
    const resolved = await deps.resolver.resolve({ argRoom: input.room });
    if (!resolved.ok) {
      return toolResult({
        ok: false,
        code: "ambiguous-room",
        message: resolved.message,
        details: { candidates: resolved.candidates },
      });
    }

    const url = `${deps.client.baseUrl}/api/export/miro?room=${encodeURIComponent(resolved.room)}`;
    const body = {
      boardId: input.boardId,
      boardName: input.boardName,
      selection: input.selection ?? [],
      scope: input.scope ?? "selection",
      dryRun: input.dryRun,
    };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        hint?: string;
        boardId?: string;
        boardUrl?: string;
        itemsCreated?: number;
        connectorsCreated?: number;
        skipped?: unknown[];
        dryRun?: boolean;
        itemCount?: number;
      };
      if (!res.ok || json.ok === false) {
        const errPayload = {
          ok: false as const,
          code: "http-error" as const,
          message: json.hint ?? json.error ?? `HTTP ${res.status}`,
          status: res.status,
          error: json.error,
          details: json,
        };
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: JSON.stringify(errPayload) }],
          structuredContent: errPayload,
        };
      }
      deps.resolver.recordTouch(resolved.room);
      const successPayload = {
        ok: true as const,
        room: resolved.room,
        roomSource: resolved.source,
        data: json,
        ...json,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(successPayload) }],
        structuredContent: successPayload,
      };
    } catch (e) {
      return toolResult({ ...mapFetchError(e) });
    }
  }

  server.registerTool(
    "shemma_export_miro",
    {
      description:
        "Export the current selection (or entire room) to a Miro board. " +
        "Append-only — each call creates new Miro items; tracking is stored in " +
        "room.meta.miroExports for future diff/update flows. Requires miro.token in " +
        "~/.config/shemma/config.json (run `shemma config set miro.token <token>`).",
      inputSchema: ExportMiroArgs,
      annotations: { openWorldHint: true },
    },
    async (args) => exportMiroCall(args as ExportMiroInput),
  );

  return { exportMiro: { call: exportMiroCall } };
}
