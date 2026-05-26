// apps/backend/src/routes/smart-insert.ts
// DRW-178 Task 4.2: light-insert endpoint — find an empty slot in a container
// and return parent-local coordinates without re-running full layout.

import { Hono } from "hono";
import { resolveRoomId } from "../rooms";
import { computeExpansion, findEmptySlot } from "../domain/empty-space";
import type { StoreChangeBus } from "../types";
import type { TLRecord } from "../store-types";
import { bundleForRequest } from "./_space-context";

type Direction = "TB" | "BT" | "LR" | "RL";

const VALID_DIRECTIONS = new Set<Direction>(["TB", "BT", "LR", "RL"]);

export function smartInsertRoutes(_bus: StoreChangeBus) {
  return new Hono().post("/api/smart-insert", async (c) => {
    // ── 1. Validate room ────────────────────────────────────────────────────
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) {
      return c.json({ ok: false, error: rv.reason }, 422);
    }
    const id = rv.id;

    // ── 2. Parse and validate body ──────────────────────────────────────────
    const body = (await c.req.json().catch(() => ({}))) as {
      containerId?: unknown;
      size?: { w?: unknown; h?: unknown };
      biasDirection?: unknown;
      padding?: unknown;
    };

    if (typeof body.containerId !== "string" || body.containerId.length === 0) {
      return c.json(
        { ok: false, error: "containerId (string) is required" },
        400,
      );
    }
    if (
      !body.size ||
      typeof body.size.w !== "number" ||
      typeof body.size.h !== "number"
    ) {
      return c.json(
        { ok: false, error: "size {w, h} (numbers) is required" },
        400,
      );
    }
    if (body.size.w <= 0 || body.size.h <= 0) {
      return c.json(
        { ok: false, error: "size.w and size.h must be positive" },
        400,
      );
    }

    const requestedSize = { w: body.size.w, h: body.size.h };
    const padding =
      typeof body.padding === "number" && body.padding >= 0
        ? body.padding
        : 20;

    // ── 3. Load room state ──────────────────────────────────────────────────
    const { rooms } = bundleForRequest(c);
    const r = await rooms.get(id);

    // ── 4. Resolve container shape ──────────────────────────────────────────
    type ShapeRec = TLRecord & {
      type?: string;
      x?: number;
      y?: number;
      parentId?: string;
      props?: { w?: number; h?: number; direction?: string };
      meta?: { didrawDirection?: string };
    };

    const container = r.store.store[body.containerId] as ShapeRec | undefined;
    if (!container || container.typeName !== "shape") {
      return c.json({ ok: false, error: "container not found" }, 404);
    }

    const parentSize = {
      w: typeof container.props?.w === "number" ? container.props.w : 0,
      h: typeof container.props?.h === "number" ? container.props.h : 0,
    };
    if (parentSize.w <= 0 || parentSize.h <= 0) {
      return c.json(
        { ok: false, error: "container has no usable bounds" },
        422,
      );
    }

    // ── 5. Collect occupant shapes ──────────────────────────────────────────
    // Only direct children that occupy rectangular space. Arrows are routing
    // overlays and should not block slot search.
    const occupants: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const recId in r.store.store) {
      const rec = r.store.store[recId] as ShapeRec | undefined;
      if (!rec || rec.typeName !== "shape") continue;
      if (rec.parentId !== body.containerId) continue;
      if (rec.type === "arrow" || rec.type === "routed-arrow") continue;
      const w = typeof rec.props?.w === "number" ? rec.props.w : 0;
      const h = typeof rec.props?.h === "number" ? rec.props.h : 0;
      if (w <= 0 || h <= 0) continue;
      occupants.push({
        x: typeof rec.x === "number" ? rec.x : 0,
        y: typeof rec.y === "number" ? rec.y : 0,
        w,
        h,
      });
    }

    // ── 6. Try to find an empty slot ────────────────────────────────────────
    const slot = findEmptySlot(parentSize, occupants, requestedSize, padding);
    if (slot) {
      return c.json({ ok: true, position: slot, expansion: null });
    }

    // ── 7. No slot → compute expansion ─────────────────────────────────────
    // Resolve direction: body param > container meta > container props > default TB.
    const direction: Direction = VALID_DIRECTIONS.has(
      body.biasDirection as Direction,
    )
      ? (body.biasDirection as Direction)
      : VALID_DIRECTIONS.has(
            container.meta?.didrawDirection as Direction,
          )
        ? (container.meta!.didrawDirection as Direction)
        : VALID_DIRECTIONS.has(container.props?.direction as Direction)
          ? (container.props!.direction as Direction)
          : "TB";

    const expansion = computeExpansion(
      parentSize,
      requestedSize,
      padding,
      direction,
    );
    return c.json({
      ok: true,
      position: expansion.position,
      expansion: { dw: expansion.dw, dh: expansion.dh },
    });
  });
}
