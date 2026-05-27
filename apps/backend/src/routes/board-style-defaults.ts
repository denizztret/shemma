import { Hono } from "hono";
import {
  applyStyleDefaultsResolution,
  validateStyleDefaults,
  type StyleDefaults,
} from "@shemma/domain";

export type BoardStyleDefaultsDeps = {
  getRoom: (
    space: string,
    room: string,
  ) => Promise<{ meta?: Record<string, unknown> } | undefined>;
  persistRoom: (space: string, room: string) => void;
  broadcastRoomMeta: (space: string, room: string) => void;
};

export function boardStyleDefaultsRoutes(deps: BoardStyleDefaultsDeps) {
  return new Hono()
    .get("/api/board/style-defaults", async (c) => {
      const space = c.req.query("space");
      const room = c.req.query("room");
      if (!space || !room) {
        return c.json({ error: "space and room required" }, 400);
      }

      const r = await deps.getRoom(space, room);
      const raw =
        (r?.meta?.styleDefaults as StyleDefaults | undefined) ?? null;
      const effective = applyStyleDefaultsResolution(raw ? [raw] : []);
      return c.json({ raw, effective });
    })
    .post("/api/board/style-defaults", async (c) => {
      const space = c.req.query("space");
      const room = c.req.query("room");
      if (!space || !room) {
        return c.json({ error: "space and room required" }, 400);
      }

      const body = await c.req
        .json<{ defaults?: StyleDefaults | null }>()
        .catch(() => ({}) as { defaults?: StyleDefaults | null });
      const defaults = body.defaults;

      if (defaults !== null && defaults !== undefined) {
        try {
          validateStyleDefaults(defaults);
        } catch (err) {
          return c.json({ error: (err as Error).message }, 400);
        }
      }

      const r = await deps.getRoom(space, room);
      if (!r) return c.json({ error: "room not found" }, 404);

      if (!r.meta) r.meta = {};
      const meta = r.meta as Record<string, unknown>;
      if (defaults === null || defaults === undefined) {
        delete meta.styleDefaults;
      } else {
        meta.styleDefaults = defaults;
      }

      deps.persistRoom(space, room);
      deps.broadcastRoomMeta(space, room);

      const effective = applyStyleDefaultsResolution(
        defaults ? [defaults] : [],
      );
      return c.json({ ok: true, effective });
    });
}
