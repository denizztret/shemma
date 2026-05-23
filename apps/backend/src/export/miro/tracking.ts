
import type { MiroExportsMap, RoomState } from "../../types";

export interface CommitParams {
  boardId: string;
  boardName?: string;
  itemMappings: Array<{ elementId: string; miroItemId: string }>;
  connectorMappings: Array<{ elementId: string; miroConnectorId: string }>;
}

function ensureMap(room: RoomState): MiroExportsMap {
  if (!room.meta) room.meta = {};
  if (!room.meta.miroExports) room.meta.miroExports = {};
  return room.meta.miroExports;
}

/** Full tracking entry for a board, or undefined. */
export function readBoardTracking(
  room: RoomState,
  boardId: string,
): MiroExportsMap[string] | undefined {
  return room.meta?.miroExports?.[boardId];
}

/** Items map for a board, or {} when absent. */
export function readBoardItems(
  room: RoomState,
  boardId: string,
): Record<string, string> {
  return room.meta?.miroExports?.[boardId]?.items ?? {};
}

/** Connectors map for a board, or {} when absent. */
export function readBoardConnectors(
  room: RoomState,
  boardId: string,
): Record<string, string> {
  return room.meta?.miroExports?.[boardId]?.connectors ?? {};
}

/** Merge new mappings into tracking; updates lastExportedAt. Idempotent. */
export function commitBoardExport(room: RoomState, p: CommitParams): void {
  const map = ensureMap(room);
  const existing = map[p.boardId] ?? {
    lastExportedAt: new Date().toISOString(),
    items: {},
  };
  for (const m of p.itemMappings) {
    existing.items[m.elementId] = m.miroItemId;
  }
  if (p.connectorMappings.length > 0) {
    if (!existing.connectors) existing.connectors = {};
    for (const m of p.connectorMappings) {
      existing.connectors[m.elementId] = m.miroConnectorId;
    }
  }
  existing.lastExportedAt = new Date().toISOString();
  if (p.boardName) existing.boardName = p.boardName;
  map[p.boardId] = existing;
}

export interface CommitGroupParams {
  boardId: string;
  groupMappings: Array<{ elementId: string; miroGroupId: string }>;
}

/**
 * Merge group id mappings into tracking entry for an existing board export.
 * No-op when the board hasn't been exported yet (items commit must precede group commit).
 */
export function commitBoardGroupExport(room: RoomState, p: CommitGroupParams): void {
  const entry = room.meta?.miroExports?.[p.boardId];
  if (!entry) return;
  if (!entry.groups) entry.groups = {};
  for (const m of p.groupMappings) {
    entry.groups[m.elementId] = m.miroGroupId;
  }
  entry.lastExportedAt = new Date().toISOString();
}

/** boardId with the most recent export, or undefined. */
export function getLastUsedBoardId(room: RoomState): string | undefined {
  const map = room.meta?.miroExports;
  if (!map) return undefined;
  let bestId: string | undefined;
  let bestAt = "";
  for (const [id, entry] of Object.entries(map)) {
    if (entry.lastExportedAt > bestAt) {
      bestAt = entry.lastExportedAt;
      bestId = id;
    }
  }
  return bestId;
}
