/**
 * Pure scoring for the aspect-aware auto-direction search (DRW-218 AC#6).
 *
 * score = aspectExtremity + 0.15·crossings + 0.5·overlaps. Overlaps are mostly
 * pinned nodes colliding with a candidate layout (pins are post-override — the
 * layout can't move them, so a candidate that lands on top of one must lose).
 *
 * `pickDirectionCandidate` implements the "sticky champion": the incumbent
 * (last auto-applied direction) wins ties — a candidate must be STRICTLY
 * better. With deterministic ELK this kills score-drift between runs.
 */

export type PlanMetrics = {
  contentW: number;
  contentH: number;
  crossings: number;
  overlaps: number;
};

export type Box = { x: number; y: number; w: number; h: number };

const CROSSING_WEIGHT = 0.15;
const OVERLAP_WEIGHT = 0.5;

export function planScore(m: PlanMetrics): number {
  const ratio = Math.max(m.contentW / m.contentH, m.contentH / m.contentW);
  return ratio + CROSSING_WEIGHT * m.crossings + OVERLAP_WEIGHT * m.overlaps;
}

/** Number of strictly-intersecting box pairs (shared edges don't count). */
export function countBoxOverlaps(boxes: ReadonlyArray<Box>): number {
  let n = 0;
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    if (!a) continue;
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      if (!b) continue;
      if (
        a.x < b.x + b.w &&
        b.x < a.x + a.w &&
        a.y < b.y + b.h &&
        b.y < a.y + a.h
      ) {
        n++;
      }
    }
  }
  return n;
}

export function pickDirectionCandidate<T>(
  incumbent: { value: T; metrics: PlanMetrics },
  candidates: ReadonlyArray<{ value: T; metrics: PlanMetrics }>,
): T {
  let best = incumbent.value;
  let bestScore = planScore(incumbent.metrics);
  for (const c of candidates) {
    const s = planScore(c.metrics);
    if (s < bestScore) {
      bestScore = s;
      best = c.value;
    }
  }
  return best;
}
