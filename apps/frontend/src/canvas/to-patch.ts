import type { TLArrowBinding, TLShape, TLShapeId } from "tldraw";
import { fromShapeId, tlArrowIdToEdgeId } from "./id-prefix";
import { richTextToString } from "./richtext";

export type NodeValue = {
  id: string;
  kind: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  label?: string;
  style?: { color?: string; fill?: string };
};

type Endpoint =
  | { kind: "node"; id: string }
  | { kind: "point"; x: number; y: number };

export type EdgeValue = {
  id: string;
  from: Endpoint;
  to: Endpoint;
  label?: string;
  style?: { dashed?: boolean };
};

export type SimpleOp =
  | { op: "add"; target: "node"; value: NodeValue }
  | {
      op: "update";
      target: "node";
      id: string;
      set: {
        x?: number;
        y?: number;
        w?: number;
        h?: number;
        label?: string;
        style?: { color?: string; fill?: string };
      };
    }
  | { op: "delete"; target: "node"; id: string }
  | { op: "add"; target: "edge"; value: EdgeValue }
  | {
      op: "update";
      target: "edge";
      id: string;
      set: Partial<EdgeValue>;
    }
  | { op: "delete"; target: "edge"; id: string };

// Snapshot of arrow bindings keyed by arrow shape id. Captured at the same
// moment as the shapes snapshot so prev/next diffs are coherent.
export type BindingsSnapshot = Map<TLShapeId, TLArrowBinding[]>;

// biome-ignore lint/suspicious/noExplicitAny: tldraw shape props are not typed via public API
function readStyle(p: any): { color?: string; fill?: string } | undefined {
  const out: { color?: string; fill?: string } = {};
  if (typeof p?.color === "string") out.color = p.color;
  if (typeof p?.fill === "string") out.fill = p.fill;
  return out.color || out.fill ? out : undefined;
}

export function shapeToNode(s: TLShape): NodeValue | null {
  if (s.type === "geo") {
    // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props are not typed via public API
    const p = (s as any).props ?? {};
    return {
      id: fromShapeId(s.id),
      kind: geoToKind(p.geo ?? "rectangle"),
      x: s.x,
      y: s.y,
      w: p.w,
      h: p.h,
      label: richTextToString(p.richText) || undefined,
      style: readStyle(p),
    };
  }
  if (s.type === "note") {
    // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props are not typed via public API
    const p = (s as any).props ?? {};
    return {
      id: fromShapeId(s.id),
      kind: "sticky",
      x: s.x,
      y: s.y,
      label: richTextToString(p.richText),
      style: readStyle(p),
    };
  }
  if (s.type === "text") {
    // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props are not typed via public API
    const p = (s as any).props ?? {};
    return {
      id: fromShapeId(s.id),
      kind: "text",
      x: s.x,
      y: s.y,
      label: richTextToString(p.richText),
      style: readStyle(p),
    };
  }
  // DRW-024: tldraw shapes без custom serialiser (draw/line/image/video/embed/
  // bookmark/highlight) НЕ синхронизируются. Без props.points / assetId на read
  // path tldraw crash'ит в getGeometry (Polyline2d / Image). Сделаем silent skip:
  // фигура остаётся локально в tldraw store, но на backend и second client не
  // уходит. Roadmap'd to Phase 3.x custom shapes registry.
  return null;
}

function geoToKind(g: string): "rect" | "ellipse" | "diamond" {
  switch (g) {
    case "ellipse":
      return "ellipse";
    case "diamond":
      return "diamond";
    default:
      return "rect"; // includes "rectangle" and anything unrecognised
  }
}

function endpointFor(
  binding: TLArrowBinding | undefined,
  fallback: { x: number; y: number },
): Endpoint {
  if (binding) return { kind: "node", id: fromShapeId(binding.toId) };
  return { kind: "point", x: fallback.x, y: fallback.y };
}

function endpointEq(a: Endpoint, b: Endpoint): boolean {
  if (a.kind === "node" && b.kind === "node") return a.id === b.id;
  if (a.kind === "point" && b.kind === "point") return a.x === b.x && a.y === b.y;
  return false;
}

