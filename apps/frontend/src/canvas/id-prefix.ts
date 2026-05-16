import type { TLShapeId } from "tldraw";

const PREFIX = "shape:";
const EDGE_PREFIX = "shape:edge-";
// User-drawn arrows get a canvas edge id derived from their tldraw shape id.
// The "u_" prefix keeps them disjoint from AI-authored "e_<name>" edges.
const USER_EDGE_PREFIX = "u_";

export function toShapeId(canvasId: string): TLShapeId {
  return (PREFIX + canvasId) as unknown as TLShapeId;
}

export function fromShapeId(shapeId: TLShapeId): string {
  return (shapeId as unknown as string).slice(PREFIX.length);
}

export function toEdgeShapeId(canvasId: string): TLShapeId {
  return (EDGE_PREFIX + canvasId) as unknown as TLShapeId;
}

export function fromEdgeShapeId(shapeId: TLShapeId): string | null {
  const s = shapeId as unknown as string;
  return s.startsWith(EDGE_PREFIX) ? s.slice(EDGE_PREFIX.length) : null;
}

// Derives canvas edge id from a tldraw arrow shape id, handling both:
//   - reloaded backend-authored edges: "shape:edge-<eid>" → "<eid>"
//   - freshly user-drawn arrows: "shape:<rand>"          → "u_<rand>"
export function tlArrowIdToEdgeId(shapeId: TLShapeId): string {
  const fromEdge = fromEdgeShapeId(shapeId);
  if (fromEdge !== null) return fromEdge;
  return USER_EDGE_PREFIX + (shapeId as unknown as string).slice(PREFIX.length);
}
