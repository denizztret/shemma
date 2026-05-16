import { modeToElkOptions, type LayoutMode, type Spacing } from "@didraw/domain";
import elkWorkerPath from "../../node_modules/elkjs/lib/elk-worker.min.js" with { type: "file" };
import type { CanvasState, Edge, Group, Node } from "../types";
import type { ElementId, LayoutHint } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: third-party CJS module
const ELK = require("elkjs/lib/main.js") as any;
// biome-ignore lint/suspicious/noExplicitAny: elk instance
const elk = new ELK({ workerUrl: elkWorkerPath }) as any;

type Side = "N" | "S" | "E" | "W";

export type EdgeRouting = {
  fromSide?: Side;
  toSide?: Side;
  bendPoints?: Array<{ x: number; y: number }>;
};

export type LayoutOk = {
  ok: true;
  positions: Record<string, { x: number; y: number; w?: number; h?: number }>;
  edgeRouting: Record<string, EdgeRouting>;
  affected: ElementId[];
};

export type LayoutFail = { ok: false; reason: string };

function isPinned(n: Node): boolean {
  return n.meta?.pinned === true;
}

function nodeChildrenOfGroup(c: CanvasState, gid: string): Node[] {
  const g = c.groups.find((x) => x.id === gid);
  if (!g) return [];
  return c.nodes.filter((n) => g.children.includes(n.id));
}

function topLevelNodes(c: CanvasState): Node[] {
  const groupedIds = new Set(c.groups.flatMap((g) => g.children));
  return c.nodes.filter((n) => !groupedIds.has(n.id));
}

function buildElkGraph(
  c: CanvasState,
  hint: Required<LayoutHint>,
  pinnedSet: Set<string>,
) {
  const opts = modeToElkOptions(hint.mode, hint.spacing);

  function buildGroupNode(g: Group): unknown {
    return {
      id: g.id,
      width: g.w ?? 400,
      height: g.h ?? 300,
      layoutOptions: { ...opts, "elk.padding": "[top=40,left=20,bottom=20,right=20]" },
      children: nodeChildrenOfGroup(c, g.id).map(buildLeafNode),
    };
  }

  function buildLeafNode(n: Node): unknown {
    return {
      id: n.id,
      width: Math.max(20, n.w ?? 120),
      height: Math.max(20, n.h ?? 60),
      ports: [],
    };
  }

  return {
    id: "root",
    // elk.hierarchyHandling: INCLUDE_CHILDREN — valid per ELK layered algorithm docs
    layoutOptions: { ...opts, "elk.hierarchyHandling": "INCLUDE_CHILDREN" },
    children: [
      ...topLevelNodes(c).map(buildLeafNode),
      ...c.groups.map(buildGroupNode),
    ],
    edges: c.edges
      .filter((e) => e.from.kind === "node" && e.to.kind === "node")
      .map((e) => ({
        id: e.id,
        sources: [(e.from as { id: string }).id],
        targets: [(e.to as { id: string }).id],
      })),
  };
}

export type AffectedSet = { affected: ElementId[] };

