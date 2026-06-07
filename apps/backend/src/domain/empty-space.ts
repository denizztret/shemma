// apps/backend/src/domain/empty-space.ts
//
// DRW-178: pure helpers for smart-insert / light-layout. Finds an empty
// rectangular region inside a parent area to place a new shape, or computes
// the parent expansion delta when no slot fits.

export type Rect = { x: number; y: number; w: number; h: number };
export type Size = { w: number; h: number };
export type Slot = { x: number; y: number };

const SCAN_STEP = 10;

/**
 * Find an empty rectangle of `size` inside `parent` that doesn't overlap any
 * `occupants` (each padded by `padding`). Returns the slot closest to
 * `anchor` (e.g. the centroid of linked neighbors, DRW-205) or, without an
 * anchor, closest to the parent center. Null if no such slot fits.
 *
 * O(parent.w * parent.h / step^2 * N) — adequate for typical schema sizes.
 */
export function findEmptySlot(
  parent: Size,
  occupants: Rect[],
  size: Size,
  padding: number,
  anchor?: Slot,
): Slot | null {
  if (size.w + 2 * padding > parent.w) return null;
  if (size.h + 2 * padding > parent.h) return null;

  const candidates: Slot[] = [];
  for (let y = padding; y + size.h + padding <= parent.h; y += SCAN_STEP) {
    for (let x = padding; x + size.w + padding <= parent.w; x += SCAN_STEP) {
      const fits = occupants.every(
        (o) =>
          x + size.w + padding <= o.x ||
          o.x + o.w + padding <= x ||
          y + size.h + padding <= o.y ||
          o.y + o.h + padding <= y,
      );
      if (fits) candidates.push({ x, y });
    }
  }
  if (candidates.length === 0) return null;
  const cx = anchor ? anchor.x : parent.w / 2;
  const cy = anchor ? anchor.y : parent.h / 2;
  candidates.sort(
    (a, b) =>
      Math.hypot(a.x + size.w / 2 - cx, a.y + size.h / 2 - cy) -
      Math.hypot(b.x + size.w / 2 - cx, b.y + size.h / 2 - cy),
  );
  return candidates[0]!;
}

export type Expansion = {
  dw: number;
  dh: number;
  position: Slot;
};

/**
 * When `findEmptySlot` returns null, compute how to grow the parent and where
 * to place the new shape in the expanded area. `direction` matches the
 * mermaid direction convention (TB grows downward, LR grows rightward).
 *
 * - `TB`/`BT` → expand height; place at bottom (TB) or top (BT) center.
 * - `LR`/`RL` → expand width; place at right (LR) or left (RL) center.
 */
export function computeExpansion(
  parent: Size,
  size: Size,
  padding: number,
  direction: "TB" | "BT" | "LR" | "RL",
): Expansion {
  if (direction === "LR" || direction === "RL") {
    const dw = size.w + 2 * padding;
    const x = direction === "LR" ? parent.w + padding : -size.w - padding;
    return {
      dw,
      dh: 0,
      position: { x, y: Math.max(padding, parent.h / 2 - size.h / 2) },
    };
  }
  // TB / BT
  const dh = size.h + 2 * padding;
  const y = direction === "TB" ? parent.h + padding : -size.h - padding;
  return {
    dw: 0,
    dh,
    position: { x: Math.max(padding, parent.w / 2 - size.w / 2), y },
  };
}
