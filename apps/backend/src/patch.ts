import type { CanvasState, Edge, Group, Node, PatchOp } from "./types";

export type ApplyResult =
  | { ok: true; state: CanvasState }
  | { ok: false; state: CanvasState; error: string };

export function applyPatch(state: CanvasState, ops: PatchOp[]): ApplyResult {
  let next: CanvasState = {
    version: state.version,
    nodes: [...state.nodes],
    edges: [...state.edges],
    groups: [...state.groups],
  };
  for (const op of ops) {
    const r = applyOne(next, op);
    if (!r.ok) return { ok: false, state, error: r.error };
    next = r.state;
  }
  return { ok: true, state: next };
}

function applyOne(s: CanvasState, op: PatchOp): ApplyResult {
  if (op.op === "add") return addOp(s, op);
  if (op.op === "update") return updateOp(s, op);
  return deleteOp(s, op);
}

function addOp(
  s: CanvasState,
  op: Extract<PatchOp, { op: "add" }>,
): ApplyResult {
  if (op.target === "node") {
    if (s.nodes.some((n) => n.id === op.value.id))
      return { ok: false, state: s, error: `node ${op.value.id} exists` };
    return { ok: true, state: { ...s, nodes: [...s.nodes, op.value] } };
  }
  if (op.target === "edge") {
    if (s.edges.some((e) => e.id === op.value.id))
      return { ok: false, state: s, error: `edge ${op.value.id} exists` };
    const err =
      checkEndpoint(s, op.value.from, "from") ??
      checkEndpoint(s, op.value.to, "to");
    if (err) return { ok: false, state: s, error: err };
    return { ok: true, state: { ...s, edges: [...s.edges, op.value] } };
  }
  if (op.target === "group") {
    if (s.groups.some((g) => g.id === op.value.id))
      return { ok: false, state: s, error: `group ${op.value.id} exists` };
    return { ok: true, state: { ...s, groups: [...s.groups, op.value] } };
  }
  return { ok: false, state: s, error: "unknown add target" };
}

function checkEndpoint(
  s: CanvasState,
  ep: Edge["from"],
  side: string,
): string | null {
  if (ep.kind === "node" && !s.nodes.some((n) => n.id === ep.id))
    return `edge.${side} references unknown node ${ep.id}`;
  return null;
}

function updateOp(
  s: CanvasState,
  op: Extract<PatchOp, { op: "update" }>,
): ApplyResult {
  if (op.target === "node") {
    const idx = s.nodes.findIndex((n) => n.id === op.id);
    if (idx === -1)
      return { ok: false, state: s, error: `node ${op.id} not found` };
    const merged = mergeRecord(s.nodes[idx], op.set, ["style", "meta"]) as Node;
    const nodes = [...s.nodes];
    nodes[idx] = merged;
    return { ok: true, state: { ...s, nodes } };
  }
  if (op.target === "edge") {
    const idx = s.edges.findIndex((e) => e.id === op.id);
    if (idx === -1)
      return { ok: false, state: s, error: `edge ${op.id} not found` };
    const merged = mergeRecord(s.edges[idx], op.set, ["style", "meta"]) as Edge;
    const err =
      checkEndpoint(s, merged.from, "from") ??
      checkEndpoint(s, merged.to, "to");
    if (err) return { ok: false, state: s, error: err };
    const edges = [...s.edges];
    edges[idx] = merged;
    return { ok: true, state: { ...s, edges } };
  }
  if (op.target === "group") {
    const idx = s.groups.findIndex((g) => g.id === op.id);
    if (idx === -1)
      return { ok: false, state: s, error: `group ${op.id} not found` };
    const merged = mergeRecord(s.groups[idx], op.set, ["style"]) as Group;
    const groups = [...s.groups];
    groups[idx] = merged;
    return { ok: true, state: { ...s, groups } };
  }
  return { ok: false, state: s, error: "unknown update target" };
}

function deleteOp(
  s: CanvasState,
  op: Extract<PatchOp, { op: "delete" }>,
): ApplyResult {
  if (op.target === "node") {
    // cascade: убрать edges, ссылающиеся на node; убрать id из всех group.children
    const endpointRefsNode = (ep: Edge["from"], nodeId: string): boolean =>
      ep.kind === "node" && ep.id === nodeId;
    return {
      ok: true,
      state: {
        ...s,
        nodes: s.nodes.filter((n) => n.id !== op.id),
        edges: s.edges.filter(
          (e) =>
            !endpointRefsNode(e.from, op.id) && !endpointRefsNode(e.to, op.id),
        ),
        groups: s.groups.map((g) =>
          g.children.includes(op.id)
            ? { ...g, children: g.children.filter((c) => c !== op.id) }
            : g,
        ),
      },
    };
  }
  if (op.target === "edge") {
    return {
      ok: true,
      state: { ...s, edges: s.edges.filter((e) => e.id !== op.id) },
    };
  }
  if (op.target === "group") {
    // group удаляется; её дети-ноды/edges остаются плавающими, но id самой группы
    // надо вычистить из children любых других групп, чтобы не оставлять висячую ссылку.
    return {
      ok: true,
      state: {
        ...s,
        groups: s.groups
          .filter((g) => g.id !== op.id)
          .map((g) =>
            g.children.includes(op.id)
              ? { ...g, children: g.children.filter((c) => c !== op.id) }
              : g,
          ),
      },
    };
  }
  return { ok: false, state: s, error: "unknown delete target" };
}

function mergeRecord<T extends Record<string, unknown>>(
  base: T,
  patch: Partial<T>,
  deepKeys: (keyof T)[],
): T {
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(patch) as (keyof T)[]) {
    // Identity is immutable: never let an update rebrand a record's id.
    if (k === "id") continue;
    const v = patch[k];
    if (deepKeys.includes(k) && isObject(v) && isObject(base[k])) {
      const sub: Record<string, unknown> = {
        ...(base[k] as Record<string, unknown>),
      };
      for (const sk of Object.keys(v as object)) {
        const sv = (v as Record<string, unknown>)[sk];
        if (sv === undefined) delete sub[sk];
        else sub[sk] = sv;
      }
      out[k as string] = sub;
    } else {
      out[k as string] = v;
    }
  }
  return out as T;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
