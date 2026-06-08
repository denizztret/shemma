import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { mapBackendError, mapFetchError, toolResult, type ToolResult } from "../errors";
import type { RoomResolver } from "../room-resolver";
import type { AutoOpenManager } from "../auto-open";
import { resolveSpaceOrError, type ResolveSpaceFn } from "../space-resolver";
import {
  DefineArgs,
  ConnectArgs,
  GroupArgs,
  NoteArgs,
  LayoutArgs,
  LayoutSelectionArgs,
  DeleteArgs,
  ApplyArgs,
  ImportMermaidArgs,
} from "../schemas";

export type DomainDeps = {
  client: CanvasClient;
  resolver: RoomResolver;
  defaultRoom?: string;
  autoOpen?: AutoOpenManager;
  /** DRW-116 Task 26: DI seam for tests; defaults to real resolver. */
  resolveSpace?: ResolveSpaceFn;
};

type DefineInput = z.infer<z.ZodObject<typeof DefineArgs>>;
type ConnectInput = z.infer<z.ZodObject<typeof ConnectArgs>>;
type GroupInput = z.infer<z.ZodObject<typeof GroupArgs>>;
type NoteInput = z.infer<z.ZodObject<typeof NoteArgs>>;
type LayoutInput = z.infer<z.ZodObject<typeof LayoutArgs>>;
type LayoutSelectionInput = z.infer<z.ZodObject<typeof LayoutSelectionArgs>>;
type DeleteInput = z.infer<z.ZodObject<typeof DeleteArgs>>;
type ApplyInput = z.infer<z.ZodObject<typeof ApplyArgs>>;
type ImportMermaidInput = z.infer<z.ZodObject<typeof ImportMermaidArgs>>;

export type DomainHandles = {
  define: { call: (input: DefineInput) => Promise<ToolResult> };
  connect: { call: (input: ConnectInput) => Promise<ToolResult> };
  group: { call: (input: GroupInput) => Promise<ToolResult> };
  note: { call: (input: NoteInput) => Promise<ToolResult> };
  layout: { call: (input: LayoutInput) => Promise<ToolResult> };
  layoutSelection: { call: (input: LayoutSelectionInput) => Promise<ToolResult> };
  delete: { call: (input: DeleteInput) => Promise<ToolResult> };
  apply: { call: (input: ApplyInput) => Promise<ToolResult> };
  importMermaid: { call: (input: ImportMermaidInput) => Promise<ToolResult> };
};

type CommonArgs = {
  room?: string;
  space?: string;
  clientOpId?: string;
  dryRun?: boolean;
  layoutHint?: unknown;
};

async function runActions(
  deps: DomainDeps,
  argRoom: string | undefined,
  actions: Array<Record<string, unknown>>,
  args: CommonArgs,
): Promise<ToolResult> {
  const spaceRes = resolveSpaceOrError(deps, args.space);
  if ("error" in spaceRes) return spaceRes.error;

  const resolved = await deps.resolver.resolve({ argRoom });
  if (!resolved.ok) {
    return toolResult({
      ok: false,
      code: "ambiguous-room",
      message: resolved.message,
      details: { candidates: resolved.candidates },
    });
  }

  const clientOpId = args.clientOpId ?? crypto.randomUUID();
  try {
    const c = new CanvasClient({
      baseUrl: deps.client.baseUrl,
      room: resolved.room,
      space: spaceRes.spaceId,
    });
    const resp = (await c.applyDomain({
      actions,
      clientOpId,
      dryRun: args.dryRun,
      layoutHint: args.layoutHint,
    })) as {
      ok: boolean;
      version?: number;
      results?: unknown[];
      layout?: unknown;
      errors?: unknown[];
      idempotent?: true;
    };
    if (resp.ok) {
      deps.resolver.recordTouch(resolved.room);
      let autoOpen: { openedRoom?: string; openConsentRequired?: boolean } = {};
      if (!args.dryRun && deps.autoOpen) {
        try {
          autoOpen = await deps.autoOpen.notifyWrite(resolved.room);
        } catch {
          // Auto-open is best-effort: subprocess failures must not block the write.
          // TODO: surface to stderr if a structured logger is introduced.
        }
      }
      return toolResult({
        ok: true,
        room: resolved.room,
        roomSource: resolved.source,
        version: resp.version,
        clientOpId,
        idempotent: resp.idempotent,
        data: { results: resp.results, layout: resp.layout, autoOpen },
      });
    }
    // DRW-221: the daemon answered with an error (resp carries `httpStatus` from
    // the client). Map by status — backend error ≠ daemon-unavailable.
    return toolResult(mapBackendError(resp, clientOpId));
  } catch (e) {
    return toolResult({ ...mapFetchError(e), clientOpId });
  }
}

