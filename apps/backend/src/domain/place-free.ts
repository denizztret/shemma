// apps/backend/src/domain/place-free.ts
//
// DRW-223: page-level smart-insert for new FREE shapes (define→geo, note).
//
// `compile` creates every new shape at (0,0) and delegates positioning to the
// post-apply ELK layout. But that layout runs scope="affected" and is a NO-OP
// for a single affected node (or a disconnected set) — so an agent that creates
// nodes one `shemma_define` at a time gets every node stacked at (0,0) (the
// "куча" reported on ADV-4255). This pass places each new free shape into the
// nearest empty slot beside existing page content, so single/disconnected
// creates no longer pile. A connected batch is still re-distributed by the
// subsequent ELK layout — this placement is harmless there (just an initial,
// non-overlapping seed that layout overrides).
//
// Scope: only free page-root `geo` (define) and `note` shapes are placed.
// Arrows have no standalone bbox (bound geometry follows endpoints). Frames /
// schema-containers are NOT repositioned here (their children carry
// parent-relative coords) — but they ARE treated as occupants, so new free
// shapes are placed beside existing schema-frames rather than on top of them.

import type { TLRecord, TLStoreSnapshot } from "../store-types";

type Rect = { x: number; y: number; w: number; h: number };
type Size = { w: number; h: number };

/** Gap (px) kept between a placed shape and the existing content. */
const GAP = 40;
/** tldraw note shapes have no `w/h` prop — use the default note footprint. */
const NOTE_W = 200;
const NOTE_H = 200;
/** Free shape types this pass repositions. */
const PLACEABLE_TYPES = new Set(["geo", "note"]);

function typeOf(r: TLRecord): string {
  return (r as { type?: string }).type ?? "";
}

function propsOf(r: TLRecord): Record<string, unknown> {
  return (r as { props?: Record<string, unknown> }).props ?? {};
}

/** Effective placement size of a shape, or null if it has no usable bbox. */
function sizeOf(r: TLRecord): Size | null {
  const type = typeOf(r);
  if (type === "note") return { w: NOTE_W, h: NOTE_H };
  const props = propsOf(r);
  const w = props.w;
  const h = props.h;
  if (typeof w !== "number" || typeof h !== "number") return null;
  const growY = typeof props.growY === "number" ? props.growY : 0;
  return { w, h: h + growY };
}

/** Occupant rect for collision tests (geo/note/frame). Null = no footprint. */
function occupantRect(r: TLRecord): Rect | null {
  const x = (r as { x?: number }).x ?? 0;
  const y = (r as { y?: number }).y ?? 0;
  const type = typeOf(r);
  if (type === "frame") {
    const props = propsOf(r);
    if (typeof props.w === "number" && typeof props.h === "number") {
      return { x, y, w: props.w, h: props.h };
    }
    return null;
  }
  const size = sizeOf(r);
  return size ? { x, y, w: size.w, h: size.h } : null;
}

/**
 * Slot for `size` beside existing content: the column immediately to the right
 * of the occupants' bounding box, aligned to its top. Nothing extends past
 * `maxX`, so this is always free — no overlap test or area scan needed (O(N) in
 * the occupant count, so it stays cheap even on rooms with many shapes). New
 * shapes in the same batch are appended as occupants, so successive inserts
 * step further right and never collide. A connected batch is re-distributed by
 * the subsequent ELK layout anyway — this is just a non-piling seed.
 */
function findSlot(occupants: Rect[]): { x: number; y: number } {
  if (occupants.length === 0) return { x: 0, y: 0 };
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const o of occupants) {
    minY = Math.min(minY, o.y);
    maxX = Math.max(maxX, o.x + o.w);
  }
  return { x: maxX + GAP, y: minY };
}

/**
 * Reposition newly-added free page-root shapes (geo/note) at (0,0) into empty
 * slots beside existing page content. Mutates the `added` records in place.
 *
 * @param store  room snapshot BEFORE this batch is applied (supplies occupants)
 * @param added  the batch's added records (compiled.batch.added)
 */
export function placeNewFreeShapes(
  store: TLStoreSnapshot,
  added: Record<string, TLRecord>,
): void {
  const occupants: Rect[] = [];
  for (const id in store.store) {
    const r = store.store[id];
    if (!r || r.typeName !== "shape") continue;
    if ((r as { parentId?: string }).parentId !== "page:page") continue;
    const rect = occupantRect(r);
    if (rect) occupants.push(rect);
  }

  // Deterministic insertion order (string keys preserve insertion order).
  for (const id of Object.keys(added)) {
    const r = added[id];
    if (!r || r.typeName !== "shape") continue;
    if (!PLACEABLE_TYPES.has(typeOf(r))) continue;
    if ((r as { parentId?: string }).parentId !== "page:page") continue;
    const size = sizeOf(r);
    if (!size) continue;
    const slot = findSlot(occupants);
    (r as { x: number }).x = slot.x;
    (r as { y: number }).y = slot.y;
    occupants.push({ x: slot.x, y: slot.y, w: size.w, h: size.h });
  }
}
