/**
 * shemma_canvas_view — MCP tool (DRW-134 Task 2.8).
 *
 * Always returns v2 `{ schemaVersion:"v2", frames, free }` shape. Calls
 * `GET /api/canvas/view` and passes the result through. AI should call this
 * tool **before** `shemma_patch_schema` to discover frameId and nodeIds —
 * patching without knowing the current state causes `unknown-node` errors.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { mapFetchError, toolResult, type ToolResult } from "../errors";
import { resolveSpaceOrError, type ResolveSpaceFn } from "../space-resolver";
import { CanvasViewArgs } from "../schemas";

export type CanvasViewDeps = {
  client: CanvasClient;
  /** DI seam for tests; defaults to real resolver. */
  resolveSpace?: ResolveSpaceFn;
};

export type CanvasViewInput = {
  room?: string;
  space?: string;
};

export type CanvasViewHandles = {
  canvas_view: { call: (input: CanvasViewInput) => Promise<ToolResult> };
};

export function registerCanvasViewTool(
  server: McpServer,
  deps: CanvasViewDeps,
): CanvasViewHandles {
  async function canvasViewCall(input: CanvasViewInput): Promise<ToolResult> {
    const spaceRes = resolveSpaceOrError(deps, input.space);
    if ("error" in spaceRes) return spaceRes.error;

    try {
      const client = new CanvasClient({
        baseUrl: deps.client.baseUrl,
        room: input.room ?? deps.client.room,
        space: spaceRes.spaceId,
      });
      const data = await client.getCanvasView();
      return toolResult({ ok: true, data });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_canvas_view",
    {
      description:
        "Read the current canvas state for a room. Always returns v2 shape: " +
        "{ schemaVersion:\"v2\", frames:[{id,label,bbox,raw,overlays},...], free:[{id,type,label,bbox},...] }. " +
        "For v1 (legacy) rooms, returns { schemaVersion:\"v1\", legacy:{...}, hint:\"...\" }. " +
        "**Always call this before shemma_patch_schema** — you need frameId and current nodeIds " +
        "to avoid `unknown-node` errors. " +
        "`frames` = schema-frames (v2 managed content). " +
        "`free` = shapes outside any schema-frame (legacy v1 shapes or user-drawn shapes). " +
        "Use `shemma_context` for legacy v1 read (returns domain summary with didraw_names). " +
        "Errors: daemon-unavailable (daemon offline), space-not-found / ambiguous-space.",
      inputSchema: CanvasViewArgs,
      annotations: { readOnlyHint: true },
    },
    async (args) => canvasViewCall(args as CanvasViewInput),
  );

  return {
    canvas_view: { call: canvasViewCall },
  };
}
