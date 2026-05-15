import { Hono } from "hono";
import type { Rooms } from "../rooms";
import { DEFAULT_ROOM } from "../types";
import type { WsHub } from "../ws";

// Stale activity records auto-clear after this window so a crashed/zombie
// subagent that never called /api/ai/stop doesn't leave the badge spinning.
const STALE_MS = 5 * 60 * 1000;

export function aiRoutes(rooms: Rooms, bus: WsHub) {
  return new Hono()
    .post("/api/ai/start", async (c) => {
      const room = c.req.query("room") ?? DEFAULT_ROOM;
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
      const r = await rooms.get(room);
      const activity = {
        actor: body.actor,
        task: body.task,
        startedAt: Date.now(),
      };
      r.aiActivity = activity;
      bus.publishAiActivity(room, activity);
      return c.json({ ok: true });
    })
    .post("/api/ai/stop", async (c) => {
      const room = c.req.query("room") ?? DEFAULT_ROOM;
      const r = await rooms.get(room);
      r.aiActivity = undefined;
      bus.publishAiActivity(room, null);
      return c.json({ ok: true });
    })
    .get("/api/ai/activity", async (c) => {
      const room = c.req.query("room") ?? DEFAULT_ROOM;
      const r = await rooms.get(room);
      // Auto-expire stale records on read so clients querying after a zombie
      // don't see indefinite "AI is busy" state.
      if (r.aiActivity && Date.now() - r.aiActivity.startedAt > STALE_MS) {
        r.aiActivity = undefined;
        bus.publishAiActivity(room, null);
      }
      return c.json({ activity: r.aiActivity ?? null });
    });
}
