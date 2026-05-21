/**
 * Pure helper for resizing adjacent columns in a multi-column layout (DRW-116).
 *
 * Extracted from `MultiColumnLayout` so the logic can be covered by bun:test
 * without mounting React.
 */

const DEFAULT_MIN_PERCENT = 10;

/**
 * Adjust widths between two adjacent columns by `deltaPercent`, clamping each
 * side to `minPercent`. The pair's combined share is kept invariant — other
 * columns in the array are not touched. Returns a new array (does not mutate).
 */
export function applyResize(
  widths: readonly number[],
  i: number,
  deltaPercent: number,
  minPercent = DEFAULT_MIN_PERCENT,
): number[] {
  if (i < 0 || i + 1 >= widths.length) return widths.slice();
  const next = widths.slice();
  const left = next[i] ?? 0;
  const right = next[i + 1] ?? 0;
  const sumPair = left + right;
  // Keep both sides ≥ minPercent while preserving the combined share.
  const newLeft = Math.min(sumPair - minPercent, Math.max(minPercent, left + deltaPercent));
  next[i] = newLeft;
  next[i + 1] = sumPair - newLeft;
  return next;
}
