import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { mapFetchError, toolResult, type ToolResult } from "../errors";
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
    return toolResult({
      ok: false,
      code: "validation-error",
      message: "domain action rejected",
      clientOpId,
      details: { errors: resp.errors },
    });
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
      description: "Delete elements by id. Use cascade:true to remove dependent edges.",
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
      description: "Apply an arbitrary batch of domain actions in a single atomic operation.",
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
  // Append-only. The MCP layer never sends a mode flag — wiping the canvas is
  // a separate explicit action that requires user confirmation.
  async function importMermaidCall(input: ImportMermaidInput): Promise<ToolResult> {
    const { room: argRoom, space: argSpace, clientOpId, source, focus } = input;
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
        "Imports a Mermaid diagram into the canvas room. APPEND-only — never replaces or deletes existing shapes; preserves user's manual layout edits.\n\nBefore calling: invoke `shemma_context` first to inspect existing element didraw_names — Mermaid node ids that collide with existing names will be auto-deduplicated (e.g. \"api-2\"), so avoid emitting Mermaid labels that already exist as nodes.\n\nRequires an open browser tab on the same room. On 503 \"no client connected\", caller should open the returned room_url (e.g. via a browser/devtools tool) and retry once.\n\nReturns: shape_ids, didraw_names, root_ids — usable for follow-up shemma_connect / shemma_group.",
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
