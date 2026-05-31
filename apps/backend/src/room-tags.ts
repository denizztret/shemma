// apps/backend/src/room-tags.ts
//
// Pure validation + normalization for room tags (PUT /api/rooms/:id/tags).
// Kept HTTP-free so it can be unit-tested in isolation.

import {
  ROOM_TAG_COLORS,
  ROOM_TAG_MAX_COUNT,
  ROOM_TAG_MAX_NAME_LENGTH,
  type RoomTag,
  type RoomTagColor,
} from "./types";

const COLOR_SET = new Set<RoomTagColor>(ROOM_TAG_COLORS);

export type NormalizeTagsResult =
  | { ok: true; tags: RoomTag[] }
  | { ok: false; error: string };

/**
 * Validate + normalize an arbitrary tags payload into a clean `RoomTag[]`.
 *
 * Rules:
 * - input must be an array;
 * - each entry must have a non-empty `name` (trimmed) ≤ {@link ROOM_TAG_MAX_NAME_LENGTH};
 * - each entry's `color` must be one of the fixed {@link ROOM_TAG_COLORS};
 * - duplicates by `name` (case-insensitive) are dropped, first occurrence wins;
 * - at most {@link ROOM_TAG_MAX_COUNT} tags after dedupe.
 */
export function normalizeRoomTags(input: unknown): NormalizeTagsResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: "tags must be an array" };
  }

  const out: RoomTag[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "each tag must be an object { name, color }" };
    }
    const { name, color } = raw as { name?: unknown; color?: unknown };

    if (typeof name !== "string") {
      return { ok: false, error: "tag.name must be a string" };
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: "tag.name must be non-empty" };
    }
    if (trimmed.length > ROOM_TAG_MAX_NAME_LENGTH) {
      return {
        ok: false,
        error: `tag.name must be at most ${ROOM_TAG_MAX_NAME_LENGTH} characters`,
      };
    }

    if (typeof color !== "string" || !COLOR_SET.has(color as RoomTagColor)) {
      return {
        ok: false,
        error: `tag.color must be one of: ${ROOM_TAG_COLORS.join(", ")}`,
      };
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue; // dedupe by name, first wins
    seen.add(key);
    out.push({ name: trimmed, color: color as RoomTagColor });
  }

  if (out.length > ROOM_TAG_MAX_COUNT) {
    return {
      ok: false,
      error: `at most ${ROOM_TAG_MAX_COUNT} tags allowed`,
    };
  }

  return { ok: true, tags: out };
}
