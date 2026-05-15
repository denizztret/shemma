import { Hono } from "hono";
import { config } from "../config";
import { compile } from "../domain/compile";
import { runLayout } from "../domain/layout";
import { postProcess } from "../domain/layout-postprocess";
import { validateBatch } from "../domain/validate";
import type {
  ActionResult,
  DomainAction,
  DomainRequest,
  DomainResponse,
  ElementId,
} from "../domain/types";
import { applyPatch } from "../patch";
import { resolveRoomId } from "../rooms";
import type { Rooms } from "../rooms";
import type { PatchBus, PatchOp, RoomState } from "../types";

function computeAffected(_actions: DomainAction[], ops: PatchOp[]): ElementId[] {
  const out = new Set<string>();
  for (const op of ops) {
    if (op.op === "add") out.add(op.value.id);
    else if (op.op === "update") out.add(op.id);
    else if (op.op === "delete") out.add(op.id);
  }
  return [...out];
}

function expandCascadeDeletes(
  actions: DomainAction[],
  canvas: RoomState["canvas"],
): { cascadeError?: { actionIndex: number; affected: string[] } } {
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.kind !== "delete") continue;
    const ids = "ids" in a ? a.ids : [a.id];
    const cascade = "cascade" in a ? a.cascade === true : false;
    for (const nm of ids) {
      const grp = canvas.groups.find((g) => {
        const gname = (g as { meta?: { name?: string } }).meta?.name ?? g.label;
        return gname === nm;
      });
      if (grp && grp.children.length > 0 && !cascade) {
        return { cascadeError: { actionIndex: i, affected: [...grp.children] } };
      }
    }
  }
  return {};
}

// In-memory idempotency cache: clientOpId → response. Per process; ephemeral.
const idempotencyCache = new Map<string, DomainResponse>();

type LayoutInfo = { applied: boolean; affected?: ElementId[]; reason?: string };

