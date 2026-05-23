
import type { MiroBulkItem, MiroConnectorPayload } from "./client";
import { nearestShapeColor, nearestStickyColor, stickyFillColor, tldrawNamedToHex } from "./color-mapping";
import type { RawShape } from "./coords";
import { richTextToPlain } from "./rich-text";

export interface BuilderCtx {
  miroX: number;
  miroY: number;
  parentMiroId?: string;
}

const GEO_TO_MIRO: Record<string, string> = {
  rectangle: "rectangle",
  ellipse: "circle",
  diamond: "rhombus",
  triangle: "triangle",
  trapezoid: "trapezoid",
  pentagon: "pentagon",
  hexagon: "hexagon",
  octagon: "octagon",
  star: "star",
  cross: "cross",
  cloud: "cloud",
  "arrow-right": "right_arrow",
  "arrow-left": "left_arrow",
};

const TEXT_ALIGN: Record<string, string> = { start: "left", middle: "center", end: "right" };
const TEXT_VALIGN: Record<string, string> = { start: "top", middle: "middle", end: "bottom" };
const ARROW_DASH: Record<string, string> = {
  dashed: "dashed",
  dotted: "dotted",
  draw: "normal",
  solid: "normal",
};

function applyPositionAndParent(item: MiroBulkItem, ctx: BuilderCtx): MiroBulkItem {
  item.position = { x: ctx.miroX, y: ctx.miroY };
  if (ctx.parentMiroId) item.parent = { id: ctx.parentMiroId };
  return item;
}

export function mapGeoToMiroShape(geo: string | undefined): string {
  if (!geo) return "rectangle";
  return GEO_TO_MIRO[geo] ?? "rectangle";
}

function pickRichText(props: Record<string, unknown> | undefined): string {
  if (!props) return "";
  return richTextToPlain(props.richText);
}

/** Build payload for a tldraw geo shape → Miro shape. */
export function buildShapePayload(shape: RawShape, ctx: BuilderCtx): MiroBulkItem {
  const props = shape.props ?? {};
  const w = (props.w as number | undefined) ?? 0;
  const h = (props.h as number | undefined) ?? 0;
  const geo = props.geo as string | undefined;
  const content = pickRichText(props);

  // meta.fillHex / meta.borderHex are user-set manual overrides — take priority.
  const metaFillHex = shape.meta?.fillHex as string | undefined;
  const metaBorderHex = shape.meta?.borderHex as string | undefined;
  const align = (props.align as string | undefined) ?? "middle";
  const valign = (props.verticalAlign as string | undefined) ?? "middle";

  // Derive color from tldraw props (falls back to black if unset).
  const colorHex = tldrawNamedToHex(props.color as string | undefined);
  const fill = props.fill as string | undefined;

  const style: Record<string, unknown> = {
    borderColor: metaBorderHex ?? colorHex,
    borderWidth: tldrawSizeToBorderWidth(props.size as string | undefined),
    borderOpacity: "1.0",
    borderStyle: "normal",
    fontFamily: tldrawFontToFamily(props.font as string | undefined),
    fontSize: tldrawSizeToFontSize(props.size as string | undefined),
    textAlign: TEXT_ALIGN[align] ?? "center",
    textAlignVertical: TEXT_VALIGN[valign] ?? "middle",
    ...fillStyle(fill, metaFillHex ?? colorHex),
  };

  return applyPositionAndParent({
    type: "shape",
    data: {
      shape: mapGeoToMiroShape(geo),
      ...(content ? { content } : {}),
    },
    style,
    geometry: { width: w, height: h },
  }, ctx);
}

/** Build payload for a tldraw note shape → Miro sticky_note. */
export function buildStickyNotePayload(shape: RawShape, ctx: BuilderCtx): MiroBulkItem {
  const props = shape.props ?? {};
  const w = (props.w as number | undefined) ?? 200;
  const h = (props.h as number | undefined) ?? 200;
  const content = pickRichText(props);

  const style: Record<string, unknown> = {
    fillColor: stickyFillColor(shape),
    fontFamily: tldrawFontToFamily(props.font as string | undefined),
    fontSize: tldrawSizeToStickyFontSize(props.size as string | undefined),
  };

  return applyPositionAndParent({
    type: "sticky_note",
    data: { ...(content ? { content } : {}), shape: "square" },
    style,
    geometry: { width: w, height: h },
  }, ctx);
}

/** Build payload for a tldraw text shape → Miro text. */
export function buildTextPayload(shape: RawShape, ctx: BuilderCtx): MiroBulkItem {
  const props = shape.props ?? {};
  const w = (props.w as number | undefined) ?? 100;
  const content = pickRichText(props);
  const colorHex = tldrawNamedToHex(props.color as string | undefined);
  const textAlign = (props.textAlign as string | undefined) ?? "middle";
  return applyPositionAndParent({
    type: "text",
    data: { content },
    style: {
      color: colorHex,
      fontFamily: tldrawFontToFamily(props.font as string | undefined),
      fontSize: tldrawSizeToFontSize(props.size as string | undefined),
      textAlign: TEXT_ALIGN[textAlign] ?? "center",
    },
    geometry: { width: w },
  }, ctx);
}

