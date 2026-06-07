/**
 * Schema write MCP tools (DRW-134 Task 2.8):
 *   shemma_create_schema  — POST /api/schema/create (Mode A: raw | Mode B: actions).
 *   shemma_patch_schema   — POST /api/schema/:frameId/patch with multi-schema resolver.
 *   shemma_set_overlay    — POST /api/schema/:frameId/overlay.
 *
 * Multi-schema resolver for patch:
 *   - No frameId + 0 schema-frames → `no-schema-frame` error.
 *   - No frameId + 1 schema-frame  → auto-pick that frame.
 *   - No frameId + ≥2 schema-frames → `ambiguous-schema-frame` error with availableFrameIds.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { mapFetchError, toolResult, type ToolResult } from "../errors";
import { resolveSpaceOrError, type ResolveSpaceFn } from "../space-resolver";
import { CreateSchemaArgs, PatchSchemaArgs, SetOverlayArgs, type OverlayEntrySchema } from "../schemas";
import type { z as ZodType } from "zod";

export type SchemaWriteDeps = {
  client: CanvasClient;
  /** DI seam for tests; defaults to real resolver. */
  resolveSpace?: ResolveSpaceFn;
};

type CreateInput = {
  label: string;
  raw?: string;
  actions?: unknown[];
  clientOpId?: string;
  room?: string;
  space?: string;
};

type PatchInput = {
  frameId?: string;
  actions: unknown[];
  clientOpId?: string;
  room?: string;
  space?: string;
};

type SetOverlayInput = {
  frameId: string;
  nodeId: string;
  overlay: ZodType.infer<typeof OverlayEntrySchema>;
  clientOpId?: string;
  room?: string;
  space?: string;
};

export type SchemaWriteHandles = {
  create_schema: { call: (input: CreateInput) => Promise<ToolResult> };
  patch_schema: { call: (input: PatchInput) => Promise<ToolResult> };
  set_overlay: { call: (input: SetOverlayInput) => Promise<ToolResult> };
};

/**
 * Multi-schema frame resolver: если frameId не указан — смотрим на room state
 * через canvas/view и auto-pick если ровно один schema-frame.
 */
async function resolveFrameId(
  client: CanvasClient,
  frameId: string | undefined,
): Promise<
  | { ok: true; frameId: string }
  | { ok: false; code: string; message: string; details?: unknown }
> {
  if (frameId) return { ok: true, frameId };

  // No frameId provided — need to enumerate schema-frames.
  let viewData: unknown;
  try {
    viewData = await client.getCanvasView();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, code: "daemon-unavailable", message: msg };
  }

  const view = viewData as {
    schemaVersion?: string;
    frames?: Array<{ id: string; label: string }>;
  };

  if (view.schemaVersion !== "v2" || !Array.isArray(view.frames)) {
    return {
      ok: false,
      code: "no-schema-frame",
      message:
        "Room has no schema-frames (v1 or empty). Create a schema-frame first with shemma_create_schema.",
    };
  }

  const frames = view.frames;

  if (frames.length === 0) {
    return {
      ok: false,
      code: "no-schema-frame",
      message:
        "Room has no schema-frames. Create one first with shemma_create_schema.",
    };
  }

  if (frames.length === 1) {
    return { ok: true, frameId: frames[0].id };
  }

  // Ambiguous: 2+ schema-frames.
  return {
    ok: false,
    code: "ambiguous-schema-frame",
    message:
      `Room has ${frames.length} schema-frames; provide explicit frameId. ` +
      `Available: ${frames.map((f) => f.id).join(", ")}`,
    details: { availableFrameIds: frames.map((f) => f.id) },
  };
}

