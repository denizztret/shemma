import { Hono } from "hono";
import { config } from "../config";
import { applyPatch } from "../patch";
import { resolveRoomId } from "../rooms";
import type { Rooms } from "../rooms";
import type { CanvasState, PatchBus, PatchOp, RoomState } from "../types";

// Apply inference AFTER we have current room state, so partial updates
// (only x or only y, or only one style field) preserve the unchanged axis
// using the current node values rather than producing `undefined`.
function inferUserMetadata(ops: PatchOp[], canvas: CanvasState): PatchOp[] {
  return ops.map((op) => {
    if (op.op !== "update") return op;
    if (op.target === "node") {
      const { set } = op;
      const movedX = set.x !== undefined;
      const movedY = set.y !== undefined;
      const styled = set.style !== undefined;
      if (!movedX && !movedY && !styled) return op;

      const current = canvas.nodes.find((n) => n.id === op.id);
      const currentMeta = current?.meta ?? {};
      const currentPos = currentMeta.position as { x?: number; y?: number } | undefined;
      // Deep-merge for meta — applyPatch shallow-merges nested objects, so we
      // build the FULL new meta.position here rather than relying on merge.
      const meta: Record<string, unknown> = { ...currentMeta, ...(set.meta ?? {}) };
      if (movedX || movedY) {
        meta.pinned = true;
        meta.position = {
          x: movedX ? (set.x as number) : (currentPos?.x ?? current?.x ?? 0),
          y: movedY ? (set.y as number) : (currentPos?.y ?? current?.y ?? 0),
        };
      }
      if (styled) {
        meta.styleOwnedBy = "user";
      }
      return { ...op, set: { ...set, meta } };
    }
    if (op.target === "edge") {
      const { set } = op;
      if (set.style === undefined) return op;
      const current = canvas.edges.find((e) => e.id === op.id);
      const meta: Record<string, unknown> = {
        ...(current?.meta ?? {}),
        ...(set.meta ?? {}),
        styleOwnedBy: "user",
      };
      return { ...op, set: { ...set, meta } };
    }
    return op;
  });
}

export function patchRoutes(
  rooms: Rooms,
  bus: PatchBus,
  opts: { onDirty?: (room: string, state: RoomState) => void } = {},
) {
  return new Hono().post("/api/patch", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.ops))
      return c.json({ ok: false, error: "expected {ops,source}" }, 400);

    const source: "ai" | "user" = body.source === "ai" ? "ai" : "user";
    const clientOpId: string | undefined = body.clientOpId;
    const r = await rooms.get(id);

    // Phase 2.1 §6.2: user-source updates infer pin + style ownership.
    // MUST run AFTER rooms.get() — we need current x/y for partial moves.
    let ops = body.ops as PatchOp[];
    if (source === "user") ops = inferUserMetadata(ops, r.canvas);

    if (clientOpId && r.opLog.some((e) => e.clientOpId === clientOpId)) {
      return c.json({ ok: true, version: r.version, idempotent: true });
    }

    const result = applyPatch(r.canvas, ops);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 422);

    r.canvas = result.state;
    r.version += 1;
    r.opLog.push({ ops, source, version: r.version, at: Date.now(), clientOpId });
    if (r.opLog.length > config.opLogMaxSize)
      r.opLog.splice(0, r.opLog.length - config.opLogMaxSize);
    r.dirty = true;
    opts.onDirty?.(id, r);
    bus.publish(id, { ops, source, version: r.version, originClientId: clientOpId });

    return c.json({ ok: true, version: r.version });
  });
}
