import { Hono } from "hono";
import { config } from "../config";
import { applyPatch } from "../patch";
import type { Rooms } from "../rooms";
import type { PatchOp } from "../types";

export type PatchBus = {
  publish: (
    room: string,
    msg: {
      ops: PatchOp[];
      source: "ai" | "user";
      version: number;
      originClientId?: string;
    },
  ) => void;
};

export function patchRoutes(
  rooms: Rooms,
  bus: PatchBus,
  opts: { onDirty?: (room: string) => void } = {},
) {
  return new Hono().post("/api/patch", async (c) => {
    const id = c.req.query("room") ?? "default";
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.ops))
      return c.json({ ok: false, error: "expected {ops,source}" }, 400);

    const ops = body.ops as PatchOp[];
    const source = (body.source ?? "user") as "ai" | "user";
    const clientOpId: string | undefined = body.clientOpId;
    const r = await rooms.get(id);
    rooms.touch(id);

    if (clientOpId && r.opLog.some((e) => e.clientOpId === clientOpId)) {
      return c.json({ ok: true, version: r.version, idempotent: true });
    }

    const result = applyPatch(r.canvas, ops);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 422);

    r.canvas = result.state;
    r.version += 1;
    r.opLog.push({
      ops,
      source,
      version: r.version,
      at: Date.now(),
      clientOpId,
    });
    if (r.opLog.length > config.opLogMaxSize)
      r.opLog.splice(0, r.opLog.length - config.opLogMaxSize);
    r.dirty = true;
    opts.onDirty?.(id);
    bus.publish(id, {
      ops,
      source,
      version: r.version,
      originClientId: clientOpId,
    });

    return c.json({ ok: true, version: r.version });
  });
}
