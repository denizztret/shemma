import path from "node:path";
import type { SpaceId } from "./types.js";

export function slugify(s: string): string {
  const stripped = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return stripped.length === 0 ? "space" : stripped;
}

export function generateSpaceId(absolutePath: string, existing: Set<SpaceId>): SpaceId {
  const base = slugify(path.basename(absolutePath)).slice(0, 32);
  if (!existing.has(base) && base !== "default") {
    return base;
  }
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Cannot generate unique space id for ${absolutePath}`);
}
