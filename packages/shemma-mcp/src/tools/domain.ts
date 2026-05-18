import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { mapFetchError, toolResult } from "../errors";
import type { RoomResolver } from "../room-resolver";
import type { AutoOpenManager } from "../auto-open";
import {
  DefineArgs,
  ConnectArgs,
  GroupArgs,
  NoteArgs,
  LayoutArgs,
  DeleteArgs,
  ApplyArgs,
} from "../schemas";

export type ToolResult = ReturnType<typeof toolResult>;

export type DomainDeps = {
  client: CanvasClient;
  resolver: RoomResolver;
  defaultRoom?: string;
  autoOpen?: AutoOpenManager;
};

export type DomainHandles = {
  define: { call: (input: Record<string, unknown>) => Promise<ToolResult> };
  connect: { call: (input: Record<string, unknown>) => Promise<ToolResult> };
  group: { call: (input: Record<string, unknown>) => Promise<ToolResult> };
  note: { call: (input: Record<string, unknown>) => Promise<ToolResult> };
  layout: { call: (input: Record<string, unknown>) => Promise<ToolResult> };
  delete: { call: (input: Record<string, unknown>) => Promise<ToolResult> };
  apply: { call: (input: Record<string, unknown>) => Promise<ToolResult> };
};

type CommonArgs = {
  room?: string;
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
    const c = new CanvasClient({ baseUrl: deps.client.baseUrl, room: resolved.room });
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
          // Auto-open failures should never break the write — swallow silently.
          // notifyWrite errors are logged elsewhere (Task 20).
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
  async function defineCall(input: Record<string, unknown>): Promise<ToolResult> {
    const { room, clientOpId, dryRun, layoutHint, name, role, label } = input as {
      room?: string; clientOpId?: string; dryRun?: boolean; layoutHint?: unknown;
      name: string; role: string; label?: string;
    };
    const action: Record<string, unknown> = { kind: "define", name, role };
    if (label !== undefined) action.label = label;
    return runActions(deps, room, [action], { clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_define",
    {
      description: "Define (create or upsert) a named element with a role on the canvas.",
      inputSchema: DefineArgs,
      annotations: { idempotentHint: true },
    },
    async (args) => defineCall(args as Record<string, unknown>),
  );

  // ── shemma_connect ──────────────────────────────────────────────────────────
  async function connectCall(input: Record<string, unknown>): Promise<ToolResult> {
    const { room, clientOpId, dryRun, layoutHint, from, to, connectionKind, label } = input as {
      room?: string; clientOpId?: string; dryRun?: boolean; layoutHint?: unknown;
      from: string; to: string; connectionKind: string; label?: string;
    };
    const action: Record<string, unknown> = { kind: "connect", from, to, connectionKind };
    if (label !== undefined) action.label = label;
    return runActions(deps, room, [action], { clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_connect",
    {
      description: "Connect two elements with a directed edge of a given connectionKind.",
      inputSchema: ConnectArgs,
      annotations: { idempotentHint: true },
    },
    async (args) => connectCall(args as Record<string, unknown>),
  );

  // ── shemma_group ────────────────────────────────────────────────────────────
  async function groupCall(input: Record<string, unknown>): Promise<ToolResult> {
    const { room, clientOpId, dryRun, layoutHint, name, label, children } = input as {
      room?: string; clientOpId?: string; dryRun?: boolean; layoutHint?: unknown;
      name: string; label?: string; children: string[];
    };
    const action: Record<string, unknown> = { kind: "group", name, children };
    if (label !== undefined) action.label = label;
    return runActions(deps, room, [action], { clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_group",
    {
      description: "Create or update a group containing specified child elements.",
      inputSchema: GroupArgs,
      annotations: { idempotentHint: true },
    },
    async (args) => groupCall(args as Record<string, unknown>),
  );

  // ── shemma_note ─────────────────────────────────────────────────────────────
  async function noteCall(input: Record<string, unknown>): Promise<ToolResult> {
    const { room, clientOpId, dryRun, layoutHint, name, text } = input as {
      room?: string; clientOpId?: string; dryRun?: boolean; layoutHint?: unknown;
      name: string; text: string;
    };
    return runActions(deps, room, [{ kind: "note", name, text }], { clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_note",
    {
      description: "Place or update a free-form text note on the canvas.",
      inputSchema: NoteArgs,
      annotations: { idempotentHint: true },
    },
    async (args) => noteCall(args as Record<string, unknown>),
  );

  // ── shemma_layout ───────────────────────────────────────────────────────────
  async function layoutCall(input: Record<string, unknown>): Promise<ToolResult> {
    const { room, clientOpId, dryRun, layoutHint, mode, scope, spacing } = input as {
      room?: string; clientOpId?: string; dryRun?: boolean; layoutHint?: unknown;
      mode?: string; scope?: string; spacing?: string;
    };
    const action: Record<string, unknown> = { kind: "layout" };
    if (mode !== undefined) action.mode = mode;
    if (scope !== undefined) action.scope = scope;
    if (spacing !== undefined) action.spacing = spacing;
    return runActions(deps, room, [action], { clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_layout",
    {
      description: "Trigger an automatic layout pass on the canvas.",
      inputSchema: LayoutArgs,
    },
    async (args) => layoutCall(args as Record<string, unknown>),
  );

  // ── shemma_delete ───────────────────────────────────────────────────────────
  async function deleteCall(input: Record<string, unknown>): Promise<ToolResult> {
    const { room, clientOpId, dryRun, layoutHint, ids, cascade } = input as {
      room?: string; clientOpId?: string; dryRun?: boolean; layoutHint?: unknown;
      ids: string[]; cascade?: boolean;
    };
    const action: Record<string, unknown> = { kind: "delete", ids };
    if (cascade !== undefined) action.cascade = cascade;
    return runActions(deps, room, [action], { clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_delete",
    {
      description: "Delete elements by id. Use cascade:true to remove dependent edges.",
      inputSchema: DeleteArgs,
      annotations: { destructiveHint: true },
    },
    async (args) => deleteCall(args as Record<string, unknown>),
  );

  // ── shemma_apply ────────────────────────────────────────────────────────────
  async function applyCall(input: Record<string, unknown>): Promise<ToolResult> {
    const { room, clientOpId, dryRun, layoutHint, actions } = input as {
      room?: string; clientOpId?: string; dryRun?: boolean; layoutHint?: unknown;
      actions: Array<Record<string, unknown>>;
    };
    return runActions(deps, room, actions, { clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_apply",
    {
      description: "Apply an arbitrary batch of domain actions in a single atomic operation.",
      inputSchema: ApplyArgs,
    },
    async (args) => applyCall(args as Record<string, unknown>),
  );

  return {
    define: { call: defineCall },
    connect: { call: connectCall },
    group: { call: groupCall },
    note: { call: noteCall },
    layout: { call: layoutCall },
    delete: { call: deleteCall },
    apply: { call: applyCall },
  };
}
