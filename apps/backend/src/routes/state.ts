import { Hono } from "hono";
import { resolveRoomId } from "../rooms";
import type { Rooms } from "../rooms";

export function stateRoutes(rooms: Rooms) {
  return new Hono().get("/api/state", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;
    const sinceRaw = c.req.query("since");
    const r = await rooms.get(id);

    if (sinceRaw !== undefined && !Number.isNaN(Number(sinceRaw))) {
      const since = Number(sinceRaw);
      // opLog is in-memory only (lost on restart). If the requested window
      // predates the oldest retained entry, we cannot honour incremental sync —
      // signal `truncated:true` so the client knows to fetch a full snapshot
      // instead of silently treating the gap as no-op.
      const minLogVersion = r.opLog[0]?.version;
      const canServe =
        since >= r.version ||
        (minLogVersion !== undefined && minLogVersion <= since + 1);
      if (!canServe) {
        return c.json({ since, version: r.version, truncated: true });
      }
      return c.json({
        since,
        version: r.version,
        diff: r.opLog.filter((e) => e.version > since),
      });
    }

    return c.json({
      version: r.version,
      store: r.store,
      prompts: r.prompts,
      aiActivity: r.aiActivity ?? null,
    });
  });
}
