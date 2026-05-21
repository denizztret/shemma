import type { SpaceLocalDTO, SpacePublicDTO, SpaceRecord } from "./types.js";

export function toPublicDTO(s: SpaceRecord, opts?: { orphaned?: boolean }): SpacePublicDTO {
  return {
    id: s.id,
    label: s.label,
    lastUsedAt: s.lastUsedAt,
    orphaned: opts?.orphaned,
  };
}

export function toLocalDTO(s: SpaceRecord, opts?: { orphaned?: boolean }): SpaceLocalDTO {
  return {
    ...toPublicDTO(s, opts),
    path: s.path,
    storageLayout: s.storageLayout,
    createdAt: s.createdAt,
    legacy: s.legacy,
  };
}
