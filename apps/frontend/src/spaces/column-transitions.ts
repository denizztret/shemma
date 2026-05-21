import type { Column } from "./url-parser";

/**
 * Pure helpers for within-column gallery↔room transitions (DRW-116 Task 18).
 *
 * The `MultiColumnLayout` owns mutable `columns` state once mounted; clicking
 * a room card in column N's Gallery transforms column N into a `kind: "room"`
 * column without unmounting siblings, and the "← Gallery" button in App
 * reverses the transformation. Extracting these as pure functions keeps the
 * layout component lean and lets us cover the logic with bun:test without
 * a React renderer.
 */

/**
 * Replace column `i` with a `room` column for `roomId`, preserving the
 * column's existing `spaceId`. Returns the original array reference when the
 * index is out of range so callers can guard with `Object.is`-style checks.
 */
export function applyOpenRoom(
  columns: Column[],
  i: number,
  roomId: string,
): Column[] {
  const col = columns[i];
  if (!col) return columns;
  const next = columns.slice();
  next[i] = { kind: "room", spaceId: col.spaceId, roomId };
  return next;
}

/**
 * Replace column `i` with a `gallery` column for the same space. Returns the
 * original array reference when the index is out of range.
 */
export function applyBackToGallery(columns: Column[], i: number): Column[] {
  const col = columns[i];
  if (!col) return columns;
  const next = columns.slice();
  next[i] = { kind: "gallery", spaceId: col.spaceId };
  return next;
}
