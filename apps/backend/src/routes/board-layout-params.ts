import { Hono } from "hono";
import {
  applyLayoutParamsDefaults,
  validateLayoutParams,
  type LayoutParams,
} from "@shemma/domain";

export type BoardLayoutParamsDeps = {
  getRoom: (space: string, room: string) => Promise<{ meta?: Record<string, unknown> } | undefined>;
  persistRoom: (space: string, room: string) => void;
  broadcastRoomMeta: (space: string, room: string) => void;
};

export function boardLayoutParamsRoutes(deps: BoardLayoutParamsDeps) {
  return new Hono()
    .get("/api/board/layout-params", async (c) => {
      const space = c.req.query("space");
      const room = c.req.query("room");
      if (!space || !room) return c.json({ error: "space and room required" }, 400);

      const r = await deps.getRoom(space, room);
      const raw = (r?.meta?.layoutParams as Partial<LayoutParams> | undefined) ?? null;
      const effective = applyLayoutParamsDefaults(raw ?? {});
      return c.json({ raw, effective });
    })
    .post("/api/board/layout-params", async (c) => {
      const space = c.req.query("space");
      const room = c.req.query("room");
      if (!space || !room) return c.json({ error: "space and room required" }, 400);

      const body = await c.req.json<{
        params?: Partial<LayoutParams> | null;
      }>().catch(() => ({} as { params?: Partial<LayoutParams> | null }));
      const { params } = body;

      if (params !== null && params !== undefined) {
        try {
          validateLayoutParams(params);
        } catch (err) {
          return c.json({ error: (err as Error).message }, 400);
        }
      }

      const r = await deps.getRoom(space, room);
      if (!r) return c.json({ error: "room not found" }, 404);

      if (!r.meta) r.meta = {};
      const meta = r.meta as Record<string, unknown>;
      if (params === null || params === undefined) {
        delete meta.layoutParams;
      } else {
        meta.layoutParams = params;
      }

      deps.persistRoom(space, room);
      deps.broadcastRoomMeta(space, room);

      const effective = applyLayoutParamsDefaults((params ?? {}) as Partial<LayoutParams>);
      return c.json({ ok: true, effective });
    });
}