export async function runLayout(
  canvas: CanvasState,
  hint: LayoutHint,
  affectedSet?: AffectedSet,
): Promise<LayoutOk | LayoutFail> {
  const fullHint: Required<LayoutHint> = {
    mode: (hint.mode ?? "layered-lr") as LayoutMode,
    scope: hint.scope ?? "affected",
    spacing: (hint.spacing ?? "normal") as Spacing,
  };

  const pinnedSet = new Set<string>();
  // TODO: scope = ElementId (subgraph layout around a specific element) is not yet
  // implemented; non-"affected" / non-"all" strings silently fall through to "all".
  // Tracked for Phase 2.2 sync hardening.
  // In "affected" scope: all nodes NOT in the affected set are treated as pinned
  if (fullHint.scope === "affected" && affectedSet) {
    const affectedIds = new Set(affectedSet.affected);
    for (const n of canvas.nodes) {
      if (!affectedIds.has(n.id)) pinnedSet.add(n.id);
    }
  }
  // Explicitly pinned nodes (meta.pinned = true) are always fixed
  for (const n of canvas.nodes) {
    if (isPinned(n)) pinnedSet.add(n.id);
  }

  const graph = buildElkGraph(canvas, fullHint, pinnedSet);

  let res: { children?: unknown[]; edges?: unknown[] };
  try {
    res = await elk.layout(graph as never);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }

  const positions: LayoutOk["positions"] = {};
  const edgeRouting: LayoutOk["edgeRouting"] = {};
  const affected: ElementId[] = [];

  function collectChildren(children: unknown[] | undefined, offsetX = 0, offsetY = 0) {
    for (const ch of children ?? []) {
      const c = ch as {
        id?: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        children?: unknown[];
      };
      if (c.id == null) continue;
      const absX = (c.x ?? 0) + offsetX;
      const absY = (c.y ?? 0) + offsetY;
      positions[c.id] = { x: absX, y: absY, w: c.width, h: c.height };
      affected.push(c.id);
      collectChildren(c.children, absX, absY);
    }
  }

  collectChildren(res.children);

  // Post-process: restore pinned node coordinates from the input canvas.
  // ELK's layered algorithm does not support fixed-position nodes natively —
  // elk.position in layoutOptions is a hint for some algorithms but layered ignores it.
  // We apply pinned positions after layout so consumers see the correct coordinates.
  // (Deviation from plan: plan's elk.position + FIRST_SEPARATE combo does not preserve
  //  coordinates in elkjs 0.9.3; verified via runtime test.)
  for (const n of canvas.nodes) {
    if (pinnedSet.has(n.id) && positions[n.id] !== undefined) {
      positions[n.id] = { ...positions[n.id], x: n.x, y: n.y };
    }
  }

  // DRW-003: ELK layered не учитывает pinned positions при placement новых
  // (affected) nodes без edges к pinned — disconnected affected уезжает в (0,0)
  // и после snap'а пересекается с pinned, которые тоже были placed near origin.
  // Displace affected nodes которые overlap'ят с pinned bbox: ставим их справа
  // за pinned bbox с y-стэккингом, чтобы каждый занял свою строку.
  if (pinnedSet.size > 0) {
    const COLLISION_SLACK = 10;
    const NODE_SPACING_X = 40;
    const NODE_SPACING_Y = 20;
    const nodeBox = (id: string) => {
      const p = positions[id];
      if (!p) return null;
      const n = canvas.nodes.find((x) => x.id === id);
      return { x: p.x, y: p.y, w: n?.w ?? 120, h: n?.h ?? 60 };
    };
    const pinnedBoxes = [...pinnedSet]
      .map((id) => nodeBox(id))
      .filter((b): b is { x: number; y: number; w: number; h: number } => b !== null);
    if (pinnedBoxes.length > 0) {
      const pinnedRight = Math.max(...pinnedBoxes.map((b) => b.x + b.w));
      const pinnedTop = Math.min(...pinnedBoxes.map((b) => b.y));
      const overlapsAnyPinned = (b: { x: number; y: number; w: number; h: number }) =>
        pinnedBoxes.some(
          (pb) =>
            !(
              b.x + b.w + COLLISION_SLACK <= pb.x ||
              pb.x + pb.w + COLLISION_SLACK <= b.x ||
              b.y + b.h + COLLISION_SLACK <= pb.y ||
              pb.y + pb.h + COLLISION_SLACK <= b.y
            ),
        );
      // Affected = not in pinnedSet. Сортируем по id для детерминированной раскладки.
      const affectedIds = canvas.nodes
        .filter((n) => !pinnedSet.has(n.id))
        .map((n) => n.id)
        .sort();
      let nextY = pinnedTop;
      for (const aid of affectedIds) {
        const box = nodeBox(aid);
        if (!box) continue;
        if (!overlapsAnyPinned(box)) continue;
        // Сдвигаем affected node вправо за pinned bbox; y — стэк с верха pinned.
        positions[aid] = {
          ...positions[aid],
          x: pinnedRight + NODE_SPACING_X,
          y: nextY,
        };
        nextY += box.h + NODE_SPACING_Y;
      }
    }
  }

  function sideOf(box: { x: number; y: number; w: number; h: number }, p: { x: number; y: number }): Side {
    const left = Math.abs(p.x - box.x);
    const right = Math.abs(p.x - (box.x + box.w));
    const top = Math.abs(p.y - box.y);
    const bottom = Math.abs(p.y - (box.y + box.h));
    const min = Math.min(left, right, top, bottom);
    if (min === left) return "W";
    if (min === right) return "E";
    if (min === top) return "N";
    return "S";
  }

  const sizeFor = (id: string): { x: number; y: number; w: number; h: number } | null => {
    const p = positions[id];
    if (!p) return null;
    return { x: p.x, y: p.y, w: p.w ?? 100, h: p.h ?? 50 };
  };

  for (const e of (res.edges ?? []) as Array<{
    id?: string;
    sources?: string[];
    targets?: string[];
    sections?: Array<{
      startPoint: { x: number; y: number };
      endPoint: { x: number; y: number };
      bendPoints?: Array<{ x: number; y: number }>;
    }>;
  }>) {
    if (!e.id) continue;
    const seg = e.sections?.[0];
    if (!seg) continue;
    const r: EdgeRouting = {};
    const srcBox = e.sources?.[0] ? sizeFor(e.sources[0]) : null;
    const tgtBox = e.targets?.[0] ? sizeFor(e.targets[0]) : null;
    if (srcBox) r.fromSide = sideOf(srcBox, seg.startPoint);
    if (tgtBox) r.toSide = sideOf(tgtBox, seg.endPoint);
    if (seg.bendPoints && seg.bendPoints.length > 0) r.bendPoints = seg.bendPoints;
    edgeRouting[e.id] = r;
  }

  return { ok: true, positions, edgeRouting, affected };
}
