import type { TLShapeId } from "tldraw";

const PREFIX = "shape:";
const EDGE_PREFIX = "shape:edge-";

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
