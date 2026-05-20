
import type { MiroBulkItem, MiroConnectorPayload } from "./client";
import { nearestShapeColor, nearestStickyColor } from "./color-mapping";
import type { RawShape } from "./coords";
import { richTextToPlain } from "./rich-text";

export type TrackingField = "metadata" | "appData";

export interface TrackingMeta {
  shemmaId: string;
  shemmaRoom: string;
  exportedAt: string;
  shemmaVersion: string;
}

export interface BuilderCtx {
  miroX: number;
  miroY: number;
  parentMiroId?: string;
  trackingField: TrackingField;
  elementId: string;
  shemmaRoom: string;
  shemmaVersion: string;
}

// NOTE: Miro REST v2 ignores unknown fields on shape/connector create.
// We still populate metadata/appData for shemma's own tracking state.
function attachTracking(
  item: { metadata?: Record<string, unknown>; appData?: string },
  field: TrackingField,
  meta: TrackingMeta,
): void {
  if (field === "metadata") {
    item.metadata = { ...meta };
  } else {
    item.appData = JSON.stringify(meta);
  }
}

function buildTracking(ctx: BuilderCtx): TrackingMeta {
  return {
    shemmaId: ctx.elementId,
    shemmaRoom: ctx.shemmaRoom,
    exportedAt: new Date().toISOString(),
    shemmaVersion: ctx.shemmaVersion,
  };
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

  const style: Record<string, unknown> = {};
  // meta.fillHex is set by Mermaid import; tldraw named colors (props.color) are
  // not translated — we leave fillColor unset (Miro default = white) for those.
  const metaFillHex = (shape.meta?.fillHex as string | undefined) ?? undefined;
  if (metaFillHex && metaFillHex.startsWith("#")) {
    style.fillColor = nearestShapeColor(metaFillHex);
  }
  const metaBorderHex = shape.meta?.borderHex as string | undefined;
  if (metaBorderHex) style.borderColor = metaBorderHex;

  const item: MiroBulkItem = {
    type: "shape",
    data: {
      shape: mapGeoToMiroShape(geo),
      ...(content ? { content } : {}),
    },
    style,
    position: { x: ctx.miroX, y: ctx.miroY },
    geometry: { width: w, height: h },
  };
  if (ctx.parentMiroId) item.parent = { id: ctx.parentMiroId };
  attachTracking(item, ctx.trackingField, buildTracking(ctx));
  return item;
}

/** Build payload for a tldraw note shape → Miro sticky_note. */
export function buildStickyNotePayload(shape: RawShape, ctx: BuilderCtx): MiroBulkItem {
  const props = shape.props ?? {};
  const w = (props.w as number | undefined) ?? 200;
  const h = (props.h as number | undefined) ?? 200;
  const content = pickRichText(props);

  const style: Record<string, unknown> = {};
  // Miro sticky notes require a named-enum fillColor (not hex).
  const metaFillHex = shape.meta?.fillHex as string | undefined;
  style.fillColor = metaFillHex ? nearestStickyColor(metaFillHex) : "yellow";

  const item: MiroBulkItem = {
    type: "sticky_note",
    data: { ...(content ? { content } : {}), shape: "square" },
    style,
    position: { x: ctx.miroX, y: ctx.miroY },
    geometry: { width: w, height: h },
  };
  if (ctx.parentMiroId) item.parent = { id: ctx.parentMiroId };
  attachTracking(item, ctx.trackingField, buildTracking(ctx));
  return item;
}

/** Build payload for a tldraw text shape → Miro text. */
export function buildTextPayload(shape: RawShape, ctx: BuilderCtx): MiroBulkItem {
  const props = shape.props ?? {};
  const w = (props.w as number | undefined) ?? 100;
  const content = pickRichText(props);
  const item: MiroBulkItem = {
    type: "text",
    data: { content },
    style: {},
    position: { x: ctx.miroX, y: ctx.miroY },
    geometry: { width: w },
  };
  if (ctx.parentMiroId) item.parent = { id: ctx.parentMiroId };
  attachTracking(item, ctx.trackingField, buildTracking(ctx));
  return item;
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
  const item: MiroBulkItem = {
    type: "frame",
    data: { title, type: "freeform" },
    style: {},
    position: { x: ctx.miroX, y: ctx.miroY },
    geometry: { width: w, height: h },
  };
  attachTracking(item, ctx.trackingField, buildTracking(ctx));
  return item;
}

export interface ArrowEndpoint {
  toId: string;
  normalizedAnchor: { x: number; y: number };
}

export interface ArrowEndpoints {
  start?: ArrowEndpoint;
  end?: ArrowEndpoint;
}

/** Walk store bindings (typeName='binding', type='arrow') to find arrow endpoints. */
export function collectArrowEndpointsFromStore(
  arrowId: string,
  store: Record<string, RawShape>,
): ArrowEndpoints {
  const result: ArrowEndpoints = {};
  for (const id in store) {
    const r = store[id] as unknown as {
      typeName?: string;
      type?: string;
      fromId?: string;
      toId?: string;
      props?: { terminal?: string; normalizedAnchor?: { x: number; y: number } };
    };
    if (r.typeName !== "binding") continue;
    if (r.type !== "arrow") continue;
    if (r.fromId !== arrowId) continue;
    if (!r.toId || !r.props?.normalizedAnchor) continue;
    const endpoint: ArrowEndpoint = {
      toId: r.toId,
      normalizedAnchor: r.props.normalizedAnchor,
    };
    if (r.props.terminal === "start") result.start = endpoint;
    else if (r.props.terminal === "end") result.end = endpoint;
  }
  return result;
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
  trackingField: TrackingField;
  shemmaRoom: string;
  shemmaVersion: string;
}

export type ConnectorBuildResult =
  | { kind: "ok"; payload: MiroConnectorPayload }
  | { kind: "skip"; reason: "unsupported-type" | "cross-selection-connector" };

export function buildConnectorPayload(
  arrow: RawShape,
  ctx: ConnectorBuilderCtx,
): ConnectorBuildResult {
  const endpoints = collectArrowEndpointsFromStore(arrow.id, ctx.store);
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
    style: {},
    ...(captions ? { captions } : {}),
  };
  attachTracking(payload, ctx.trackingField, {
    shemmaId: arrow.id,
    shemmaRoom: ctx.shemmaRoom,
    exportedAt: new Date().toISOString(),
    shemmaVersion: ctx.shemmaVersion,
  });
  return { kind: "ok", payload };
}
