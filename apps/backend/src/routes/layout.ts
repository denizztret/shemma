import { Hono } from "hono";
import { config } from "../config";
import { layoutNodes } from "../layout-engine";
import { applyPatch } from "../patch";
import type { Rooms } from "../rooms";
import { DEFAULT_ROOM } from "../types";
import type { PatchBus, PatchOp, RoomState } from "../types";

export function layoutRoutes(
  rooms: Rooms,
  bus: PatchBus,
  opts: { onDirty?: (room: string, state: RoomState) => void } = {},
) {
  return new Hono().post("/api/layout", async (c) => {
    const id = c.req.query("room") ?? DEFAULT_ROOM;
    const body = await c.req.json().catch(() => ({}));
    const algorithm: "elk-layered" | "dagre" = body.algorithm ?? "elk-layered";
    const nodeIds: string[] | undefined = body.nodeIds;

    const r = await rooms.get(id);
    const nodes = nodeIds
      ? r.canvas.nodes.filter((n) => nodeIds.includes(n.id))
      : r.canvas.nodes;
    if (nodes.length === 0)
      return c.json({ ok: true, version: r.version, count: 0 });

    let positions: Record<string, { x: number; y: number }>;
    try {
      positions = await layoutNodes(nodes, r.canvas.edges, algorithm);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }

    const ops: PatchOp[] = Object.entries(positions).map(([nid, p]) => ({
      op: "update" as const,
      target: "node" as const,
      id: nid,
      set: { x: p.x, y: p.y },
    }));

    const result = applyPatch(r.canvas, ops);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 422);

    r.canvas = result.state;
    r.version += 1;
    r.opLog.push({ ops, source: "ai", version: r.version, at: Date.now() });
    if (r.opLog.length > config.opLogMaxSize) {
      r.opLog.splice(0, r.opLog.length - config.opLogMaxSize);
    }
    r.dirty = true;
    opts.onDirty?.(id, r);
    bus.publish(id, { ops, source: "ai", version: r.version });

    return c.json({ ok: true, version: r.version, count: ops.length });
  });
}
