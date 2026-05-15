import type { TLShape, TLShapeId } from "tldraw";

export type NodeValue = {
  id: string;
  kind: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  label?: string;
};

export type SimpleOp =
  | { op: "add"; target: "node"; value: NodeValue }
  | {
      op: "update";
      target: "node";
      id: string;
      set: { x?: number; y?: number; label?: string };
    }
  | { op: "delete"; target: "node"; id: string };

const idFrom = (id: TLShapeId) =>
  (id as unknown as string).replace(/^shape:/, "");

function richTextToString(rt: unknown): string {
  if (!rt || typeof rt !== "object") return "";
  const doc = rt as { content?: Array<{ content?: Array<{ text?: string }> }> };
  return doc.content?.[0]?.content?.[0]?.text ?? "";
}

export function shapeToNode(s: TLShape): NodeValue | null {
  if (s.type === "geo") {
    // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props are not typed via public API
    const p = (s as any).props ?? {};
    return {
      id: idFrom(s.id),
      kind: geoToKind(p.geo ?? "rectangle"),
      x: s.x,
      y: s.y,
      w: p.w,
      h: p.h,
      label: richTextToString(p.richText) || undefined,
    };
  }
  if (s.type === "note") {
    return {
      id: idFrom(s.id),
      kind: "sticky",
      x: s.x,
      y: s.y,
      // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props are not typed via public API
      label: richTextToString((s as any).props?.richText),
    };
  }
  if (s.type === "text") {
    return {
      id: idFrom(s.id),
      kind: "text",
      x: s.x,
      y: s.y,
      // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props are not typed via public API
      label: richTextToString((s as any).props?.richText),
    };
  }
  if (s.type === "draw") {
    return { id: idFrom(s.id), kind: "freeform", x: s.x, y: s.y };
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
    const before = prev.get(id);
    if (!before) {
      const v = shapeToNode(s);
      if (v) ops.push({ op: "add", target: "node", value: v });
    } else if (s.x !== before.x || s.y !== before.y) {
      ops.push({
        op: "update",
        target: "node",
        id: idFrom(s.id),
        set: { x: s.x, y: s.y },
      });
    }
  }
  for (const [id, s] of prev) {
    if (!next.has(id))
      ops.push({ op: "delete", target: "node", id: idFrom(s.id) });
  }
  return ops;
}
