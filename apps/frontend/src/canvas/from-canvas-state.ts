import type { TLShapeId, TLShapePartial } from "tldraw";
import type { Role } from "@didraw/domain";
import { toEdgeShapeId, toShapeId } from "./id-prefix";
import { kindToTldraw } from "./kinds";
import { labelToRichText } from "./richtext";
import { PORT_SIDE_TO_ANCHOR, rolePropsForNode } from "./role-render";

// TLBindingCreate is not re-exported from tldraw root; mirror the minimal shape we use.
export type ArrowBindingCreate = {
  type: "arrow";
  fromId: TLShapeId;
  toId: TLShapeId;
  props: {
    terminal: "start" | "end";
    normalizedAnchor: { x: number; y: number };
    isPrecise: boolean;
    isExact: boolean;
  };
};

export type NodeStyle = {
  color?: string;
  fill?: string;
};

// Backend `style.color`/`style.fill` are plain strings; tldraw expects values
// from its own enums (color: black|grey|red|...; fill: none|semi|solid|pattern).
// We pass them through verbatim — unknown values produce a tldraw console
// warning, which is acceptable and beats silently dropping the style.
function styleToProps(style?: NodeStyle): Record<string, string> {
  const out: Record<string, string> = {};
  if (style?.color) out.color = style.color;
  if (style?.fill) out.fill = style.fill;
  return out;
}

export function nodeToShape(n: {
  id: string;
  kind: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  label?: string;
  style?: NodeStyle;
  meta?: Record<string, unknown>;
}): TLShapePartial {
  const tld = kindToTldraw(n.kind);
  const styleProps = styleToProps(n.style);
  const role = n.meta?.role as Role | undefined;
  if (role) {
    const presetProps = rolePropsForNode({
      role,
      styleOwnedBy: n.meta?.styleOwnedBy as string | undefined,
      userStyle: { color: styleProps.color, fill: styleProps.fill },
    });
    if (presetProps.color !== undefined) styleProps.color = presetProps.color;
    if (presetProps.fill !== undefined) styleProps.fill = presetProps.fill;
  }

  if (tld === "note") {
    return {
      id: toShapeId(n.id),
      type: "note",
      x: n.x,
      y: n.y,
      props: { ...styleProps, richText: labelToRichText(n.label) },
      meta: { canvasId: n.id, kind: n.kind },
    };
  }

  if (tld === "text") {
    return {
      id: toShapeId(n.id),
      type: "text",
      x: n.x,
      y: n.y,
      props: { ...styleProps, richText: labelToRichText(n.label) },
      meta: { canvasId: n.id, kind: n.kind },
    };
  }

  if (tld === "draw") {
    return {
      id: toShapeId(n.id),
      type: "draw",
      x: n.x,
      y: n.y,
      meta: { canvasId: n.id, kind: n.kind },
    };
  }

  return {
    id: toShapeId(n.id),
    type: "geo",
    x: n.x,
    y: n.y,
    props: {
      ...styleProps,
      geo: tld,
      w: n.w ?? 120,
      h: n.h ?? 60,
      richText: labelToRichText(n.label),
    },
    meta: { canvasId: n.id, kind: n.kind },
  };
}

type Endpoint =
  | { kind: "node"; id: string }
  | { kind: "point"; x: number; y: number };

type EdgeRouting = {
  ports?: {
    from?: { side: "N" | "S" | "E" | "W" };
    to?: { side: "N" | "S" | "E" | "W" };
  };
  bendPoints?: Array<{ x: number; y: number }>;
};

function anchorFor(
  side: "N" | "S" | "E" | "W" | undefined,
): { x: number; y: number } {
  return side ? PORT_SIDE_TO_ANCHOR[side] : { x: 0.5, y: 0.5 };
}

type EdgeValue = {
  id: string;
  from: Endpoint;
  to: Endpoint;
  label?: string;
  style?: { color?: string; dashed?: boolean; arrow?: "none" | "to" | "both" };
  meta?: Record<string, unknown>;
};

// Maps Edge → tldraw arrow shape + bindings for any node-anchored endpoints.
// start/end coords are placeholders when bound; tldraw recomputes on binding apply.
export function edgeToShape(e: EdgeValue): {
  shape: TLShapePartial;
  bindings: ArrowBindingCreate[];
} {
  const arrowId = toEdgeShapeId(e.id);
  const startCoord =
    e.from.kind === "point" ? { x: e.from.x, y: e.from.y } : { x: 0, y: 0 };
  const endCoord =
    e.to.kind === "point" ? { x: e.to.x, y: e.to.y } : { x: 100, y: 0 };

  const arrow = e.style?.arrow ?? "to";
  const arrowheadStart = arrow === "both" ? "arrow" : "none";
  const arrowheadEnd = arrow === "none" ? "none" : "arrow";

  const shape: TLShapePartial = {
    id: arrowId,
    type: "arrow",
    x: 0,
    y: 0,
    props: {
      start: startCoord,
      end: endCoord,
      arrowheadStart,
      arrowheadEnd,
      dash: e.style?.dashed ? "dashed" : "solid",
      richText: labelToRichText(e.label),
    },
    meta: { canvasId: e.id, kind: "edge" },
  };

  const routing = e.meta?.routing as EdgeRouting | undefined;
  const fromAnchor = anchorFor(routing?.ports?.from?.side);
  const toAnchor = anchorFor(routing?.ports?.to?.side);

  const bindings: ArrowBindingCreate[] = [];
  if (e.from.kind === "node") {
    bindings.push({
      type: "arrow",
      fromId: arrowId,
      toId: toShapeId(e.from.id),
      props: {
        terminal: "start",
        normalizedAnchor: fromAnchor,
        isPrecise: routing?.ports?.from?.side !== undefined,
        isExact: false,
      },
    });
  }
  if (e.to.kind === "node") {
    bindings.push({
      type: "arrow",
      fromId: arrowId,
      toId: toShapeId(e.to.id),
      props: {
        terminal: "end",
        normalizedAnchor: toAnchor,
        isPrecise: routing?.ports?.to?.side !== undefined,
        isExact: false,
      },
    });
  }
  return { shape, bindings };
}
