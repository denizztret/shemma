import { Hono } from "hono";
import { resolveRoomId } from "../rooms";
import type { WsHub } from "../ws";
import { bundleForRequest } from "./_space-context";

// Stale activity records auto-clear after this window so a crashed/zombie
// subagent that never called /api/ai/stop doesn't leave the badge spinning.
const STALE_MS = 5 * 60 * 1000;

export function aiRoutes(bus: WsHub) {
  return new Hono()
    .post("/api/ai/start", async (c) => {
      const rv = resolveRoomId(c.req.query("room"));
      if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
      const room = rv.id;
      const body = (await c.req.json().catch(() => null)) as {
        actor?: string;
        task?: string;
      } | null;
      if (!body?.actor || !body?.task) {
        return c.json(
          { ok: false, error: "expected {actor,task}" },
          400 as const,
        );
      }
      const { rooms, space } = bundleForRequest(c);
      const r = await rooms.get(room);
      const activity = {
        actor: body.actor,
        task: body.task,
        startedAt: Date.now(),
      };
      r.aiActivity = activity;
      bus.publishAiActivity(space.id, room, activity);
      return c.json({ ok: true });
    })
    .post("/api/ai/stop", async (c) => {
      const rv = resolveRoomId(c.req.query("room"));
      if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
      const room = rv.id;
      const { rooms, space } = bundleForRequest(c);
      const r = await rooms.get(room);
      r.aiActivity = undefined;
      bus.publishAiActivity(space.id, room, null);
      return c.json({ ok: true });
    })
    .get("/api/ai/activity", async (c) => {
      const rv = resolveRoomId(c.req.query("room"));
      if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
      const room = rv.id;
      const { rooms, space } = bundleForRequest(c);
      const r = await rooms.get(room);
      // Auto-expire stale records on read so clients querying after a zombie
      // don't see indefinite "AI is busy" state.
      if (r.aiActivity && Date.now() - r.aiActivity.startedAt > STALE_MS) {
        r.aiActivity = undefined;
        bus.publishAiActivity(space.id, room, null);
      }
      return c.json({ activity: r.aiActivity ?? null });
    });
}
