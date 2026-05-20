// apps/backend/src/export/miro/tracking.ts
//
// DRW-103: room.meta.miroExports CRUD for per-board export tracking.
// All ops mutate `RoomState.meta` in place; persistence handled by daemon
// via scheduleSave (caller responsibility).

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

/** Read full tracking entry for a board, or undefined if none. */
export function readBoardTracking(
  room: RoomState,
  boardId: string,
): MiroExportsMap[string] | undefined {
  return room.meta?.miroExports?.[boardId];
}

/** Read just the items map for a board (empty {} when absent). */
export function readBoardItems(
  room: RoomState,
  boardId: string,
): Record<string, string> {
  return room.meta?.miroExports?.[boardId]?.items ?? {};
}

/** Read connectors map for a board (empty {} when absent). */
export function readBoardConnectors(
  room: RoomState,
  boardId: string,
): Record<string, string> {
  return room.meta?.miroExports?.[boardId]?.connectors ?? {};
}

/**
 * Merge new mappings into tracking. Updates lastExportedAt to now().
 * Idempotent: re-running with the same mappings overwrites entries.
 */
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

/** Return boardId with the most recent export, or undefined. */
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
