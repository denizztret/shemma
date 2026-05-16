const GRID = 10;
const MIN_SPACING = 20;

export type NodeSizes = Map<string, { w: number; h: number }>;

function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

export function postProcess(
  positions: Record<string, { x: number; y: number }>,
  sizes: NodeSizes,
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, p] of Object.entries(positions)) {
    out[id] = { x: snap(p.x), y: snap(p.y) };
  }

  // Min-spacing guard: for any pair, if right edge of one is within MIN_SPACING
  // of left edge of another (vertically aligned within max(h)), push the later one right.
  const ids = Object.keys(out);
  for (const idA of ids) {
    for (const idB of ids) {
      if (idA === idB) continue;
      const a = out[idA];
      const b = out[idB];
      if (!a || !b) continue;
      const sa = sizes.get(idA);
      const sb = sizes.get(idB);
      if (!sa || !sb) continue;
      const verticallyClose = Math.abs(a.y - b.y) < Math.max(sa.h, sb.h);
      if (!verticallyClose) continue;
      const aRight = a.x + sa.w;
      if (b.x > a.x && b.x < aRight + MIN_SPACING) {
        out[idB] = { x: snap(aRight + MIN_SPACING), y: b.y };
      }
    }
  }

  return out;
}
