import { Hono } from "hono";
import { applyLayoutParamsDefaults, type LayoutParams } from "@shemma/domain";

export type BoardLayoutParamsDeps = {
  getRoom: (space: string, room: string) => { meta?: Record<string, unknown> } | undefined;
  persistRoom: (space: string, room: string) => void;
  broadcastRoomMeta: (space: string, room: string) => void;
};

export function boardLayoutParamsRoutes(deps: BoardLayoutParamsDeps) {
  return new Hono().get("/api/board/layout-params", (c) => {
    const space = c.req.query("space");
    const room = c.req.query("room");
    if (!space || !room) return c.json({ error: "space and room required" }, 400);

    const r = deps.getRoom(space, room);
    const raw = (r?.meta?.layoutParams as Partial<LayoutParams> | undefined) ?? null;
    const effective = applyLayoutParamsDefaults(raw ?? {});
    return c.json({ raw, effective });
  });
}
