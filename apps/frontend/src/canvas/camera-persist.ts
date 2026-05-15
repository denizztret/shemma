export type Camera = { x: number; y: number; z: number };

const KEY_PREFIX = "didraw:camera:";

function key(room: string): string {
  return `${KEY_PREFIX}${room}`;
}

export function loadCamera(room: string): Camera | null {
  try {
    const raw = localStorage.getItem(key(room));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Camera>;
    if (
      typeof parsed.x === "number" &&
      typeof parsed.y === "number" &&
      typeof parsed.z === "number" &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y) &&
      Number.isFinite(parsed.z) &&
      parsed.z > 0
    ) {
      return { x: parsed.x, y: parsed.y, z: parsed.z };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCamera(room: string, cam: Camera): void {
  try {
    localStorage.setItem(
      key(room),
      JSON.stringify({ x: cam.x, y: cam.y, z: cam.z }),
    );
  } catch {
    // localStorage may throw (quota / disabled) — silently ignore.
  }
}