export function registerDomainTools(server: McpServer, deps: DomainDeps): DomainHandles {
  // ── shemma_define ───────────────────────────────────────────────────────────
  async function defineCall(input: DefineInput): Promise<ToolResult> {
    const { room, space, clientOpId, dryRun, layoutHint, name, role, label } = input;
    const action: Record<string, unknown> = { kind: "define", name, role };
    if (label !== undefined) action.label = label;
    return runActions(deps, room, [action], { space, clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_define",
    {
      description: "Define (create or upsert) a named element with a role on the canvas.",
      inputSchema: DefineArgs,
      annotations: { idempotentHint: true },
    },
    async (args) => defineCall(args as DefineInput),
  );

  // ── shemma_connect ──────────────────────────────────────────────────────────
  async function connectCall(input: ConnectInput): Promise<ToolResult> {
    const { room, space, clientOpId, dryRun, layoutHint, from, to, connectionKind, label } = input;
    const action: Record<string, unknown> = { kind: "connect", from, to, connectionKind };
    if (label !== undefined) action.label = label;
    return runActions(deps, room, [action], { space, clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_connect",
    {
      description: "Connect two elements with a directed edge of a given connectionKind.",
      inputSchema: ConnectArgs,
      annotations: { idempotentHint: true },
    },
    async (args) => connectCall(args as ConnectInput),
  );

  // ── shemma_group ────────────────────────────────────────────────────────────
  async function groupCall(input: GroupInput): Promise<ToolResult> {
    const { room, space, clientOpId, dryRun, layoutHint, name, label, children, as } = input;
    // DRW-072: domain validator требует as ∈ {network, boundary}. Если не пришло
    // от MCP-клиента — default "boundary" (visible container, наиболее частый
    // use-case для архитектурных диаграмм).
    const action: Record<string, unknown> = { kind: "group", name, children, as: as ?? "boundary" };
    if (label !== undefined) action.label = label;
    return runActions(deps, room, [action], { space, clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_group",
    {
      description: "Create or update a group containing specified child elements.",
      inputSchema: GroupArgs,
      annotations: { idempotentHint: true },
    },
    async (args) => groupCall(args as GroupInput),
  );

  // ── shemma_note ─────────────────────────────────────────────────────────────
  async function noteCall(input: NoteInput): Promise<ToolResult> {
    const { room, space, clientOpId, dryRun, layoutHint, name, text } = input;
    return runActions(deps, room, [{ kind: "note", name, text }], { space, clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_note",
    {
      description: "Place or update a free-form text note on the canvas.",
      inputSchema: NoteArgs,
      annotations: { idempotentHint: true },
    },
    async (args) => noteCall(args as NoteInput),
  );

  // ── shemma_layout ───────────────────────────────────────────────────────────
  async function layoutCall(input: LayoutInput): Promise<ToolResult> {
    const { room, space, clientOpId, dryRun, layoutHint, mode, scope, spacing } = input;
    const action: Record<string, unknown> = { kind: "layout" };
    if (mode !== undefined) action.mode = mode;
    if (scope !== undefined) action.scope = scope;
    if (spacing !== undefined) action.spacing = spacing;
    return runActions(deps, room, [action], { space, clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_layout",
    {
      description: "Trigger an automatic layout pass on the canvas.",
      inputSchema: LayoutArgs,
    },
    async (args) => layoutCall(args as LayoutInput),
  );

  // ── shemma_delete ───────────────────────────────────────────────────────────
  async function deleteCall(input: DeleteInput): Promise<ToolResult> {
    const { room, space, clientOpId, dryRun, layoutHint, ids, cascade } = input;
    const action: Record<string, unknown> = { kind: "delete", ids };
    if (cascade !== undefined) action.cascade = cascade;
    return runActions(deps, room, [action], { space, clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_delete",
    {
      description:
        "Delete elements by id. Use cascade:true to remove dependent edges. " +
        "This is the v1 domain path (resolves by element name). It does NOT delete " +
        "v2 schema-frames or shapes managed by them: to delete a whole schema-frame " +
        "use shemma_delete_schema(frameId); to delete a node inside a schema-frame use " +
        "shemma_patch_schema with a schema-delete-node action.",
      inputSchema: DeleteArgs,
      annotations: { destructiveHint: true },
    },
    async (args) => deleteCall(args as DeleteInput),
  );

  // ── shemma_apply ────────────────────────────────────────────────────────────
  async function applyCall(input: ApplyInput): Promise<ToolResult> {
    const { room, space, clientOpId, dryRun, layoutHint, actions } = input;
    return runActions(deps, room, actions, { space, clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_apply",
    {
      description:
        "Apply a batch of domain actions atomically. Each entry is `{ kind, …fields }`; " +
        "`kind` ∈ define | connect | group | note | layout | delete.\n\n" +
        "Fields per kind (required unless marked ?):\n" +
        "- define  { role, name, label?, in? } — create/upsert an element. role ∈ actor|service|datastore|queue|external|note. `in` = container name to nest into.\n" +
        "- connect { from, to, connectionKind?, label? } — directed edge between element names. connectionKind ∈ sync|async|data|dep.\n" +
        "- group   { children:[name,…], as, name, label? } — container around members. MEMBERS GO IN `children` (NOT `ids` — that mismatch is a common error). as ∈ network|boundary.\n" +
        "- note    { text, about?, name? } — sticky note; `about` = element name it annotates.\n" +
        "- layout  { mode?, scope?, spacing? } — explicit re-layout. mode ∈ layered-lr|layered-tb|tree|pack|force.\n" +
        "- delete  { ids:[name,…], cascade? }  (or { id }) — destructive; cascade:true also drops dependent edges.\n\n" +
        "Names are stable human ids ('api-gateway'); `define` is idempotent on name. Forward refs are OK within one batch (define a name, then connect/group by it in a later entry).\n\n" +
        "Example:\n" +
        '{ "actions": [\n' +
        '  { "kind": "define", "role": "service", "name": "api", "label": "API" },\n' +
        '  { "kind": "define", "role": "datastore", "name": "db" },\n' +
        '  { "kind": "connect", "from": "api", "to": "db", "connectionKind": "data" },\n' +
        '  { "kind": "group", "children": ["api", "db"], "as": "boundary", "name": "backend" }\n' +
        "] }\n\n" +
        "Label semantics (verified): multi-line labels are supported — a `\\n` in `label`/`text` renders as a hard line break (white-space: pre-wrap). Emoji, including variation-selector (️) and supplementary-plane (🚀) codepoints, are safe and pass through intact.\n\n" +
        "Full reference: `shemma://workflow/draw-architecture` (or `shemma_get_instructions { topic: \"draw-architecture\" }`). For v2 schema-frames edit object-wise via `shemma_patch_schema` instead.",
      inputSchema: ApplyArgs,
    },
    async (args) => applyCall(args as ApplyInput),
  );

  // ── shemma_layout_selection ────────────────────────────────────────────────
  // DRW-088: selection-aware ELK layout. Tidy only the provided shapes,
  // leaving the rest of the canvas untouched (pinned shapes never move).
  // AC#7: пустой ids → full-canvas noop (endpoint returns count:0 + hint).
  async function layoutSelectionCall(input: LayoutSelectionInput): Promise<ToolResult> {
    const { room: argRoom, space: argSpace, ids, mode, spacing } = input;
    const spaceRes = resolveSpaceOrError(deps, argSpace);
    if ("error" in spaceRes) return spaceRes.error;

    const resolved = await deps.resolver.resolve({ argRoom });
    if (!resolved.ok) {
      return toolResult({
        ok: false,
        code: "ambiguous-room",
        message: resolved.message,
        details: { candidates: resolved.candidates },
      });
    }

    try {
      const c = new CanvasClient({
        baseUrl: deps.client.baseUrl,
        room: resolved.room,
        space: spaceRes.spaceId,
      });
      const resp = (await c.layoutSelection({
        ids: ids ?? [],
        mode,
        spacing,
      })) as {
        ok?: boolean;
        version?: number;
        count?: number;
        hint?: string;
        affected?: string[];
        unresolved?: string[];
        error?: string;
      };

      if (resp.ok) {
        deps.resolver.recordTouch(resolved.room);
        return toolResult({
          ok: true,
          room: resolved.room,
          roomSource: resolved.source,
          version: resp.version,
          count: resp.count ?? 0,
          hint: resp.hint,
          affected: resp.affected ?? [],
          unresolved: resp.unresolved,
        });
      }

      return toolResult({
        ok: false,
        code: "layout-failed",
        message: resp.error ?? "layout-selection failed",
        details: { room: resolved.room },
      });
    } catch (e) {
      return toolResult({ ...mapFetchError(e) });
    }
  }

  server.registerTool(
    "shemma_layout_selection",
    {
      description:
        "Tidy layout of the selected shapes only. Use after `shemma_import_mermaid` to clean up just-added group, OR after manual edits to a specific zone. Pinned shapes (`meta.pinned===true`) won't move. Empty `ids` = full-canvas noop (returns count:0 with hint). For full-canvas layout use `shemma_layout` instead.\n\nTip: after `shemma_import_mermaid`, pass `root_ids` from the import response as `ids` to tidy only the new diagram without disrupting existing shapes.",
      inputSchema: LayoutSelectionArgs,
    },
    async (args) => layoutSelectionCall(args as LayoutSelectionInput),
  );

  // ── shemma_import_mermaid ───────────────────────────────────────────────────
  // DRW-127: mode param added — "browser" (default, backward-compat), "storage"
  // (POST /api/schema/create, no WS required), "auto" (storage first, browser fallback).

  /** Extract a human-readable label from the first line of a Mermaid diagram.
   *  E.g. "graph LR\n  %% My Diagram\n  ..." → "My Diagram".
   *  Falls back to "Imported schema" when no suitable label found. */
  function extractMermaidLabel(source: string): string {
    for (const line of source.split("\n")) {
      const trimmed = line.trim();
      // Comment lines: %% Label text
      if (trimmed.startsWith("%%")) {
        const label = trimmed.slice(2).trim();
        if (label.length > 0) return label;
      }
      // Named diagram: graph LR "My Diagram" or flowchart TB "Title"
      const titleMatch = trimmed.match(/^(?:graph|flowchart)\s+\S+\s+"(.+)"/i);
      if (titleMatch) return titleMatch[1];
    }
    return "Imported schema";
  }

  async function importMermaidStoragePath(
    c: CanvasClient,
    source: string,
    clientOpId: string | undefined,
    resolved: { room: string; source: string },
  ): Promise<ToolResult | null> {
    const label = extractMermaidLabel(source);
    const clientOpIdFinal = clientOpId ?? crypto.randomUUID();
    const resp = (await c.createSchema({
      label,
      raw: source,
      clientOpId: clientOpIdFinal,
    })) as {
      ok?: boolean;
      frameId?: string;
      nodeIds?: string[];
      version?: number;
      upgradedToV2?: boolean;
      errors?: Array<{ code?: string; message?: string }>;
    };

    if (resp.ok) {
      deps.resolver.recordTouch(resolved.room);
      return toolResult({
        ok: true,
        room: resolved.room,
        roomSource: resolved.source,
        version: resp.version,
        clientOpId: clientOpIdFinal,
        // Normalise to importMermaid-compatible envelope so callers can treat
        // both modes identically. frameId + nodeIds are storage-specific extras.
        shape_ids: resp.nodeIds ?? [],
        didraw_names: resp.nodeIds ?? [],
        root_ids: resp.frameId ? [resp.frameId] : [],
        frameId: resp.frameId,
        nodeIds: resp.nodeIds ?? [],
        upgradedToV2: resp.upgradedToV2 ?? false,
        // DRW-226: surface the irreversible v1→v2 transition on first storage import.
        ...(resp.upgradedToV2
          ? {
              notice:
                "Room upgraded v1→v2 (irreversible). Storage imports now use the reduced Mermaid parser; for full Mermaid use mode:\"browser\" with an open browser tab. Delete frames via shemma_delete_schema, nodes via shemma_patch_schema(schema-delete-node).",
            }
          : {}),
      });
    }

    const firstError = Array.isArray(resp.errors) && resp.errors.length > 0
      ? (resp.errors[0] as { code?: string; message?: string })
      : undefined;
    // Return null to signal caller to try browser fallback (used in "auto" mode).
    // Returning null means "storage failed, try next path".
    return toolResult({
      ok: false,
      code: "import-failed",
      message: firstError?.message ?? firstError?.code ?? "storage import failed",
      clientOpId: clientOpIdFinal,
      details: { room: resolved.room, errors: resp.errors },
    });
  }

  async function importMermaidCall(input: ImportMermaidInput): Promise<ToolResult> {
    const { room: argRoom, space: argSpace, clientOpId, source, focus, mode } = input;
    const effectiveMode = mode ?? "browser";

    const spaceRes = resolveSpaceOrError(deps, argSpace);
    if ("error" in spaceRes) return spaceRes.error;

    const resolved = await deps.resolver.resolve({ argRoom });
    if (!resolved.ok) {
      return toolResult({
        ok: false,
        code: "ambiguous-room",
        message: resolved.message,
        details: { candidates: resolved.candidates },
      });
    }

    const c = new CanvasClient({
      baseUrl: deps.client.baseUrl,
      room: resolved.room,
      space: spaceRes.spaceId,
    });

    // ── storage mode ──────────────────────────────────────────────────────────
    if (effectiveMode === "storage") {
      try {
        return await importMermaidStoragePath(c, source, clientOpId, resolved) ??
          toolResult({ ok: false, code: "import-failed", message: "storage import returned null" });
      } catch (e) {
        return toolResult({ ...mapFetchError(e) });
      }
    }

    // ── auto mode: try storage first, then browser ────────────────────────────
    if (effectiveMode === "auto") {
      try {
        const storageResult = await importMermaidStoragePath(c, source, clientOpId, resolved);
        // Storage success → done.
        if (storageResult && (storageResult.structuredContent as { ok?: boolean }).ok) {
          return storageResult;
        }
        // Storage failed → fall through to browser path.
      } catch {
        // Storage threw → fall through to browser path.
      }
      // Fall through to browser path below.
    }

    // ── browser mode (default) ────────────────────────────────────────────────
    try {
      const resp = (await c.importMermaid({
        source,
        clientOpId,
        focus,
      })) as {
        ok?: boolean;
        shape_ids?: string[];
        didraw_names?: string[];
        root_ids?: string[];
        error?: string;
        room_url?: string;
      };

      if (resp.ok) {
        deps.resolver.recordTouch(resolved.room);
        return toolResult({
          ok: true,
          room: resolved.room,
          roomSource: resolved.source,
          shape_ids: resp.shape_ids ?? [],
          didraw_names: resp.didraw_names ?? [],
          root_ids: resp.root_ids ?? [],
        });
      }

      // 503 "no client connected" path: backend ships `room_url` so AI can
      // open the tab and retry. Surface it both in the structured message
      // (so AI can read the URL from the text content) and in details.
      if (resp.room_url) {
        return toolResult({
          ok: false,
          code: "no-client-connected",
          message: `${resp.error ?? "no client connected"}. Open ${resp.room_url} in a browser, then retry.`,
          details: { room: resolved.room, room_url: resp.room_url },
        });
      }

      return toolResult({
        ok: false,
        code: "import-failed",
        message: resp.error ?? "import failed",
        details: { room: resolved.room },
      });
    } catch (e) {
      return toolResult({ ...mapFetchError(e) });
    }
  }

  server.registerTool(
    "shemma_import_mermaid",
    {
      description:
        "Imports a Mermaid diagram into the canvas room. APPEND-only — never replaces or deletes existing shapes; preserves user's manual layout edits.\n\n" +
        "**mode param (DRW-127):**\n" +
        "- `\"browser\"` (default) — WS-based flow via /api/agent/import-mermaid. Requires an open browser tab with an active WebSocket subscriber. Backward-compatible default.\n" +
        "- `\"storage\"` — direct storage write via POST /api/schema/create (no WS required). Room auto-upgrades to v2 on first call (irreversible — response carries `upgradedToV2`). Returns `frameId` + `nodeIds` in addition to standard envelope. Uses a REDUCED Mermaid parser: flowchart/graph headers, subgraphs, node declarations, edges (incl. `|labels|`), and style/classDef lines (skipped) — but NOT every construct (e.g. inline `:::class` shorthand). For full Mermaid use `\"browser\"`. Fails with `import-failed` for unsupported diagram types (use browser mode as fallback).\n" +
        "- `\"auto\"` — tries storage first; on storage error falls back to browser. Best-effort: use when WS availability is unknown.\n\n" +
        "Before calling: invoke `shemma_context` first to inspect existing element didraw_names — Mermaid node ids that collide with existing names will be auto-deduplicated (e.g. \"api-2\"), so avoid emitting Mermaid labels that already exist as nodes.\n\n" +
        "Returns: shape_ids, didraw_names, root_ids — usable for follow-up shemma_connect / shemma_group. Storage mode also returns frameId, nodeIds.\n\n" +
        "Troubleshooting:\n" +
        "- no-client-connected (browser/auto mode): \"Open browser tab\" is necessary but NOT sufficient — the page must establish a WebSocket subscription. Verify via `shemma_active_rooms` (must list the target room with clientCount > 0). After hard-reload the WS reconnects in ~100-500ms; if `active_rooms` stays empty for >2s the bundle is stale — close and reopen the tab through `shemma_open`. Retry with `mode:\"storage\"` if WS unavailable.\n" +
        "- unsupported-diagram-type (storage mode): non-flowchart diagrams (sequence, class, etc.) are not supported in storage mode. Retry with `mode:\"browser\"` if a WS client is connected.\n" +
        "- Alternative path (no MCP needed): in browser DevTools console, run `await window.shemmaImportMermaid('graph LR\\n  app --> db')`. This is the same code-path the WS command triggers and works regardless of MCP connectivity.\n" +
        "- Append-only accumulation: repeated imports of similar mermaid produce duplicate shapes + edges. Inspect via `shemma_context` first; consider `shemma_delete` on prior import root_ids before re-importing.\n" +
        "- Space errors (invalid_space_id / space_not_found / space_required): pass `space=<id>` matching `shemma_rooms_list`-known spaces, or omit if `default` space is registered.",
      inputSchema: ImportMermaidArgs,
    },
    async (args) => importMermaidCall(args as ImportMermaidInput),
  );

  return {
    define: { call: defineCall },
    connect: { call: connectCall },
    group: { call: groupCall },
    note: { call: noteCall },
    layout: { call: layoutCall },
    layoutSelection: { call: layoutSelectionCall },
    delete: { call: deleteCall },
    apply: { call: applyCall },
    importMermaid: { call: importMermaidCall },
  };
}
