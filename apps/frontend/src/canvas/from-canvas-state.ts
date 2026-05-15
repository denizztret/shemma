import type { TLShapePartial } from "tldraw";
import { kindToTldraw } from "./kinds";

/**
 * Convert a plain-text label to a tldraw 5.x richText (ProseMirror doc JSON).
 * `toRichText` is not exported from the public tldraw API, so we construct
 * the doc node manually. Format mirrors what tldraw uses internally.
 */
function labelToRichText(label: string) {
  if (!label) {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: label }] }],
  };
}

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
      // biome-ignore lint/suspicious/noExplicitAny: tldraw shape ID branded type
      id: `shape:${n.id}` as any,
      type: "note",
      x: n.x,
      y: n.y,
      props: { richText: labelToRichText(n.label ?? "") },
      meta: { canvasId: n.id, kind: n.kind },
    };
  }

  if (tld === "text") {
    return {
      // biome-ignore lint/suspicious/noExplicitAny: tldraw shape ID branded type
      id: `shape:${n.id}` as any,
      type: "text",
      x: n.x,
      y: n.y,
      props: { richText: labelToRichText(n.label ?? "") },
      meta: { canvasId: n.id, kind: n.kind },
    };
  }

  if (tld === "draw") {
    return {
      // biome-ignore lint/suspicious/noExplicitAny: tldraw shape ID branded type
      id: `shape:${n.id}` as any,
      type: "draw",
      x: n.x,
      y: n.y,
      meta: { canvasId: n.id, kind: n.kind },
    };
  }

  return {
    // biome-ignore lint/suspicious/noExplicitAny: tldraw shape ID branded type
    id: `shape:${n.id}` as any,
    type: "geo",
    x: n.x,
    y: n.y,
    props: {
      geo: tld,
      w: n.w ?? 120,
      h: n.h ?? 60,
      richText: labelToRichText(n.label ?? ""),
    },
    meta: { canvasId: n.id, kind: n.kind },
  };
}
