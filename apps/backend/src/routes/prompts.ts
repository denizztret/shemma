import { Hono } from "hono";
import type { Rooms } from "../rooms";
import type { Prompt, RoomState } from "../types";
import { DEFAULT_ROOM } from "../types";
import type { WsHub } from "../ws";

export function promptRoutes(
  rooms: Rooms,
  hub: WsHub,
  opts: { onDirty?: (room: string, state: RoomState) => void } = {},
) {
  const r = new Hono();

  r.post("/api/prompt", async (c) => {
    const id = c.req.query("room") ?? DEFAULT_ROOM;
    const body = await c.req.json().catch(() => ({}));
    const p: Prompt = {
      id: crypto.randomUUID(),
      selection: body.selection ?? [],
      text: String(body.text ?? ""),
      createdAt: Date.now(),
      status: "pending",
    };
    const room = await rooms.get(id);
    room.prompts.push(p);
    room.dirty = true;
    opts.onDirty?.(id, room);
    hub.publishPrompt(id, p);
    return c.json(p);
  });

  r.get("/api/prompts", async (c) => {
    const id = c.req.query("room") ?? DEFAULT_ROOM;
    const status = c.req.query("status") ?? "pending";
    const room = await rooms.get(id);
    const prompts =
      status === "all"
        ? room.prompts
        : room.prompts.filter((p) => p.status === status);
    return c.json({ prompts });
  });

  r.post("/api/prompt/:id/resolve", async (c) => {
    const id = c.req.query("room") ?? DEFAULT_ROOM;
    const pid = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const room = await rooms.get(id);
    const p = room.prompts.find((x) => x.id === pid);
    if (!p) return c.json({ ok: false, error: "not found" }, 404);
    p.status = "resolved";
    p.response = body.response;
    p.resolvedAt = Date.now();
    room.dirty = true;
    opts.onDirty?.(id, room);
    hub.publishPromptResolved(id, pid, body.response);
    return c.json({ ok: true });
  });

  r.post("/api/prompt/:id/dismiss", async (c) => {
    const id = c.req.query("room") ?? DEFAULT_ROOM;
    const pid = c.req.param("id");
    const room = await rooms.get(id);
    const p = room.prompts.find((x) => x.id === pid);
    if (!p) return c.json({ ok: false, error: "not found" }, 404);
    p.status = "dismissed";
    p.resolvedAt = Date.now();
    room.dirty = true;
    opts.onDirty?.(id, room);
    hub.publishPromptResolved(id, pid);
    return c.json({ ok: true });
  });

  return r;
}
