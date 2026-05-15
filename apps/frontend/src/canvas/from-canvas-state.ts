import type { TLShapePartial } from "tldraw";
import { toShapeId } from "./id-prefix";
import { kindToTldraw } from "./kinds";
import { labelToRichText } from "./richtext";

export function nodeToShape(n: {
  id: string;
  kind: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  label?: string;
}): TLShapePartial {
  const tld = kindToTldraw(n.kind);

  if (tld === "note") {
    return {
      id: toShapeId(n.id),
      type: "note",
      x: n.x,
      y: n.y,
      props: { richText: labelToRichText(n.label) },
      meta: { canvasId: n.id, kind: n.kind },
    };
  }

  if (tld === "text") {
    return {
      id: toShapeId(n.id),
      type: "text",
      x: n.x,
      y: n.y,
      props: { richText: labelToRichText(n.label) },
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
      geo: tld,
      w: n.w ?? 120,
      h: n.h ?? 60,
      richText: labelToRichText(n.label),
    },
    meta: { canvasId: n.id, kind: n.kind },
  };
}
