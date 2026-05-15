import type { TLShape } from "tldraw";
import { fromShapeId } from "./id-prefix";
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
  | { op: "delete"; target: "node"; id: string };

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
  if (s.type === "draw") {
    return { id: fromShapeId(s.id), kind: "freeform", x: s.x, y: s.y };
  }
  return null;
}

function geoToKind(g: string) {
  return g === "rectangle"
    ? "rect"
    : g === "ellipse"
      ? "ellipse"
      : g === "diamond"
        ? "diamond"
        : "rect";
}

export function diffToOps(
  prev: Map<string, TLShape>,
  next: Map<string, TLShape>,
): SimpleOp[] {
  const ops: SimpleOp[] = [];
  for (const [id, s] of next) {
    // User-created/moved arrows aren't yet round-tripped to backend (edge reverse-flow
    // is backlog). Skip arrows entirely so cascades from node moves don't leak ops.
    if (s.type === "arrow") continue;
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
    if (s.type === "arrow") continue;
    if (!next.has(id))
      ops.push({ op: "delete", target: "node", id: fromShapeId(s.id) });
  }
  return ops;
}
