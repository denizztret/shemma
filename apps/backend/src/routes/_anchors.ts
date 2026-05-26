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

import type { LayoutParams } from "@shemma/domain";
import { config } from "../config";
import { computeAnchors } from "../domain/anchors";
import { computeElbowMidpoints } from "../domain/midpoints";
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
  // Step 1: compute and apply anchors (sets didrawSourcePort / didrawTargetPort on arrows).
  const anchorsBatch = computeAnchors(room.store);
  if (!isEmptyBatch(anchorsBatch)) {
    room.store = applyStoreChanges(room.store, anchorsBatch);
    room.didrawIndex = rebuildDidrawIndex(room.store);
    room.version += 1;
    pushOpLog(
      room,
      { ops: anchorsBatch, source: "ai", version: room.version, at: Date.now() },
      config.opLogMaxSize,
    );
    room.dirty = true;
    scheduleSave(roomId, room);
    bus.publish(spaceId, roomId, {
      changes: anchorsBatch,
      source: "ai",
      version: room.version,
    });
  }

  // Step 2: compute and apply midpoints — runs on post-anchor store so port meta is visible.
  // DRW-178: distributes elbowMidPoint among arrows sharing the same port pair.
  const midpointsBatch = computeElbowMidpoints(room.store);
  if (!isEmptyBatch(midpointsBatch)) {
    room.store = applyStoreChanges(room.store, midpointsBatch);
    room.didrawIndex = rebuildDidrawIndex(room.store);
    room.version += 1;
    pushOpLog(
      room,
      { ops: midpointsBatch, source: "ai", version: room.version, at: Date.now() },
      config.opLogMaxSize,
    );
    room.dirty = true;
    scheduleSave(roomId, room);
    bus.publish(spaceId, roomId, {
      changes: midpointsBatch,
      source: "ai",
      version: room.version,
    });
  }
}
