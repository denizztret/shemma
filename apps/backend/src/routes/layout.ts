import { Hono } from "hono";
import { config } from "../config";
import { runLayout } from "../domain/layout";
import { pushOpLog, resolveRoomId } from "../rooms";
import { applyStoreChanges, rebuildDidrawIndex } from "../store-ops";
import type { StoreChangeBus } from "../types";
import { runAndBroadcastAnchors } from "./_anchors";
import { bundleForRequest } from "./_space-context";

export function layoutRoutes(bus: StoreChangeBus) {
  return new Hono().post("/api/layout", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;
    const body = (await c.req.json().catch(() => ({}))) as {
      mode?: string;
      scope?: string;
      spacing?: string;
    };

    const { rooms, scheduleSave, space } = bundleForRequest(c);
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
    pushOpLog(
      r,
      { ops: lr.batch, source: "ai", version: r.version, at: Date.now() },
      config.opLogMaxSize,
    );
    r.dirty = true;
    scheduleSave(id, r);
    bus.publish(space.id, id, {
      changes: lr.batch,
      source: "ai",
      version: r.version,
    });

    // DRW-172: post-layout anchor distribution.
    runAndBroadcastAnchors(r, bus, space.id, id, scheduleSave);

    return c.json({ ok: true, version: r.version, count });
  });
}
