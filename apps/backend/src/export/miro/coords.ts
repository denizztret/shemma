
export interface RawShape {
  id: string;
  typeName: string;
  type?: string;
  x?: number;
  y?: number;
  parentId?: string;
  props?: Record<string, unknown> & { w?: number; h?: number };
  meta?: Record<string, unknown>;
}

export interface PageBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Resolve shape's absolute page-space bounds by walking the parentId chain.
 * Stops at "page:..." parents or missing parents. Returns null when the shape is absent.
 */
export function resolvePageBounds(
  shapeId: string,
  store: Record<string, RawShape>,
): PageBounds | null {
  const s = store[shapeId];
  if (!s) return null;
  let ax = s.x ?? 0;
  let ay = s.y ?? 0;
  let cur = s.parentId;
  while (cur && cur.startsWith("shape:")) {
    const p = store[cur];
    if (!p) break;
    ax += p.x ?? 0;
    ay += p.y ?? 0;
    cur = p.parentId;
  }
  const w = (s.props?.w as number | undefined) ?? 0;
  const h = (s.props?.h as number | undefined) ?? 0;
  return { x: ax, y: ay, w, h };
}

/** Center of the axis-aligned bounding box that encloses all bounds. */
export function computeCentroid(bounds: PageBounds[]): { x: number; y: number } {
  if (bounds.length === 0) return { x: 0, y: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of bounds) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}
