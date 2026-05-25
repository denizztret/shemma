// apps/backend/src/routes/_anchors.ts
//
// DRW-172: Post-layout anchor distribution helper.
//
// Single call to run after each runLayout in any endpoint that mutates
// shape positions. Computes per-edge normalizedAnchor + isPrecise=true for
// all arrows in the room and broadcasts as an "ai" source change.
//
// Idempotent: no-op when computeAnchors returns an empty batch (already-
// correct stores stay quiet).

import { config } from "../config";
import { computeAnchors } from "../domain/anchors";
import { pushOpLog } from "../rooms";
import {
  applyStoreChanges,
  isEmptyBatch,
  rebuildDidrawIndex,
} from "../store-ops";
import type { RoomState, StoreChangeBus } from "../types";

export function runAndBroadcastAnchors(
  room: RoomState,
  bus: StoreChangeBus,
  spaceId: string,
  roomId: string,
  scheduleSave: (id: string, room: RoomState) => void,
): void {
  const batch = computeAnchors(room.store);
  if (isEmptyBatch(batch)) return;
  room.store = applyStoreChanges(room.store, batch);
  room.didrawIndex = rebuildDidrawIndex(room.store);
  room.version += 1;
  pushOpLog(
    room,
    { ops: batch, source: "ai", version: room.version, at: Date.now() },
    config.opLogMaxSize,
  );
  room.dirty = true;
  scheduleSave(roomId, room);
  bus.publish(spaceId, roomId, {
    changes: batch,
    source: "ai",
    version: room.version,
  });
}
