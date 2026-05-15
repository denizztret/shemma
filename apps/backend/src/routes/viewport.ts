import { Hono } from "hono";
import type { Rooms } from "../rooms";
import { resolveRoomId } from "../rooms";

export function viewportRoutes(rooms: Rooms) {
  const app = new Hono();

  app.post("/api/viewport", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const body = (await c.req.json().catch(() => null)) as
      | { x?: number; y?: number; w?: number; h?: number; zoom?: number }
      | null;
    if (!body || typeof body.x !== "number" || typeof body.y !== "number" || typeof body.w !== "number" || typeof body.h !== "number") {
      return c.json({ ok: false, error: "expected {x,y,w,h,zoom?}" }, 400);
    }
    rooms.setViewport(rv.id, { x: body.x, y: body.y, w: body.w, h: body.h, zoom: body.zoom });
    return c.json({ ok: true });
  });

  app.get("/api/viewport", (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    return c.json({ ok: true, viewport: rooms.getViewport(rv.id) });
  });

  return app;
}
