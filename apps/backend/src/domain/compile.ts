import { connectionPreset, rolePreset, type Role } from "@didraw/domain";
import type { CanvasState, Edge, Group, Node, NodeStyle, PatchOp } from "../types";
import type { DomainAction, ElementId } from "./types";

export function nameToShapeId(name: string): string {
  // Phase 2.1 §3.5: deterministic shape:e_<slug(name)>.
  return `shape:e_${name}`;
}

type WorkingCanvas = {
  nodes: Map<string, Node>;
  groups: Map<string, Group>;
  edges: Map<string, Edge>;
};

function snapshotCanvas(c: CanvasState): WorkingCanvas {
  return {
    nodes: new Map(c.nodes.map((n) => [n.id, n])),
    groups: new Map(c.groups.map((g) => [g.id, g])),
    edges: new Map(c.edges.map((e) => [e.id, e])),
  };
}

function findNodeByName(c: WorkingCanvas, name: string): Node | undefined {
  for (const n of c.nodes.values()) if (n.meta?.name === name) return n;
  return undefined;
}

function findGroupByName(c: WorkingCanvas, name: string): Group | undefined {
  for (const g of c.groups.values()) {
    const nm = (g as { meta?: { name?: string } }).meta?.name;
    if (nm === name || g.label === name) return g;
  }
  return undefined;
}

function findContainerOf(c: WorkingCanvas, shapeId: string): Group | undefined {
  for (const g of c.groups.values()) {
    if (g.children.includes(shapeId)) return g;
  }
  return undefined;
}

function nextEdgeId(c: WorkingCanvas): string {
  let n = c.edges.size;
  while (c.edges.has(`shape:c_${n}`)) n++;
  return `shape:c_${n}`;
}

function nextNoteName(wc: WorkingCanvas): string {
  let n = wc.nodes.size;
  while (wc.nodes.has(nameToShapeId(`note-${n}`))) n++;
  return `note-${n}`;
}

