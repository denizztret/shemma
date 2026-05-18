import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { mapFetchError, toolResult, type ToolResult } from "../errors";
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

export type DomainDeps = {
  client: CanvasClient;
  resolver: RoomResolver;
  defaultRoom?: string;
  autoOpen?: AutoOpenManager;
};

type DefineInput = z.infer<z.ZodObject<typeof DefineArgs>>;
type ConnectInput = z.infer<z.ZodObject<typeof ConnectArgs>>;
type GroupInput = z.infer<z.ZodObject<typeof GroupArgs>>;
type NoteInput = z.infer<z.ZodObject<typeof NoteArgs>>;
type LayoutInput = z.infer<z.ZodObject<typeof LayoutArgs>>;
type DeleteInput = z.infer<z.ZodObject<typeof DeleteArgs>>;
type ApplyInput = z.infer<z.ZodObject<typeof ApplyArgs>>;

export type DomainHandles = {
  define: { call: (input: DefineInput) => Promise<ToolResult> };
  connect: { call: (input: ConnectInput) => Promise<ToolResult> };
  group: { call: (input: GroupInput) => Promise<ToolResult> };
  note: { call: (input: NoteInput) => Promise<ToolResult> };
  layout: { call: (input: LayoutInput) => Promise<ToolResult> };
  delete: { call: (input: DeleteInput) => Promise<ToolResult> };
  apply: { call: (input: ApplyInput) => Promise<ToolResult> };
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
    const { room, clientOpId, dryRun, layoutHint, name, role, label } = input;
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
    async (args) => defineCall(args as DefineInput),
  );

  // ── shemma_connect ──────────────────────────────────────────────────────────
  async function connectCall(input: ConnectInput): Promise<ToolResult> {
    const { room, clientOpId, dryRun, layoutHint, from, to, connectionKind, label } = input;
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
    async (args) => connectCall(args as ConnectInput),
  );

  // ── shemma_group ────────────────────────────────────────────────────────────
  async function groupCall(input: GroupInput): Promise<ToolResult> {
    const { room, clientOpId, dryRun, layoutHint, name, label, children } = input;
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
    async (args) => groupCall(args as GroupInput),
  );

  // ── shemma_note ─────────────────────────────────────────────────────────────
  async function noteCall(input: NoteInput): Promise<ToolResult> {
    const { room, clientOpId, dryRun, layoutHint, name, text } = input;
    return runActions(deps, room, [{ kind: "note", name, text }], { clientOpId, dryRun, layoutHint });
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
    const { room, clientOpId, dryRun, layoutHint, mode, scope, spacing } = input;
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
    async (args) => layoutCall(args as LayoutInput),
  );

  // ── shemma_delete ───────────────────────────────────────────────────────────
  async function deleteCall(input: DeleteInput): Promise<ToolResult> {
    const { room, clientOpId, dryRun, layoutHint, ids, cascade } = input;
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
    async (args) => deleteCall(args as DeleteInput),
  );

  // ── shemma_apply ────────────────────────────────────────────────────────────
  async function applyCall(input: ApplyInput): Promise<ToolResult> {
    const { room, clientOpId, dryRun, layoutHint, actions } = input;
    return runActions(deps, room, actions, { clientOpId, dryRun, layoutHint });
  }

  server.registerTool(
    "shemma_apply",
    {
      description: "Apply an arbitrary batch of domain actions in a single atomic operation.",
      inputSchema: ApplyArgs,
    },
    async (args) => applyCall(args as ApplyInput),
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
