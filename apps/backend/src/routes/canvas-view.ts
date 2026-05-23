// apps/backend/src/routes/canvas-view.ts
// GET /api/canvas/view — polymorphic v1/v2 canvas view handler (DRW-134 Task 1.5).
// v1 rooms (no didrawProtocol="v2" marker): returns legacy domain summary wrapped in { schemaVersion:"v1", legacy: {...} }.
// v2 rooms: placeholder 501 until Task 2.1 implements full reader.

import { Hono } from "hono";
import { buildContext } from "../domain/context";
import { isV2Room } from "../domain/schema/detect";
import { buildCanvasView } from "../domain/schema/view";
import { resolveRoomId } from "../rooms";
import { bundleForRequest } from "./_space-context";

export function canvasViewRoutes() {
  return new Hono().get("/api/canvas/view", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);

    const { rooms } = bundleForRequest(c);
    const room = await rooms.get(rv.id);

    if (!isV2Room(room)) {
      // Legacy path: wrap existing /api/agent/context payload per spec §Legacy view shape.
      // Reproduces exact body shape from context.ts:20-25:
      //   buildContext(room.store, {}, room.version) → DomainView (ok:true, ...view).
      // На v2 endpoint оборачиваем в поле `legacy`, добавляем top-level schemaVersion.
      const view = buildContext(room.store, {}, room.version);
      return c.json({
        schemaVersion: "v1" as const,
        legacy: { ok: true, ...view },
        hint: "room uses legacy protocol; upgrade to v2 via shemma room set-meta didrawProtocol=v2 + create schema-frame",
      });
    }

    // v2 path — полный reader (Task 2.1).
    return c.json(buildCanvasView(room));
  });
}
