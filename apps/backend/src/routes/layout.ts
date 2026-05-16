import { Hono } from "hono";
import { config } from "../config";
import { runLayout } from "../domain/layout";
import { resolveRoomId } from "../rooms";
import type { Rooms } from "../rooms";
import { applyStoreChanges, rebuildDidrawIndex } from "../store-ops";
import type { RoomState, StoreChangeBus } from "../types";

export function layoutRoutes(
  rooms: Rooms,
  bus: StoreChangeBus,
  opts: { onDirty?: (room: string, state: RoomState) => void } = {},
) {
  return new Hono().post("/api/layout", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;
    const body = (await c.req.json().catch(() => ({}))) as {
      mode?: string;
      scope?: string;
      spacing?: string;
    };

    const r = await rooms.get(id);

    const hint = {
      mode: (body.mode ?? "layered-lr") as never,
      scope: (body.scope ?? "all") as never,
      spacing: (body.spacing ?? "normal") as never,
    };

    let lr: Awaited<ReturnType<typeof runLayout>>;
    try {
      lr = await runLayout(r.store, hint, r.didrawIndex);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
    if (lr.reason) {
      return c.json({ ok: false, error: lr.reason }, 500);
    }
    const count = Object.keys(lr.batch.updated).length;
    if (count === 0) {
      return c.json({ ok: true, version: r.version, count: 0 });
    }

    r.store = applyStoreChanges(r.store, lr.batch);
    r.didrawIndex = rebuildDidrawIndex(r.store);
    r.version += 1;
    r.opLog.push({ ops: lr.batch, source: "ai", version: r.version, at: Date.now() });
    if (r.opLog.length > config.opLogMaxSize) {
      r.opLog.splice(0, r.opLog.length - config.opLogMaxSize);
    }
    r.dirty = true;
    opts.onDirty?.(id, r);
    bus.publish(id, { changes: lr.batch, source: "ai", version: r.version });

    return c.json({ ok: true, version: r.version, count });
  });
}