/** Build payload for a tldraw frame shape (or geo with meta.role='boundary') → Miro frame. */
export function buildFramePayload(shape: RawShape, ctx: BuilderCtx): MiroBulkItem {
  const props = shape.props ?? {};
  const w = (props.w as number | undefined) ?? 400;
  const h = (props.h as number | undefined) ?? 300;
  const title =
    (props.name as string | undefined) ??
    (shape.meta?.name as string | undefined) ??
    (shape.meta?.didrawName as string | undefined) ??
    "";
  return applyPositionAndParent({
    type: "frame",
    data: { title, type: "freeform" },
    style: {},
    geometry: { width: w, height: h },
  }, ctx);
}

export interface ArrowEndpoint {
  toId: string;
  normalizedAnchor: { x: number; y: number };
}

export interface ArrowEndpoints {
  start?: ArrowEndpoint;
  end?: ArrowEndpoint;
}

/** Single-pass scan of all binding records → Map<arrowId, endpoints>. */
export function buildArrowEndpointsIndex(
  store: Record<string, RawShape>,
): Map<string, ArrowEndpoints> {
  const out = new Map<string, ArrowEndpoints>();
  for (const id in store) {
    const r = store[id] as unknown as {
      typeName?: string;
      type?: string;
      fromId?: string;
      toId?: string;
      props?: { terminal?: string; normalizedAnchor?: { x: number; y: number } };
    };
    if (r.typeName !== "binding" || r.type !== "arrow") continue;
    if (!r.fromId || !r.toId || !r.props?.normalizedAnchor) continue;
    const ep = out.get(r.fromId) ?? {};
    const endpoint: ArrowEndpoint = {
      toId: r.toId,
      normalizedAnchor: r.props.normalizedAnchor,
    };
    if (r.props.terminal === "start") ep.start = endpoint;
    else if (r.props.terminal === "end") ep.end = endpoint;
    out.set(r.fromId, ep);
  }
  return out;
}

export function collectArrowEndpointsFromStore(
  arrowId: string,
  store: Record<string, RawShape>,
): ArrowEndpoints {
  return buildArrowEndpointsIndex(store).get(arrowId) ?? {};
}

/**
 * Map normalized anchor (0..1) → Miro snapTo side using strict 0.25/0.75 thresholds.
 * Returns 'auto' for centred anchors and exact-boundary values.
 */
export function anchorToSnapTo(
  a: { x: number; y: number },
): "top" | "bottom" | "left" | "right" | "auto" {
  if (a.y < 0.25) return "top";
  if (a.y > 0.75) return "bottom";
  if (a.x < 0.25) return "left";
  if (a.x > 0.75) return "right";
  return "auto";
}

/** Expand group shapes → list of leaf (non-group) descendant ids. */
export function expandGroups(
  ids: string[],
  store: Record<string, RawShape>,
): string[] {
  const out = new Set<string>();
  function recurse(id: string): void {
    const s = store[id];
    if (!s) return;
    if (s.type === "group") {
      // Find direct children (shapes with parentId === id), recurse.
      for (const cid in store) {
        const child = store[cid];
        if (child?.parentId === id && child.typeName === "shape") {
          recurse(cid);
        }
      }
    } else {
      out.add(id);
    }
  }
  for (const id of ids) recurse(id);
  return Array.from(out);
}

export interface ConnectorBuilderCtx {
  store: Record<string, RawShape>;
  passAMap: Map<string, string>;
  endpointsIndex?: Map<string, ArrowEndpoints>;
}

export type ConnectorBuildResult =
  | { kind: "ok"; payload: MiroConnectorPayload }
  | { kind: "skip"; reason: "unsupported-type" | "cross-selection-connector" };

// ---------------------------------------------------------------------------
// Task 2: size mapping helpers (§ 5.1)
// ---------------------------------------------------------------------------

export type TldrawSize = "s" | "m" | "l" | "xl";

export function tldrawSizeToFontSize(size: string | undefined): string {
  switch (size) {
    case "s":  return "12";
    case "l":  return "20";
    case "xl": return "30";
    case "m":
    default:   return "14";
  }
}

export function tldrawSizeToBorderWidth(size: string | undefined): string {
  switch (size) {
    case "s":  return "1.0";
    case "l":  return "3.0";
    case "xl": return "4.0";
    case "m":
    default:   return "2.0";
  }
}

export function tldrawSizeToStrokeWidth(size: string | undefined): string {
  return tldrawSizeToBorderWidth(size);
}

