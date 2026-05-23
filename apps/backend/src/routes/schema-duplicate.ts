/**
 * Schema duplicate + delete HTTP routes — DRW-134 Task 3.1.
 *
 * POST /api/schema/:frameId/duplicate  — клонирует schema-frame с deep identity remap.
 * DELETE /api/schema/:frameId          — удаляет schema-frame + всех детей.
 *
 * Паттерн идентичен apps/backend/src/routes/schema.ts:
 *   bundleForRequest → rooms → scheduleSave → bus.publish.
 */

import type { NodeId } from "@shemma/domain";
import { Hono } from "hono";
import { isV2Room, roomSuffixLength } from "../domain/schema/detect";
import { duplicateSchemaFrame, buildDeleteSchemaFrameBatch } from "../domain/schema/duplicate";
import { config } from "../config";
import { pushOpLog, resolveRoomId } from "../rooms";
import { applyStoreChanges, isEmptyBatch, rebuildDidrawIndex } from "../store-ops";
import type { TLRecord } from "../store-types";
import type { StoreChangeBus } from "../types";
import { bundleForRequest } from "./_space-context";

// ---- Response types ----

type DuplicateResponse =
  | { ok: true; newFrameId: string; nodeIdMap: Record<NodeId, NodeId> }
  | { ok: false; error: string; code?: string };

type DeleteResponse =
  | { ok: true }
  | { ok: false; error: string; code?: string };

// ---- Route factory ----

export function schemaDuplicateRoutes(bus: StoreChangeBus) {
  return new Hono()

    // =========================================================================
    // POST /api/schema/:frameId/duplicate
    // Клонирует frame с deep identity remap. Принимает опциональный newLabel.
    // =========================================================================
    .post("/api/schema/:frameId/duplicate", async (c) => {
      const rv = resolveRoomId(c.req.query("room"));
      if (!rv.ok) {
        return c.json(
          { ok: false, error: rv.reason, code: "invalid-room" } satisfies DuplicateResponse,
          422,
        );
      }
      const id = rv.id;
      const frameId = c.req.param("frameId");

      const body = (await c.req.json().catch(() => null)) as {
        newLabel?: string;
      } | null;

      const { rooms, scheduleSave, space } = bundleForRequest(c);
      const spaceId = space.id;
      const room = await rooms.get(id);

      // v2 check
      if (!isV2Room(room)) {
        return c.json(
          { ok: false, error: "room is not a v2 schema room; create a schema-frame first", code: "legacy-room-not-v2" } satisfies DuplicateResponse,
          422,
        );
      }

      // Lookup frame
      const store = room.store.store as Record<string, TLRecord | undefined>;
      const frame = store[frameId];
      if (!frame || frame.typeName !== "shape") {
        return c.json(
          { ok: false, error: `schema-frame '${frameId}' not found`, code: "frame-not-found" } satisfies DuplicateResponse,
          404,
        );
      }
      if (frame.meta?.didrawSchemaFrame !== true) {
        return c.json(
          { ok: false, error: `shape '${frameId}' is not a schema-frame`, code: "not-schema-frame" } satisfies DuplicateResponse,
          422,
        );
      }

      const suffixLen = roomSuffixLength(room);

      // Оригинальный label как fallback если newLabel не передан
      const originalLabel = typeof (frame.props as { name?: unknown })?.name === "string"
        ? (frame.props as { name: string }).name
        : "Schema";
      const newLabel = (body?.newLabel && typeof body.newLabel === "string")
        ? body.newLabel
        : `${originalLabel} (copy)`;

      // Выполняем дубликацию
      const result = duplicateSchemaFrame({ room, oldFrame: frame, newLabel, suffixLen });

      // Persist
      if (!isEmptyBatch(result.batch)) {
        room.store = applyStoreChanges(room.store, result.batch);
        room.didrawIndex = rebuildDidrawIndex(room.store);
        room.version += 1;
        pushOpLog(
          room,
          { ops: result.batch, source: "ai", version: room.version, at: Date.now() },
          config.opLogMaxSize,
        );
        room.dirty = true;
        scheduleSave(id, room);
        bus.publish(spaceId, id, {
          changes: result.batch,
          source: "ai",
          version: room.version,
        });
      }

      return c.json({
        ok: true,
        newFrameId: result.newFrameId,
        nodeIdMap: result.nodeIdMap,
      } satisfies DuplicateResponse);
    })

    // =========================================================================
    // DELETE /api/schema/:frameId
    // Удаляет schema-frame и всех его детей.
    // =========================================================================
    .delete("/api/schema/:frameId", async (c) => {
      const rv = resolveRoomId(c.req.query("room"));
      if (!rv.ok) {
        return c.json(
          { ok: false, error: rv.reason, code: "invalid-room" } satisfies DeleteResponse,
          422,
        );
      }
      const id = rv.id;
      const frameId = c.req.param("frameId");

      const { rooms, scheduleSave, space } = bundleForRequest(c);
      const spaceId = space.id;
      const room = await rooms.get(id);

      // v2 check
      if (!isV2Room(room)) {
        return c.json(
          { ok: false, error: "room is not a v2 schema room", code: "legacy-room-not-v2" } satisfies DeleteResponse,
          422,
        );
      }

      // Lookup frame
      const store = room.store.store as Record<string, TLRecord | undefined>;
      const frame = store[frameId];
      if (!frame || frame.typeName !== "shape") {
        return c.json(
          { ok: false, error: `schema-frame '${frameId}' not found`, code: "frame-not-found" } satisfies DeleteResponse,
          404,
        );
      }
      if (frame.meta?.didrawSchemaFrame !== true) {
        return c.json(
          { ok: false, error: `shape '${frameId}' is not a schema-frame`, code: "not-schema-frame" } satisfies DeleteResponse,
          422,
        );
      }

      // Build delete batch
      const batch = buildDeleteSchemaFrameBatch({ room, frame });

      // Persist
      if (!isEmptyBatch(batch)) {
        room.store = applyStoreChanges(room.store, batch);
        room.didrawIndex = rebuildDidrawIndex(room.store);
        room.version += 1;
        pushOpLog(
          room,
          { ops: batch, source: "ai", version: room.version, at: Date.now() },
          config.opLogMaxSize,
        );
        room.dirty = true;
        scheduleSave(id, room);
        bus.publish(spaceId, id, {
          changes: batch,
          source: "ai",
          version: room.version,
        });
      }

      return c.json({ ok: true } satisfies DeleteResponse);
    });
}
