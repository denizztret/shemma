import path from "node:path";
import type { Profile, SpaceRecord } from "./types.js";

export function resolveStorageRoot(space: SpaceRecord, profile: Profile): string {
  const subdir = profile === "dev" ? "canvas-dev" : "canvas";
  switch (space.storageLayout) {
    case "project": return path.join(space.path, ".shemma", subdir);
    case "legacy":  return path.join(space.path, subdir);
    case "direct":  return space.path;
  }
}

export function resolveRoomStorage(space: SpaceRecord, profile: Profile, roomId: string): string {
  return path.join(resolveStorageRoot(space, profile), `${roomId}.json`);
}