export function compile(
  actions: DomainAction[],
  canvas: CanvasState,
): { ops: PatchOp[]; elementIds: (ElementId | undefined)[] } {
  const ops: PatchOp[] = [];
  const elementIds: (ElementId | undefined)[] = [];
  const wc = snapshotCanvas(canvas);

  for (const a of actions) {
    switch (a.kind) {
      case "define": {
        const sid = nameToShapeId(a.name);
        const existing = wc.nodes.get(sid);
        const preset = rolePreset(a.role as Role);
        if (existing) {
          // Upsert: don't clobber pinned/position/styleOwnedBy; only update label/meta safe fields.
          const set: Partial<Node> = {};
          if (a.label !== undefined) set.label = a.label;
          // Build new meta without touching user-owned fields (pinned, position, styleOwnedBy).
          const existingMeta = existing.meta ?? {};
          const { pinned, position, styleOwnedBy, ...restMeta } = existingMeta as {
            pinned?: unknown;
            position?: unknown;
            styleOwnedBy?: unknown;
            [key: string]: unknown;
          };
          set.meta = { ...restMeta, name: a.name, role: a.role, ...(a.meta ?? {}) };
          ops.push({ op: "update", target: "node", id: sid, set });
          wc.nodes.set(sid, { ...existing, ...set, meta: set.meta });
          elementIds.push(a.name);
          // Move between containers if `in` changed.
          if (a.in !== undefined) {
            const newContainer = findGroupByName(wc, a.in);
            const oldContainer = findContainerOf(wc, sid);
            if (oldContainer && oldContainer !== newContainer) {
              const oldKids = oldContainer.children.filter((c) => c !== sid);
              ops.push({ op: "update", target: "group", id: oldContainer.id, set: { children: oldKids } });
              wc.groups.set(oldContainer.id, { ...oldContainer, children: oldKids });
            }
            if (newContainer && (!oldContainer || oldContainer.id !== newContainer.id)) {
              const newKids = [...newContainer.children, sid];
              ops.push({ op: "update", target: "group", id: newContainer.id, set: { children: newKids } });
              wc.groups.set(newContainer.id, { ...newContainer, children: newKids });
            }
          }
        } else {
          // Map "frame" kind (container roles) to "rect" — Node.kind doesn't include "frame".
          const nodeKind = preset.kind === "frame" ? "rect" : preset.kind;
          const node: Node = {
            id: sid,
            kind: nodeKind,
            x: 0,
            y: 0,
            w: preset.defaultW,
            h: preset.defaultH,
            label: a.label ?? a.name,
            style: preset.style as NodeStyle,
            meta: { name: a.name, role: a.role, ...(a.meta ?? {}) },
          };
          ops.push({ op: "add", target: "node", value: node });
          wc.nodes.set(sid, node);
          if (a.in !== undefined) {
            const g = findGroupByName(wc, a.in);
            if (g) {
              const kids = [...g.children, sid];
              ops.push({ op: "update", target: "group", id: g.id, set: { children: kids } });
              wc.groups.set(g.id, { ...g, children: kids });
            }
          }
          elementIds.push(a.name);
        }
        break;
      }
      case "connect": {
        const fromN = findNodeByName(wc, a.from);
        const toN = findNodeByName(wc, a.to);
        // validate.ts must catch missing refs before compile reaches this point.
        // If we got here with a missing endpoint, it's a bug — fail loud, not silent.
        if (!fromN) throw new Error(`compile: connect.from "${a.from}" not found (validate did not catch)`);
        if (!toN) throw new Error(`compile: connect.to "${a.to}" not found (validate did not catch)`);
        const ck = a.connectionKind ?? "sync";
        const preset = connectionPreset(ck);
        const eid = nextEdgeId(wc);
        const edge: Edge = {
          id: eid,
          from: { kind: "node", id: fromN.id },
          to: { kind: "node", id: toN.id },
          label: a.label ?? preset.defaultLabel,
          style: { dashed: preset.dashed, arrow: preset.arrow },
          meta: { kind: ck, ...(a.meta ?? {}) },
        };
        ops.push({ op: "add", target: "edge", value: edge });
        wc.edges.set(eid, edge);
        elementIds.push(eid);
        break;
      }
      case "group": {
        const gid = nameToShapeId(a.name);
        const childIds = a.ids.map((nm) => {
          const node = findNodeByName(wc, nm);
          return node ? node.id : nameToShapeId(nm);
        });
        const preset = rolePreset(a.as as Role);
        const grp: Group = {
          id: gid,
          kind: "frame",
          children: childIds,
          label: a.label ?? a.name,
          style: { fill: preset.style.fill, stroke: preset.style.stroke },
        };
        // Store role/name in group meta (extend Group with meta field via cast since type doesn't include it).
        (grp as { meta?: Record<string, unknown> }).meta = { name: a.name, role: a.as };
        ops.push({ op: "add", target: "group", value: grp });
        wc.groups.set(gid, grp);
        elementIds.push(a.name);
        break;
      }
      case "note": {
        const name = a.name ?? nextNoteName(wc);
        const sid = nameToShapeId(name);
        const preset = rolePreset("note");
        const node: Node = {
          id: sid,
          kind: "sticky",
          x: 0,
          y: 0,
          w: preset.defaultW,
          h: preset.defaultH,
          label: a.text,
          style: preset.style as NodeStyle,
          meta: { name, role: "note" },
        };
        ops.push({ op: "add", target: "node", value: node });
        wc.nodes.set(sid, node);
        if (a.about) {
          const target = findNodeByName(wc, a.about);
          if (target) {
            const eid = nextEdgeId(wc);
            const edge: Edge = {
              id: eid,
              from: { kind: "node", id: sid },
              to: { kind: "node", id: target.id },
              style: { dashed: true, arrow: "to" },
              meta: { kind: "dep", noteBinding: true },
            };
            ops.push({ op: "add", target: "edge", value: edge });
            wc.edges.set(eid, edge);
          }
        }
        elementIds.push(name);
        break;
      }
      case "layout":
        // No PatchOps from layout action itself — orchestrator runs ELK in routes/domain.ts.
        elementIds.push(undefined);
        break;
      case "delete": {
        const ids = "ids" in a ? a.ids : [a.id];
        for (const nm of ids) {
          const node = findNodeByName(wc, nm);
          if (node) {
            ops.push({ op: "delete", target: "node", id: node.id });
            wc.nodes.delete(node.id);
            continue;
          }
          const grp = findGroupByName(wc, nm);
          if (grp) {
            ops.push({ op: "delete", target: "group", id: grp.id });
            wc.groups.delete(grp.id);
          }
        }
        elementIds.push(undefined);
        break;
      }
    }
  }

  return { ops, elementIds };
}