/**
 * Miro sticky note uses its own fontSize scale — enum 14|24|36|48|72.
 * Not reusing tldrawSizeToFontSize because sticky values differ.
 */
export function tldrawSizeToStickyFontSize(size: string | undefined): string {
  switch (size) {
    case "s":  return "14";
    case "l":  return "36";
    case "xl": return "48";
    case "m":
    default:   return "24";
  }
}

// ---------------------------------------------------------------------------
// Task 3: font mapping helper (§ 6.1)
// ---------------------------------------------------------------------------

export type TldrawFont = "draw" | "sans" | "serif" | "mono";

export function tldrawFontToFamily(font: string | undefined): string {
  switch (font) {
    case "draw":  return "caveat";           // casual flowing script — closest to tldraw handwriting feel
    case "serif": return "times_new_roman";
    case "mono":  return "roboto_mono";
    case "sans":
    default:      return "open_sans";
  }
}

// ---------------------------------------------------------------------------
// Task 4: arrowhead mapping helper (§ 7.1)
// ---------------------------------------------------------------------------

export type TldrawArrowhead =
  | "none" | "arrow" | "triangle" | "square" | "dot"
  | "diamond" | "inverted" | "bar" | "pipe";

export function tldrawArrowheadToStrokeCap(head: string | undefined): string {
  switch (head) {
    case "none":     return "none";
    case "triangle": return "filled_triangle";   // tldraw triangle = filled triangle in Miro
    case "square":   return "none";              // Miro has no rectangular caps — degrade to plain line
    case "dot":      return "filled_oval";
    case "diamond":  return "filled_diamond";
    case "inverted": return "arrow";             // Miro has no backward-facing cap — degrade to plain arrow
    case "bar":      return "none";              // no bar cap — degrade
    case "pipe":     return "none";              // no pipe cap — degrade
    case "arrow":
    default:         return "arrow";
  }
}

// ---------------------------------------------------------------------------
// Task 5: fillStyle helper (§ 4.3)
// ---------------------------------------------------------------------------

export interface FillStyleResult {
  fillColor?: string;
  fillOpacity: string;
}

/**
 * Map tldraw fill style to Miro fillColor + fillOpacity.
 * "pattern" degrades to semi (fillOpacity 0.5) — Miro has no diagonal-fill support.
 */
export function fillStyle(fill: string | undefined, hex: string): FillStyleResult {
  switch (fill) {
    case "solid":   return { fillColor: hex, fillOpacity: "1.0" };
    case "semi":    return { fillColor: hex, fillOpacity: "0.5" };
    case "pattern": return { fillColor: hex, fillOpacity: "0.5" };
    case "none":
    default:        return { fillOpacity: "0.0" };
  }
}

export function buildConnectorPayload(
  arrow: RawShape,
  ctx: ConnectorBuilderCtx,
): ConnectorBuildResult {
  const endpoints = ctx.endpointsIndex?.get(arrow.id)
    ?? collectArrowEndpointsFromStore(arrow.id, ctx.store);
  if (!endpoints.start || !endpoints.end) {
    return { kind: "skip", reason: "unsupported-type" };
  }
  const startMiroId = ctx.passAMap.get(endpoints.start.toId);
  const endMiroId = ctx.passAMap.get(endpoints.end.toId);
  if (!startMiroId || !endMiroId) {
    return { kind: "skip", reason: "cross-selection-connector" };
  }
  const bend = (arrow.props?.bend as number | undefined) ?? 0;
  const shape: "straight" | "curved" = bend === 0 ? "straight" : "curved";
  const labelText = richTextToPlain(arrow.props?.richText);
  const captions = labelText ? [{ content: labelText }] : undefined;

  const dash = (arrow.props?.dash as string | undefined) ?? "draw";
  const payload: MiroConnectorPayload = {
    startItem: {
      id: startMiroId,
      snapTo: anchorToSnapTo(endpoints.start.normalizedAnchor),
    },
    endItem: {
      id: endMiroId,
      snapTo: anchorToSnapTo(endpoints.end.normalizedAnchor),
    },
    shape,
    style: {
      strokeStyle: ARROW_DASH[dash] ?? "normal",
      strokeColor: tldrawNamedToHex(arrow.props?.color as string | undefined),
      strokeWidth: tldrawSizeToStrokeWidth(arrow.props?.size as string | undefined),
      fontFamily: tldrawFontToFamily(arrow.props?.font as string | undefined),
      fontSize: tldrawSizeToFontSize(arrow.props?.size as string | undefined),
      startStrokeCap: tldrawArrowheadToStrokeCap(arrow.props?.arrowheadStart as string | undefined),
      endStrokeCap: tldrawArrowheadToStrokeCap(arrow.props?.arrowheadEnd as string | undefined),
    },
    ...(captions ? { captions } : {}),
  };
  return { kind: "ok", payload };
}
