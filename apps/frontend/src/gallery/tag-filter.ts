import type { RoomListItem, RoomTag } from "../transport/api";

export const MAX_TAGS = 12;
export const MAX_TAG_NAME_LEN = 24;

/** Case-insensitive name equality (names are compared trimmed + lowercased). */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * AND-filter: a room matches when its tags include EVERY active filter name
 * (case-insensitive). Empty filter set → every room matches. Colour is ignored
 * for matching — only the name identifies a tag.
 */
export function roomMatchesTagFilter(
  room: Pick<RoomListItem, "tags">,
  activeTagNames: string[],
): boolean {
  if (activeTagNames.length === 0) return true;
  const roomTags = room.tags ?? [];
  return activeTagNames.every((name) =>
    roomTags.some((t) => sameName(t.name, name)),
  );
}

/**
 * Validate a candidate tag name against the backend contract for inline-edit
 * UX (Add button enable/disable). Returns null when valid, else an error
 * message. `existing` are the room's current tags (dedupe check).
 */
export function validateNewTagName(
  raw: string,
  existing: RoomTag[],
): string | null {
  const name = raw.trim();
  if (!name) return "Tag name is empty";
  if (name.length > MAX_TAG_NAME_LEN)
    return `Tag name must be ≤${MAX_TAG_NAME_LEN} chars`;
  if (existing.length >= MAX_TAGS) return `At most ${MAX_TAGS} tags`;
  if (existing.some((t) => sameName(t.name, name)))
    return "Tag already exists";
  return null;
}