export function domainRoutes(
  rooms: Rooms,
  bus: PatchBus,
  opts: { onDirty?: (room: string, state: RoomState) => void } = {},
) {
  return new Hono().post("/api/domain", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;
    const body = (await c.req.json().catch(() => null)) as DomainRequest | null;
    if (!body || !Array.isArray(body.actions)) {
      return c.json({ ok: false, error: "expected {actions, ...}" }, 400);
    }

    if (body.clientOpId) {
      const cached = idempotencyCache.get(`${id}:${body.clientOpId}`);
      if (cached) return c.json({ ...cached, idempotent: true } as DomainResponse);
    }

    const room = await rooms.get(id);

    // Cascade pre-check (before validate, since we need direct access to group children).
    const cascade = expandCascadeDeletes(body.actions, room.canvas);
    if (cascade.cascadeError) {
      return c.json(
        {
          ok: false,
          errors: [
            {
              actionIndex: cascade.cascadeError.actionIndex,
              code: "cascade-confirm-required" as const,
              message: "container has children; pass cascade:true to delete",
              affected: cascade.cascadeError.affected,
            },
          ],
        } satisfies DomainResponse,
        422,
      );
    }

    // Validate.
    const v = validateBatch(body.actions, room.canvas);
    if (!v.ok) {
      return c.json({ ok: false, errors: v.errors } satisfies DomainResponse, 422);
    }

    // Compile.
    const compiled = compile(body.actions, room.canvas);

    // For delete cascade: append children-delete ops for any container being deleted with cascade.
    const cascadeOps: PatchOp[] = [];
    for (const a of body.actions) {
      if (a.kind !== "delete") continue;
      const wantsCascade = "cascade" in a ? a.cascade === true : false;
      if (!wantsCascade) continue;
      const ids = "ids" in a ? a.ids : [a.id];
      for (const nm of ids) {
        const grp = room.canvas.groups.find(
          (g) => ((g as { meta?: { name?: string } }).meta?.name ?? g.label) === nm,
        );
        if (grp) {
          for (const childId of grp.children) {
            cascadeOps.push({ op: "delete", target: "node", id: childId });
          }
        }
      }
    }
    const allOps = [...compiled.ops, ...cascadeOps];

    // dryRun: skip applyPatch and bus.
    if (body.dryRun) {
      const results: ActionResult[] = compiled.elementIds.map((eid, i) => ({
        actionIndex: i,
        elementId: eid,
        generatedOps: compiled.ops,
      }));
      const resp: DomainResponse = {
        ok: true,
        version: room.version,
        results,
        layout: { applied: false, reason: "dryRun" },
      };
      return c.json(resp);
    }

    // Apply domain mutations atomically.
    const applied = applyPatch(room.canvas, allOps);
    if (!applied.ok) {
      return c.json(
        {
          ok: false,
          errors: [{ actionIndex: 0, code: "compile-error" as const, message: applied.error }],
        } satisfies DomainResponse,
        500,
      );
    }
    room.canvas = applied.state;
    room.version += 1;
    room.opLog.push({
      ops: allOps,
      source: "ai",
      version: room.version,
      at: Date.now(),
      clientOpId: body.clientOpId,
    });
    if (room.opLog.length > config.opLogMaxSize) {
      room.opLog.splice(0, room.opLog.length - config.opLogMaxSize);
    }
    room.dirty = true;
    opts.onDirty?.(id, room);
    bus.publish(id, { ops: allOps, source: "ai", version: room.version, originClientId: body.clientOpId });

    // Resolve effective layout config. Precedence (last wins so explicit action overrides batch hint):
    //   1. body.layoutHint === null → skip layout entirely
    //   2. any `layout` action in batch → use its mode/scope/spacing (last layout action wins)
    //   3. body.layoutHint defaults
    //   4. fallback {mode:"layered-lr", scope:"affected", spacing:"normal"}
    type EffectiveHint = {
      mode: "layered-lr" | "layered-tb" | "tree" | "pack" | "force";
      scope: "all" | "affected" | string;
      spacing: "compact" | "normal" | "loose";
    };
    let effectiveHint: EffectiveHint | null;
    if (body.layoutHint === null) {
      effectiveHint = null;
    } else {
      const base: EffectiveHint = {
        mode: (body.layoutHint?.mode ?? "layered-lr") as EffectiveHint["mode"],
        scope: body.layoutHint?.scope ?? "affected",
        spacing: (body.layoutHint?.spacing ?? "normal") as EffectiveHint["spacing"],
      };
      for (const a of body.actions) {
        if (a.kind !== "layout") continue;
        if (a.mode) base.mode = a.mode as EffectiveHint["mode"];
        if (a.scope !== undefined) base.scope = a.scope;
        if (a.spacing) base.spacing = a.spacing as EffectiveHint["spacing"];
      }
      effectiveHint = base;
    }

    let layoutInfo: LayoutInfo = { applied: false };
    if (effectiveHint !== null) {
      const affected = computeAffected(body.actions, allOps);
      try {
        const lr = await runLayout(room.canvas, effectiveHint, { affected });
        if (lr.ok) {
          const sizes = new Map(room.canvas.nodes.map((n) => [n.id, { w: n.w ?? 120, h: n.h ?? 60 }]));
          const adjusted = postProcess(
            Object.fromEntries(Object.entries(lr.positions).map(([nid, p]) => [nid, { x: p.x, y: p.y }])),
            sizes,
          );
          const posOps: PatchOp[] = [];
          for (const [nid, p] of Object.entries(adjusted)) {
            const node = room.canvas.nodes.find((n) => n.id === nid);
            if (!node) continue; // group bbox handled below
            // Per spec §3.6.4: meta.position carries last layout-known coords.
            // applyPatch shallow-merges meta — build full meta.position here.
            const newMeta = { ...(node.meta ?? {}), position: { x: p.x, y: p.y } };
            posOps.push({
              op: "update" as const,
              target: "node" as const,
              id: nid,
              set: { x: p.x, y: p.y, meta: newMeta },
            });
          }
          for (const g of room.canvas.groups) {
            const p = adjusted[g.id];
            if (!p) continue;
            posOps.push({
              op: "update" as const,
              target: "group" as const,
              id: g.id,
              set: { x: p.x, y: p.y },
            });
          }
          for (const [eid, routing] of Object.entries(lr.edgeRouting)) {
            const edge = room.canvas.edges.find((e) => e.id === eid);
            if (!edge) continue;
            const newMeta = {
              ...(edge.meta ?? {}),
              routing: {
                ports: {
                  from: routing.fromSide ? { side: routing.fromSide } : undefined,
                  to: routing.toSide ? { side: routing.toSide } : undefined,
                },
                bendPoints: routing.bendPoints ?? [],
              },
            };
            posOps.push({
              op: "update" as const,
              target: "edge" as const,
              id: eid,
              set: { meta: newMeta },
            });
          }
          if (posOps.length > 0) {
            const r2 = applyPatch(room.canvas, posOps);
            if (r2.ok) {
              room.canvas = r2.state;
              room.version += 1;
              room.opLog.push({ ops: posOps, source: "ai", version: room.version, at: Date.now() });
              if (room.opLog.length > config.opLogMaxSize) {
                room.opLog.splice(0, room.opLog.length - config.opLogMaxSize);
              }
              opts.onDirty?.(id, room);
              bus.publish(id, { ops: posOps, source: "ai", version: room.version });
            }
          }
          layoutInfo = { applied: true, affected: lr.affected };
        } else {
          layoutInfo = { applied: false, reason: lr.reason };
        }
      } catch (e) {
        layoutInfo = { applied: false, reason: (e as Error).message };
      }
    }

    const results: ActionResult[] = compiled.elementIds.map((eid, i) => ({
      actionIndex: i,
      elementId: eid,
    }));

    const resp: DomainResponse = {
      ok: true,
      version: room.version,
      results,
      layout: layoutInfo,
    };

    if (body.clientOpId) {
      idempotencyCache.set(`${id}:${body.clientOpId}`, resp);
    }

    return c.json(resp);
  });
}
