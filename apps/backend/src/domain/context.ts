import type { ConnectionKind, Role } from "@didraw/domain";
import type { CanvasState, Node, OpLogEntry, RoomState } from "../types";

export type Viewport = { x: number; y: number; w: number; h: number } | null;

export type ElementCompact = {
  id: string;
  role?: Role;
  label?: string;
  parent?: string;
  pinned?: true;
};

export type ConnectionCompact = {
  from: string;
  to: string;
  kind: ConnectionKind;
  label?: string;
};

export type OpSummary = {
  version: number;
  source: "ai" | "user";
  summary: string;
};

export type ContextResponse = {
  version: number;
  viewport: Viewport;
  summary: {
    total: number;
    byRole: Partial<Record<Role, number>>;
    topLevelGroups: Array<{ id: string; role: Role; label?: string }>;
  };
  inView: ElementCompact[];
  selection: ElementCompact[];
  connections: ConnectionCompact[];
  recentOps: OpSummary[];
  offscreenSummary: { byRole: Partial<Record<Role, number>> } | null;
  truncated?: true;
};

function inViewport(n: Node, vp: Exclude<Viewport, null>): boolean {
  const nx = n.x;
  const ny = n.y;
  const nw = n.w ?? 100;
  const nh = n.h ?? 50;
  return nx + nw >= vp.x && nx <= vp.x + vp.w && ny + nh >= vp.y && ny <= vp.y + vp.h;
}

function parentOf(canvas: CanvasState, nodeId: string): string | undefined {
  for (const g of canvas.groups) {
    if (g.children.includes(nodeId)) {
      const meta = (g as { meta?: { name?: string } }).meta;
      return meta?.name ?? g.label;
    }
  }
  return undefined;
}

function nodeToCompact(canvas: CanvasState, n: Node): ElementCompact {
  const out: ElementCompact = { id: (n.meta?.name as string) ?? n.id };
  const role = n.meta?.role as Role | undefined;
  if (role) out.role = role;
  if (n.label && n.label !== out.id) out.label = n.label;
  const p = parentOf(canvas, n.id);
  if (p) out.parent = p;
  if (n.meta?.pinned === true) out.pinned = true;
  return out;
}

function summarizeOp(e: OpLogEntry): string {
  const counts = { add: 0, update: 0, delete: 0 } as Record<string, number>;
  for (const op of e.ops) counts[op.op]++;
  const parts: string[] = [];
  if (counts.add) parts.push(`+${counts.add}`);
  if (counts.update) parts.push(`~${counts.update}`);
  if (counts.delete) parts.push(`-${counts.delete}`);
  return parts.join(" ");
}

export function buildContext(
  room: RoomState,
  opts: { viewport: Viewport; selection?: string[]; limit?: number; since?: number } = { viewport: null },
): ContextResponse {
  const canvas = room.canvas;
  const limit = opts.limit ?? 30;
  const vp = opts.viewport;
  const since = opts.since;

  // Build byRole counts from nodes and groups. Nodes/groups without meta.role
  // contribute to summary.total but are intentionally skipped here — see
  // [[phase-2-1-followups]] m2.
  const byRole: Partial<Record<Role, number>> = {};
  for (const n of canvas.nodes) {
    const r = n.meta?.role as Role | undefined;
    if (!r) continue;
    byRole[r] = (byRole[r] ?? 0) + 1;
  }
  for (const g of canvas.groups) {
    const r = (g as { meta?: { role?: Role } }).meta?.role;
    if (!r) continue;
    byRole[r] = (byRole[r] ?? 0) + 1;
  }

  const topLevelGroups = canvas.groups.map((g) => ({
    id: ((g as { meta?: { name?: string } }).meta?.name) ?? g.label ?? g.id,
    role: ((g as { meta?: { role?: Role } }).meta?.role) ?? "network",
    label: g.label,
  }));

  // Filter nodes by viewport
  const visible: Node[] = vp ? canvas.nodes.filter((n) => inViewport(n, vp)) : canvas.nodes;
  const inViewSliced = visible.slice(0, limit);

  // Build selection compacts
  const selectionSet = new Set(opts.selection ?? []);
  const selection = canvas.nodes
    .filter((n) => selectionSet.has(n.id) || (n.meta?.name && selectionSet.has(n.meta.name as string)))
    .map((n) => nodeToCompact(canvas, n));

  // Collect IDs visible in view (raw shape IDs for edge matching)
  const inViewShapeIds = new Set<string>(inViewSliced.map((n) => n.id));

  // Build connections — only for edges touching inView or selection nodes
  const selectionShapeIds = new Set(
    canvas.nodes
      .filter((n) => selectionSet.has(n.id) || (n.meta?.name && selectionSet.has(n.meta.name as string)))
      .map((n) => n.id),
  );
  const relevantShapeIds = new Set([...inViewShapeIds, ...selectionShapeIds]);

  const connections: ConnectionCompact[] = canvas.edges
    .filter((e) => e.from.kind === "node" && e.to.kind === "node")
    .filter((e) => {
      const fid = (e.from as { id: string }).id;
      const tid = (e.to as { id: string }).id;
      return relevantShapeIds.has(fid) || relevantShapeIds.has(tid);
    })
    .map((e) => {
      const fid = (e.from as { id: string }).id;
      const tid = (e.to as { id: string }).id;
      const fname = canvas.nodes.find((n) => n.id === fid)?.meta?.name as string | undefined;
      const tname = canvas.nodes.find((n) => n.id === tid)?.meta?.name as string | undefined;
      const k = (e.meta?.kind as ConnectionKind | undefined) ?? "sync";
      const out: ConnectionCompact = { from: fname ?? fid, to: tname ?? tid, kind: k };
      if (e.label) out.label = e.label;
      return out;
    });

  // Recent ops — filtered by since if provided
  const filteredOps = since !== undefined ? room.opLog.filter((e) => e.version > since) : room.opLog;
  const recentOps: OpSummary[] = filteredOps
    .slice(-20)
    .map((e) => ({ version: e.version, source: e.source, summary: summarizeOp(e) }));

  // Offscreen summary — only when viewport is set and some nodes are outside
  const offscreenSummary: ContextResponse["offscreenSummary"] = vp && visible.length < canvas.nodes.length
    ? (() => {
        const byR: Partial<Record<Role, number>> = {};
        for (const n of canvas.nodes) {
          if (inViewport(n, vp)) continue;
          const r = n.meta?.role as Role | undefined;
          if (!r) continue;
          byR[r] = (byR[r] ?? 0) + 1;
        }
        return { byRole: byR };
      })()
    : null;

  return {
    version: room.version,
    viewport: vp,
    summary: {
      total: canvas.nodes.length + canvas.groups.length,
      byRole,
      topLevelGroups,
    },
    inView: inViewSliced.map((n) => nodeToCompact(canvas, n)),
    selection,
    connections,
    recentOps,
    offscreenSummary,
    ...(visible.length > limit ? { truncated: true as const } : {}),
  };
}
