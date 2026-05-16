import { Hono } from "hono";
import { buildContext } from "../domain/context";
import { resolveRoomId } from "../rooms";
import type { Rooms } from "../rooms";

export function contextRoutes(rooms: Rooms) {
  return new Hono().get("/api/agent/context", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;
    const sinceRaw = c.req.query("since");
    const since = sinceRaw !== undefined ? Number(sinceRaw) : undefined;
    if (since !== undefined && !Number.isFinite(since)) {
      return c.json({ ok: false, error: "invalid since param" }, 400);
    }
    const include = c.req.query("include");
    const includeGeometry = include === "geometry";
    const room = await rooms.get(id);
    const view = buildContext(
      room.store,
      { since, includeGeometry },
      room.version,
    );
    return c.json({ ok: true, ...view });
  });
}
