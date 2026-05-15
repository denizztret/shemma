import type { TLShapeId } from "tldraw";

const PREFIX = "shape:";

export function toShapeId(canvasId: string): TLShapeId {
  return (PREFIX + canvasId) as unknown as TLShapeId;
}

export function fromShapeId(shapeId: TLShapeId): string {
  return (shapeId as unknown as string).slice(PREFIX.length);
}