export function registerSchemaWriteTools(
  server: McpServer,
  deps: SchemaWriteDeps,
): SchemaWriteHandles {
  // ── shemma_create_schema ──────────────────────────────────────────────────

  async function createSchemaCall(input: CreateInput): Promise<ToolResult> {
    const spaceRes = resolveSpaceOrError(deps, input.space);
    if ("error" in spaceRes) return spaceRes.error;

    const { label, raw, actions, clientOpId, room } = input;

    if (!raw && !actions) {
      return toolResult({
        ok: false,
        code: "validation-error",
        message: "Either 'raw' (mermaid string) or 'actions' array must be provided.",
      });
    }

    const clientOpIdFinal = clientOpId ?? crypto.randomUUID();

    try {
      const client = new CanvasClient({
        baseUrl: deps.client.baseUrl,
        room: room ?? deps.client.room,
        space: spaceRes.spaceId,
      });

      const body: Record<string, unknown> = { label, clientOpId: clientOpIdFinal };
      if (raw !== undefined) body.raw = raw;
      if (actions !== undefined) body.actions = actions;

      const resp = (await client.createSchema(
        body as Parameters<typeof client.createSchema>[0],
      )) as {
        ok?: boolean;
        frameId?: string;
        nodeIds?: string[];
        version?: number;
        errors?: Array<{ code?: string; message?: string }>;
      };

      if (resp.ok) {
        return toolResult({
          ok: true,
          room: room ?? deps.client.room,
          version: resp.version,
          clientOpId: clientOpIdFinal,
          data: {
            frameId: resp.frameId,
            nodeIds: resp.nodeIds ?? [],
            version: resp.version,
          },
        });
      }

      const firstCreateError = Array.isArray(resp.errors) && resp.errors.length > 0
        ? (resp.errors[0] as { code?: string; message?: string })
        : undefined;
      return toolResult({
        ok: false,
        code: "validation-error",
        message: firstCreateError?.message ?? firstCreateError?.code ?? "schema create failed",
        clientOpId: clientOpIdFinal,
        details: { errors: resp.errors },
      });
    } catch (e) {
      return toolResult({ ...mapFetchError(e), clientOpId: clientOpIdFinal });
    }
  }

  server.registerTool(
    "shemma_create_schema",
    {
      description:
        "Create a new schema-frame in the room from a Mermaid diagram or SchemaAction list. " +
        "Automatically upgrades the room to v2 protocol on first call. " +
        "ONE FRAME = ONE CONNECTED SCHEMA: this is the right tool whenever the user asks for a " +
        "NEW diagram that is not connected to an existing frame's graph — do not patch a " +
        "disconnected diagram into an existing frame. " +
        "Mode A (preferred): pass `raw` — a flowchart/graph mermaid string (e.g. 'graph LR\\n  api[API] --> db[(DB)]'). " +
        "Mode B: pass `actions` — array of SchemaAction objects (schema-define, schema-connect, ...). " +
        "Exactly one of `raw` or `actions` must be provided. " +
        "Returns: { frameId, nodeIds, version }. " +
        "After creation, call shemma_canvas_view to see the frame and its nodeIds before patching. " +
        "Errors: validation-error (bad mermaid syntax / unsupported diagram type), daemon-unavailable.",
      inputSchema: CreateSchemaArgs,
      annotations: { idempotentHint: true },
    },
    async (args) => createSchemaCall(args as CreateInput),
  );

  // ── shemma_patch_schema ───────────────────────────────────────────────────

  async function patchSchemaCall(input: PatchInput): Promise<ToolResult> {
    const spaceRes = resolveSpaceOrError(deps, input.space);
    if ("error" in spaceRes) return spaceRes.error;

    const { actions, clientOpId, room } = input;
    const clientOpIdFinal = clientOpId ?? crypto.randomUUID();

    try {
      const client = new CanvasClient({
        baseUrl: deps.client.baseUrl,
        room: room ?? deps.client.room,
        space: spaceRes.spaceId,
      });

      // Multi-schema resolver: auto-pick if frameId is omitted.
      const resolved = await resolveFrameId(client, input.frameId);
      if (!resolved.ok) {
        return toolResult({
          ok: false,
          code: resolved.code as "validation-error",
          message: resolved.message,
          clientOpId: clientOpIdFinal,
          details: resolved.details,
        });
      }

      const { frameId } = resolved;

      const resp = (await client.patchSchema(frameId, {
        actions,
        clientOpId: clientOpIdFinal,
      })) as {
        ok?: boolean;
        frameId?: string;
        version?: number;
        orphanedOverlays?: number;
        addedNodeIds?: string[];
        removedNodeIds?: string[];
        destructiveScore?: number;
        idempotent?: boolean;
        errors?: Array<{ code?: string; message?: string }>;
      };

      if (resp.ok) {
        return toolResult({
          ok: true,
          room: room ?? deps.client.room,
          version: resp.version,
          clientOpId: clientOpIdFinal,
          idempotent: resp.idempotent ? true : undefined,
          data: {
            frameId: resp.frameId ?? frameId,
            addedNodeIds: resp.addedNodeIds ?? [],
            removedNodeIds: resp.removedNodeIds ?? [],
            orphanedOverlays: resp.orphanedOverlays ?? 0,
            destructiveScore: resp.destructiveScore ?? 0,
          },
        });
      }

      const firstError = Array.isArray(resp.errors) && resp.errors.length > 0
        ? (resp.errors[0] as { code?: string; message?: string })
        : undefined;
      return toolResult({
        ok: false,
        code: "validation-error",
        message: firstError?.message ?? firstError?.code ?? "patch failed",
        clientOpId: clientOpIdFinal,
        details: { errors: resp.errors },
      });
    } catch (e) {
      return toolResult({ ...mapFetchError(e), clientOpId: clientOpIdFinal });
    }
  }

  server.registerTool(
    "shemma_patch_schema",
    {
      description:
        "Apply incremental SchemaAction[] to an existing schema-frame — this is the object-first " +
        "edit path for v2 schemas (the board is the source of truth; do not hand-edit raw Mermaid). " +
        "**Always call shemma_canvas_view first** to get frameId and current nodeIds — " +
        "referencing unknown nodeIds returns `unknown-node` errors. " +
        "schema-connect endpoints may live inside containers (subgraphs); they resolve fine. " +
        "Smart-insert places new nodes into free space and grows the frame automatically — " +
        "do NOT call shemma_layout after edits unless the USER explicitly asks for a re-layout: " +
        "the board arrangement belongs to the user and must survive agent edits. " +
        "ONE FRAME = ONE CONNECTED SCHEMA: never patch a parallel DISCONNECTED diagram into an " +
        "existing frame — a second component degrades the frame's layout and auto-direction; " +
        "create a separate frame via shemma_create_schema instead. " +
        "If frameId is omitted and the room has exactly 1 schema-frame, it is auto-picked. " +
        "If ≥2 schema-frames exist, frameId is required (ambiguous-schema-frame error otherwise). " +
        "Supported action kinds: schema-define, schema-connect, schema-rename, schema-set-role, " +
        "schema-group, schema-disconnect, schema-delete-node, schema-set-overlay, " +
        "schema-set-edge-overlay (restyle an existing edge addressed by from→to: " +
        "color/labelColor/dash/size/kind(arc|elbow)/arrowheadStart/arrowheadEnd/label; " +
        "applies to the live arrow immediately and persists; NB: the model keeps ONE edge " +
        "per from→to pair — parallel duplicate arrows are restyled together), " +
        "schema-adopt-shape (turn a hand-drawn shape into a schema node IN PLACE: " +
        "{shapeId, role, label?, nodeId?} — position/size/look preserved, the node appears " +
        "in raw and becomes addressable by connect/rename/set-overlay/delete-node), " +
        "schema-delete-shape (delete a NON-schema shape by tldraw shapeId with binding/" +
        "dangling-arrow cascade; for schema nodes use schema-delete-node), " +
        "schema-set-container-style ({name, style:{color/fill/dash/titlePosition}} — " +
        "restyle a group's container addressed by its group name), " +
        "schema-set-frame-style ({style:{color/label}} — frame border color and display " +
        "label). Node overlays also support geo (shape form: ellipse/diamond/cloud/...) " +
        "and opacity (0..1). " +
        "Batch is all-or-nothing: if any action fails validation, none are applied. " +
        "Returns: { frameId, addedNodeIds, removedNodeIds, orphanedOverlays, destructiveScore }. " +
        "Errors: no-schema-frame (room has no schema-frames), " +
        "ambiguous-schema-frame (≥2 frames, pass explicit frameId), " +
        "validation-error (unknown-node / invalid-role / etc.), daemon-unavailable.",
      inputSchema: PatchSchemaArgs,
      annotations: { idempotentHint: true },
    },
    async (args) => patchSchemaCall(args as PatchInput),
  );

  // ── shemma_set_overlay ────────────────────────────────────────────────────

  async function setOverlayCall(input: SetOverlayInput): Promise<ToolResult> {
    const spaceRes = resolveSpaceOrError(deps, input.space);
    if ("error" in spaceRes) return spaceRes.error;

    const { frameId, nodeId, overlay, clientOpId, room } = input;
    const clientOpIdFinal = clientOpId ?? crypto.randomUUID();

    try {
      const client = new CanvasClient({
        baseUrl: deps.client.baseUrl,
        room: room ?? deps.client.room,
        space: spaceRes.spaceId,
      });

      const resp = (await client.setOverlay(frameId, {
        nodeId,
        overlay: overlay as Record<string, unknown>,
        clientOpId: clientOpIdFinal,
      })) as {
        ok?: boolean;
        error?: string;
      };

      if (resp.ok) {
        return toolResult({
          ok: true,
          room: room ?? deps.client.room,
          clientOpId: clientOpIdFinal,
          data: { ok: true },
        });
      }

      return toolResult({
        ok: false,
        code: "validation-error",
        message: resp.error ?? "set-overlay failed",
        clientOpId: clientOpIdFinal,
      });
    } catch (e) {
      return toolResult({ ...mapFetchError(e), clientOpId: clientOpIdFinal });
    }
  }

  server.registerTool(
    "shemma_set_overlay",
    {
      description:
        "Write a user-style overlay for a specific node inside a schema-frame. " +
        "Overlays store user-driven position / color / label overrides on top of the schema RAW. " +
        "Deep-merges into existing overlay (does NOT replace the whole entry). " +
        "Ownership guard: if the node already has styleOwnedBy:\"user\", only requests with " +
        "styleOwnedBy:\"user\" can update it (prevents AI from overwriting user layout). " +
        "Required: frameId, nodeId, overlay (at least one field: position/color/label/role/pinned/styleOwnedBy). " +
        "Returns: { ok: true }. " +
        "Errors: validation-error (overlay-user-owned, frame-not-found, not-schema-frame), daemon-unavailable.",
      inputSchema: SetOverlayArgs,
      annotations: { idempotentHint: true },
    },
    async (args) => setOverlayCall(args as SetOverlayInput),
  );

  return {
    create_schema: { call: createSchemaCall },
    patch_schema: { call: patchSchemaCall },
    set_overlay: { call: setOverlayCall },
  };
}
