/**
 * Schema duplicate + delete MCP tools — DRW-134 Task 3.1.
 *
 *   shemma_duplicate_schema — POST /api/schema/:frameId/duplicate
 *   shemma_delete_schema    — DELETE /api/schema/:frameId
 *
 * Следуют тому же паттерну что и schema-write.ts:
 *   resolveSpaceOrError → CanvasClient → toolResult.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CanvasClient } from "@shemma/client";
import { mapFetchError, toolResult, type ToolResult } from "../errors";
import { resolveSpaceOrError, type ResolveSpaceFn } from "../space-resolver";

// ---- Zod schemas (локальные, не нужны в глобальном schemas.ts) ----

const DuplicateSchemaArgs = {
  frameId: z.string().describe("ID schema-frame для дубликации (shape:f_...)."),
  newLabel: z
    .string()
    .optional()
    .describe(
      "Label для нового дублированного frame'а. Если не указан — используется '<original> (copy)'.",
    ),
  room: z.string().optional(),
  space: z.string().optional(),
};

const DeleteSchemaArgs = {
  frameId: z.string().describe("ID schema-frame для удаления (shape:f_...). Удаляет frame + всех детей."),
  room: z.string().optional(),
  space: z.string().optional(),
};

// ---- Deps type ----

export type SchemaDuplicateDeps = {
  client: CanvasClient;
  resolveSpace?: ResolveSpaceFn;
};

// ---- Input types ----

type DuplicateInput = {
  frameId: string;
  newLabel?: string;
  room?: string;
  space?: string;
};

type DeleteInput = {
  frameId: string;
  room?: string;
  space?: string;
};

// ---- Handles ----

export type SchemaDuplicateHandles = {
  duplicate_schema: { call: (input: DuplicateInput) => Promise<ToolResult> };
  delete_schema: { call: (input: DeleteInput) => Promise<ToolResult> };
};

// ---- Registration ----

export function registerSchemaDuplicateTools(
  server: McpServer,
  deps: SchemaDuplicateDeps,
): SchemaDuplicateHandles {
  // ── shemma_duplicate_schema ──────────────────────────────────────────────

  async function duplicateSchemaCall(input: DuplicateInput): Promise<ToolResult> {
    const spaceRes = resolveSpaceOrError(deps, input.space);
    if ("error" in spaceRes) return spaceRes.error;

    const { frameId, newLabel, room } = input;

    try {
      const client = new CanvasClient({
        baseUrl: deps.client.baseUrl,
        room: room ?? deps.client.room,
        space: spaceRes.spaceId,
      });

      const resp = (await client.duplicateSchema(frameId, { newLabel })) as {
        ok?: boolean;
        newFrameId?: string;
        nodeIdMap?: Record<string, string>;
        error?: string;
        code?: string;
      };

      if (resp.ok) {
        return toolResult({
          ok: true,
          room: room ?? deps.client.room,
          data: {
            newFrameId: resp.newFrameId,
            nodeIdMap: resp.nodeIdMap ?? {},
          },
        });
      }

      return toolResult({
        ok: false,
        code: "validation-error",
        message: resp.error ?? resp.code ?? "duplicate-schema failed",
        details: resp,
      });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_duplicate_schema",
    {
      description:
        "Duplicate a schema-frame with full identity remap. " +
        "Creates a new frame to the right of the original with all NodeIds regenerated. " +
        "Original frame is NOT modified (use for creating 'version B' before destructive edits). " +
        "Spec: AI MUST call shemma_duplicate_schema before making destructive schema changes " +
        "(deleting >50% nodes, changing direction LR→TD, etc.). " +
        "Returns: { newFrameId, nodeIdMap: { oldNodeId → newNodeId } }. " +
        "Use newFrameId + new nodeIds from nodeIdMap when patching the duplicate. " +
        "Errors: frame-not-found (frameId does not exist), not-schema-frame (target is not a schema-frame), " +
        "legacy-room-not-v2 (room needs v2 upgrade via shemma_create_schema), daemon-unavailable.",
      inputSchema: DuplicateSchemaArgs,
      annotations: { idempotentHint: false },
    },
    async (args) => duplicateSchemaCall(args as DuplicateInput),
  );

  // ── shemma_delete_schema ─────────────────────────────────────────────────

  async function deleteSchemaCall(input: DeleteInput): Promise<ToolResult> {
    const spaceRes = resolveSpaceOrError(deps, input.space);
    if ("error" in spaceRes) return spaceRes.error;

    const { frameId, room } = input;

    try {
      const client = new CanvasClient({
        baseUrl: deps.client.baseUrl,
        room: room ?? deps.client.room,
        space: spaceRes.spaceId,
      });

      const resp = (await client.deleteSchema(frameId)) as {
        ok?: boolean;
        error?: string;
        code?: string;
      };

      if (resp.ok) {
        return toolResult({
          ok: true,
          room: room ?? deps.client.room,
          data: { ok: true, deletedFrameId: frameId },
        });
      }

      return toolResult({
        ok: false,
        code: "validation-error",
        message: resp.error ?? resp.code ?? "delete-schema failed",
        details: resp,
      });
    } catch (e) {
      return toolResult(mapFetchError(e));
    }
  }

  server.registerTool(
    "shemma_delete_schema",
    {
      description:
        "Delete a schema-frame and ALL its children from the canvas. " +
        "This is a permanent destructive operation — no undo unless the room has history. " +
        "Prefer shemma_duplicate_schema first to preserve the original before edits. " +
        "Use for cleanup of obsolete versions or discarded drafts. " +
        "Returns: { ok: true, deletedFrameId }. " +
        "Errors: frame-not-found (frameId does not exist), not-schema-frame (target is not a schema-frame), " +
        "legacy-room-not-v2 (room needs v2 upgrade), daemon-unavailable.",
      inputSchema: DeleteSchemaArgs,
      annotations: { idempotentHint: false },
    },
    async (args) => deleteSchemaCall(args as DeleteInput),
  );

  return {
    duplicate_schema: { call: duplicateSchemaCall },
    delete_schema: { call: deleteSchemaCall },
  };
}
