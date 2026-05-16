import { Hono } from "hono";
import { buildContext } from "../domain/context";
import type { Viewport } from "../domain/context";
import { resolveRoomId } from "../rooms";
import type { Rooms } from "../rooms";

function parseViewport(s: string | undefined): Viewport {
  if (!s) return null;
  const parts = s.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  return { x, y, w, h };
}

export function contextRoutes(rooms: Rooms) {
  return new Hono().get("/api/agent/context", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;
    const queryViewport = parseViewport(c.req.query("viewport"));
    const storedViewport = rooms.getViewport(id);
    const viewport: Viewport = queryViewport ?? storedViewport ?? null;
    const room = await rooms.get(id);
    const selection = c.req.query("select")?.split(",").filter(Boolean) ?? [];
    const sinceRaw = c.req.query("since");
    const since = sinceRaw !== undefined ? Number(sinceRaw) : undefined;
    if (since !== undefined && !Number.isFinite(since)) {
      return c.json({ ok: false, error: "invalid since param" }, 400);
    }
    const ctx = buildContext(room, { viewport, selection, since });
    return c.json({ ok: true, ...ctx });
  });
}