function arrowToEdge(
  s: TLShape,
  bindings: TLArrowBinding[] | undefined,
): EdgeValue {
  const bs = bindings ?? [];
  const startBinding = bs.find((b) => b.props?.terminal === "start");
  const endBinding = bs.find((b) => b.props?.terminal === "end");
  // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props are not typed via public API
  const p = (s as any).props ?? {};
  const fallbackStart = { x: p.start?.x ?? 0, y: p.start?.y ?? 0 };
  const fallbackEnd = { x: p.end?.x ?? 0, y: p.end?.y ?? 0 };
  const label = richTextToString(p.richText) || undefined;
  const dashed = p.dash === "dashed";
  return {
    id: tlArrowIdToEdgeId(s.id),
    from: endpointFor(startBinding, fallbackStart),
    to: endpointFor(endBinding, fallbackEnd),
    label,
    style: { dashed },
  };
}

// `prevBindings`/`nextBindings` carry arrow bindings keyed by arrow shape id.
// Callers must snapshot them alongside `prev`/`next` so the diff is coherent.
export function diffToOps(
  prev: Map<string, TLShape>,
  next: Map<string, TLShape>,
  prevBindings?: BindingsSnapshot,
  nextBindings?: BindingsSnapshot,
): SimpleOp[] {
  const ops: SimpleOp[] = [];
  for (const [id, s] of next) {
    if (s.type === "arrow") {
      const before = prev.get(id);
      const curEdge = arrowToEdge(s, nextBindings?.get(s.id));
      if (!before) {
        ops.push({ op: "add", target: "edge", value: curEdge });
        continue;
      }
      const prevEdge = arrowToEdge(before, prevBindings?.get(before.id));
      const set: Partial<EdgeValue> = {};
      if (!endpointEq(prevEdge.from, curEdge.from)) set.from = curEdge.from;
      if (!endpointEq(prevEdge.to, curEdge.to)) set.to = curEdge.to;
      if (prevEdge.label !== curEdge.label) set.label = curEdge.label ?? "";
      if (prevEdge.style?.dashed !== curEdge.style?.dashed) {
        set.style = { dashed: curEdge.style?.dashed };
      }
      if (Object.keys(set).length > 0) {
        ops.push({ op: "update", target: "edge", id: curEdge.id, set });
      }
      continue;
    }
    const before = prev.get(id);
    if (!before) {
      const v = shapeToNode(s);
      if (v) ops.push({ op: "add", target: "node", value: v });
      continue;
    }
    const curNode = shapeToNode(s);
    const prevNode = shapeToNode(before);
    if (!curNode || !prevNode) continue;
    const set: {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      label?: string;
      style?: { color?: string; fill?: string };
    } = {};
    if (s.x !== before.x) set.x = s.x;
    if (s.y !== before.y) set.y = s.y;
    if (curNode.w !== prevNode.w && curNode.w !== undefined) set.w = curNode.w;
    if (curNode.h !== prevNode.h && curNode.h !== undefined) set.h = curNode.h;
    if (curNode.label !== prevNode.label) set.label = curNode.label ?? "";
    const styleDiff: { color?: string; fill?: string } = {};
    if (curNode.style?.color !== prevNode.style?.color && curNode.style?.color)
      styleDiff.color = curNode.style.color;
    if (curNode.style?.fill !== prevNode.style?.fill && curNode.style?.fill)
      styleDiff.fill = curNode.style.fill;
    if (styleDiff.color || styleDiff.fill) set.style = styleDiff;
    if (Object.keys(set).length > 0) {
      ops.push({ op: "update", target: "node", id: fromShapeId(s.id), set });
    }
  }
  for (const [id, s] of prev) {
    if (next.has(id)) continue;
    if (s.type === "arrow") {
      ops.push({ op: "delete", target: "edge", id: tlArrowIdToEdgeId(s.id) });
    } else {
      ops.push({ op: "delete", target: "node", id: fromShapeId(s.id) });
    }
  }
  return ops;
}

