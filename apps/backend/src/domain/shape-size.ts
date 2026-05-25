// apps/backend/src/domain/shape-size.ts
//
// Helpers for translating tldraw `props.size` ("s"|"m"|"l"|"xl") into
// effective layout dimensions.  Size controls font size / stroke weight in
// tldraw but does NOT change props.w / props.h, so ELK would otherwise
// receive the original (small) box dimensions even when the user picked XL.
//
// Apply only to leaf shapes — containers / frames / arrows manage their own
// sizing through Pass-A geometry.

/** Base dimensions for a "medium" leaf shape (matches role-preset for service). */
export const BASE_LEAF_W = 220;
export const BASE_LEAF_H = 80;

/**
 * Scale factor for a tldraw size token.
 * "m" (and any unrecognised value) → 1.0 (no change).
 */
export function sizeMultiplier(size: string | undefined): number {
  switch (size) {
    case "s":
      return 0.85;
    case "l":
      return 1.3;
    case "xl":
      return 1.6;
    default:
      return 1.0; // "m" or unknown
  }
}

type Bounds = { x: number; y: number; w: number; h: number };

type ShapeRec = {
  props?: Record<string, unknown>;
};

/**
 * Return effective bounds for a leaf shape, growing w/h when size > "m".
 *
 * Rule: effective dimension = max(current dimension, BASE * multiplier).
 * We never shrink a shape the user may have manually resized; we only grow
 * it to the minimum that the chosen size warrants.
 *
 * For size="m" (the default) or unknown: returns baseBounds unchanged, so
 * shapes that have never been manually sized stay at their original dims.
 */
export function effectiveShapeBounds(r: ShapeRec, baseBounds: Bounds): Bounds {
  const size = r.props?.size;
  const mult = sizeMultiplier(typeof size === "string" ? size : undefined);

  // Default size (1.0) → no expansion; return baseBounds as-is.
  if (mult === 1.0) return baseBounds;

  const minW = BASE_LEAF_W * mult;
  const minH = BASE_LEAF_H * mult;

  return {
    x: baseBounds.x,
    y: baseBounds.y,
    w: Math.max(baseBounds.w, minW),
    h: Math.max(baseBounds.h, minH),
  };
}
