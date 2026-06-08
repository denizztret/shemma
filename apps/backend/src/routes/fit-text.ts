import { Hono } from "hono";
import { resolveRoomId } from "../rooms";
import type { WsHub } from "../ws";
import { bundleForRequest } from "./_space-context";

/**
 * POST /api/agent/fit-text  (DRW-228)
 *
 * Sends a fit-text command to the first connected WS subscriber in the room,
 * waits up to 10s for the frontend result. Text measurement needs tldraw font
 * metrics (browser-only), so — like import-mermaid — this requires an open tab.
 *
 * Body: { targets?: string[]; clientOpId? }
 *   targets — shape ids or didrawNames to fit; omitted → all fittable geo/note
 *   shapes the user has not size-pinned.
 * Query: ?room=<room-id>
 *
 * Responses:
 *  200 { ok: true, count, shape_ids }
 *  503 { error: "no client connected", room_url } — open `room_url` and retry.
 *  500 timeout or frontend error
 */
export function fitTextRoutes(bus: WsHub) {
  return new Hono().post("/api/agent/fit-text", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ error: rv.reason }, 422);
    const room = rv.id;

    const body = (await c.req.json().catch(() => null)) as {
      targets?: unknown;
    } | null;

    const targets: string[] | undefined =
      body && Array.isArray(body.targets)
        ? body.targets.filter((t): t is string => typeof t === "string")
        : undefined;

    const { space } = bundleForRequest(c);
    if (bus.subscriberCount(space.id, room) === 0) {
      const reqUrl = new URL(c.req.url);
      const roomUrl = `${reqUrl.protocol}//${reqUrl.host}/?room=${encodeURIComponent(room)}`;
      return c.json({ error: "no client connected", room_url: roomUrl }, 503);
    }

    const requestId = crypto.randomUUID();

    try {
      const result = await bus.sendFitText(space.id, room, requestId, targets);
      if (!result.ok) {
        return c.json({ error: result.error ?? "fit-text failed" }, 500);
      }
      return c.json({
        ok: true,
        count: result.count ?? 0,
        shape_ids: result.shape_ids ?? [],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return c.json({ error: message }, 500);
    }
  });
}
