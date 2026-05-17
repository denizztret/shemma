/**
 * Mirror of /^[a-zA-Z0-9_-]{1,64}$/ from apps/backend/src/rooms.ts.
 * Keep in sync with the backend regex.
 */
const ROOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateRoomId(id: string): boolean {
  return ROOM_ID_RE.test(id);
}
