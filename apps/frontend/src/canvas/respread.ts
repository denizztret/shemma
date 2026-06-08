// DRW-239: relative density respread of an already-laid-out schema.
//
// The density control (slider) must change ONLY the distance between shapes —
// never recompose the structure. Each gesture scales the CURRENT positions by a
// factor k about an anchor: k>1 spreads, k<1 compresses. Sizes are never touched
// (connectors are bound elbows and follow on their own); containers/frames refit
// to content in the caller. There is no persistent "default" — undo is ⌘Z.
//
// Math note: to keep the min-gap guard exact, we scale shape CENTRES about the
// centroid (so every pairwise centre-distance scales by exactly k), then translate
// the whole result to re-anchor it (a uniform shift changes neither pairwise
// distances nor overlaps). "min" re-anchors the content's top-left to where it was
// (drift-free; wrapper grows bottom-right); "center" keeps the bbox centre fixed
// (symmetric in-place spread for a free selection).

export type Anchor = "min" | "center";

/** A sibling node at one layout level (children of a single parent). */
export type RespreadNode = {
  id: string;
  /** Parent-relative top-left (current/snapshot). */
  x: number;
  y: number;
  /** Size — read for the min-gap guard; never modified. */
  w: number;
  h: number;
  /** User-pinned / user-positioned → never moved. */
  pinned: boolean;
};

/** New parent-relative top-left for a moved node. */
export type RespreadResult = { id: string; x: number; y: number };

const EPS = 1e-9;

/**
 * The smallest factor (≤ 1) at which every MOVING pair on this level still keeps
 * at least `minGap` between their boxes. Uniform scaling about a point scales all
 * pairwise centre-distances by k, so the binding pair gives an exact floor:
 *   a pair stays separated for k ≥ min(reqX/|Δcx|, reqY/|Δcy|).
 * The per-pair threshold is capped at 1 so pairs already tighter than minGap only
 * BLOCK further compression — they never force the layout to expand. Returns 0
 * when nothing constrains compression. Pinned nodes are ignored (they don't scale,
 * so the clean k-relationship wouldn't hold for them).
 */
export function levelMinK(
  nodes: ReadonlyArray<RespreadNode>,
  minGap: number,
): number {
  const m = nodes.filter((n) => !n.pinned);
  let kMin = 0;
  for (let i = 0; i < m.length; i++) {
    for (let j = i + 1; j < m.length; j++) {
      const a = m[i];
      const b = m[j];
      if (!a || !b) continue;
      const dx = Math.abs(a.x + a.w / 2 - (b.x + b.w / 2));
      const dy = Math.abs(a.y + a.h / 2 - (b.y + b.h / 2));
      const reqX = (a.w + b.w) / 2 + minGap;
      const reqY = (a.h + b.h) / 2 + minGap;
      const tX = dx > EPS ? reqX / dx : Number.POSITIVE_INFINITY;
      const tY = dy > EPS ? reqY / dy : Number.POSITIVE_INFINITY;
      const t = Math.min(tX, tY);
      if (!Number.isFinite(t)) continue; // coincident centres — scaling can't separate
      kMin = Math.max(kMin, Math.min(1, t));
    }
  }
  return kMin;
}

/**
 * Scale the MOVING nodes' positions by `k` about the level anchor. Pinned nodes
 * are skipped (kept, not returned). Sizes are never changed. See the module note
 * for why this scales centres-about-centroid then re-anchors.
 */
export function computeRespreadLevel(
  nodes: ReadonlyArray<RespreadNode>,
  k: number,
  anchor: Anchor,
): RespreadResult[] {
  const m = nodes.filter((n) => !n.pinned);
  if (m.length === 0) return [];

  // Original bbox of the moving set (for re-anchoring).
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let sumCx = 0;
  let sumCy = 0;
  for (const n of m) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
    sumCx += n.x + n.w / 2;
    sumCy += n.y + n.h / 2;
  }
  const cenX = sumCx / m.length;
  const cenY = sumCy / m.length;

  // Scale centres about the centroid (exact k on every pairwise distance).
  const scaled = m.map((n) => {
    const cx = cenX + (n.x + n.w / 2 - cenX) * k;
    const cy = cenY + (n.y + n.h / 2 - cenY) * k;
    return { id: n.id, x: cx - n.w / 2, y: cy - n.h / 2, w: n.w, h: n.h };
  });

  // Re-anchor with a uniform translation (does not affect pairwise gaps).
  let sMinX = Number.POSITIVE_INFINITY;
  let sMinY = Number.POSITIVE_INFINITY;
  let sMaxX = Number.NEGATIVE_INFINITY;
  let sMaxY = Number.NEGATIVE_INFINITY;
  for (const s of scaled) {
    sMinX = Math.min(sMinX, s.x);
    sMinY = Math.min(sMinY, s.y);
    sMaxX = Math.max(sMaxX, s.x + s.w);
    sMaxY = Math.max(sMaxY, s.y + s.h);
  }
  let dx: number;
  let dy: number;
  if (anchor === "center") {
    // keep the bbox centre fixed → symmetric in-place spread
    dx = (minX + maxX) / 2 - (sMinX + sMaxX) / 2;
    dy = (minY + maxY) / 2 - (sMinY + sMaxY) / 2;
  } else {
    // keep the content top-left fixed → drift-free; wrapper grows bottom-right
    dx = minX - sMinX;
    dy = minY - sMinY;
  }
  return scaled.map((s) => ({ id: s.id, x: s.x + dx, y: s.y + dy }));
}
