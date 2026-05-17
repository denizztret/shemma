import { Hono } from "hono";
import type { LayoutMode, Spacing } from "@didraw/domain";
import { config } from "../config";
import { compile } from "../domain/compile";
import { runLayout } from "../domain/layout";
import type {
  ActionResult,
  DomainRequest,
  DomainResponse,
  ElementId,
} from "../domain/types";
import { validateBatch } from "../domain/validate";
import { pushOpLog, resolveRoomId } from "../rooms";
import type { Rooms } from "../rooms";
import { applyStoreChanges, rebuildDidrawIndex } from "../store-ops";
import type { StoreChangeBatch } from "../store-types";
import type { RoomState, StoreChangeBus } from "../types";

type LayoutInfo = { applied: boolean; affected?: ElementId[]; reason?: string };

const MAX_IDEMPOTENCY_ENTRIES = 1000;

function makeLruCache<K, V>(max: number) {
  const m = new Map<K, V>();
  return {
    get(k: K): V | undefined {
      const v = m.get(k);
      if (v !== undefined) {
        // Bump to most-recent: re-insert moves the key to the end of insertion order.
        m.delete(k);
        m.set(k, v);
      }
      return v;
    },
    set(k: K, v: V): void {
      if (m.has(k)) m.delete(k);
      m.set(k, v);
      if (m.size > max) {
        const oldest = m.keys().next().value;
        if (oldest !== undefined) m.delete(oldest);
      }
    },
  };
}

function batchIsEmpty(b: StoreChangeBatch): boolean {
  return (
    Object.keys(b.added).length === 0 &&
    Object.keys(b.updated).length === 0 &&
    Object.keys(b.removed).length === 0
  );
}

export function domainRoutes(
  rooms: Rooms,
  bus: StoreChangeBus,
  opts: { onDirty?: (room: string, state: RoomState) => void } = {},
) {
  // Per-instance idempotency cache: clientOpId → response. Bounded LRU (oldest evicted past max).
  const idempotencyCache = makeLruCache<string, DomainResponse>(MAX_IDEMPOTENCY_ENTRIES);

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

    // Cascade pre-check (before validate). Container = shape with type=frame.
    // Children = shapes with parentId === frame.id.
    for (const [i, a] of body.actions.entries()) {
      if (a.kind !== "delete") continue;
      const ids = "ids" in a ? a.ids : [a.id];
      const wantsCascade = "ids" in a ? a.cascade === true : false;
      for (const nm of ids) {
        const recId = room.didrawIndex.get(nm);
        if (!recId) continue;
        const rec = room.store.store[recId];
        if (!rec || (rec as { type?: string }).type !== "frame") continue;
        const children: string[] = [];
        for (const sid in room.store.store) {
          const s = room.store.store[sid];
          if (s?.parentId === recId && s.typeName === "shape") {
            const childName = (s.meta as { didrawName?: unknown } | undefined)?.didrawName;
            children.push(typeof childName === "string" ? childName : sid);
          }
        }
        if (children.length > 0 && !wantsCascade) {
          return c.json(
            {
              ok: false,
              errors: [
                {
                  actionIndex: i,
                  code: "cascade-confirm-required" as const,
                  message: "container has children; pass cascade:true to delete",
                  affected: children,
                },
              ],
            } satisfies DomainResponse,
            422,
          );
        }
      }
    }

    // Validate.
    const v = validateBatch(body.actions, room.store, room.didrawIndex);
    if (!v.ok) {
      return c.json({ ok: false, errors: v.errors } satisfies DomainResponse, 422);
    }

    // Compile.
    let compiled: ReturnType<typeof compile>;
    try {
      compiled = compile(body.actions, room.store, room.didrawIndex);
    } catch (e) {
      return c.json(
        {
          ok: false,
          errors: [{ actionIndex: 0, code: "compile-error" as const, message: (e as Error).message }],
        } satisfies DomainResponse,
        500,
      );
    }

    // dryRun: skip apply and bus.
    if (body.dryRun) {
      const results: ActionResult[] = compiled.elementIds.map((eid, i) => ({
        actionIndex: i,
        elementId: eid,
        generatedOps: compiled.batch,
      }));
      const resp: DomainResponse = {
        ok: true,
        version: room.version,
        results,
        layout: { applied: false, reason: "dryRun" },
      };
      return c.json(resp);
    }

    // Apply domain mutations atomically (if any).
    if (!batchIsEmpty(compiled.batch)) {
      room.store = applyStoreChanges(room.store, compiled.batch);
      room.didrawIndex = rebuildDidrawIndex(room.store);
      room.version += 1;
      pushOpLog(
        room,
        {
          ops: compiled.batch,
          source: "ai",
          version: room.version,
          at: Date.now(),
          clientOpId: body.clientOpId,
        },
        config.opLogMaxSize,
      );
      room.dirty = true;
      opts.onDirty?.(id, room);
      bus.publish(id, {
        changes: compiled.batch,
        source: "ai",
        version: room.version,
        originClientId: body.clientOpId,
      });
    }

    // Resolve effective layout config. Precedence (last wins so explicit action overrides batch hint):
    //   1. body.layoutHint === null → skip layout entirely
    //   2. any `layout` action in batch → use its mode/scope/spacing (last layout action wins)
    //   3. body.layoutHint defaults
    //   4. fallback {mode:"layered-lr", scope:"affected", spacing:"normal"}
    type EffectiveHint = {
      mode: LayoutMode;
      scope: "all" | "affected" | string;
      spacing: Spacing;
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
      // Phase 2.x preserved: any AI batch runs layout by default. An explicit
      // `layout` action lets the batch override mode/scope/spacing (last wins).
      for (const a of body.actions) {
        if (a.kind !== "layout") continue;
        if (a.mode) base.mode = a.mode as EffectiveHint["mode"];
        if (a.scope !== undefined) base.scope = a.scope;
        if (a.spacing) base.spacing = a.spacing as EffectiveHint["spacing"];
      }
      effectiveHint = base;
    }

    // Build affected-id set: shape records added or updated by THIS batch.
    // При scope=affected layout не должен двигать user-drawn shapes (freehand,
    // images, user rectangles) — даём runLayout этот set, и он pin'ит non-affected.
    const affectedIds = new Set<string>();
    for (const id of Object.keys(compiled.batch.added)) {
      const r = room.store.store[id];
      if (r?.typeName === "shape") affectedIds.add(id);
    }
    for (const id of Object.keys(compiled.batch.updated)) {
      const r = room.store.store[id];
      if (r?.typeName === "shape") affectedIds.add(id);
    }

    let layoutInfo: LayoutInfo = { applied: false };
    if (effectiveHint !== null) {
      try {
        const lr = await runLayout(
          room.store,
          { ...effectiveHint, affectedIds },
          room.didrawIndex,
        );
        if (lr.reason) {
          layoutInfo = { applied: false, reason: lr.reason };
        } else if (batchIsEmpty(lr.batch)) {
          layoutInfo = { applied: false, reason: "no-changes" };
        } else {
          room.store = applyStoreChanges(room.store, lr.batch);
          room.didrawIndex = rebuildDidrawIndex(room.store);
          room.version += 1;
          pushOpLog(
            room,
            {
              ops: lr.batch,
              source: "ai",
              version: room.version,
              at: Date.now(),
            },
            config.opLogMaxSize,
          );
          room.dirty = true;
          opts.onDirty?.(id, room);
          // Intentional second publish: clients receive a two-phase render —
          // first the semantic mutation, then the layout-adjusted positions.
          bus.publish(id, {
            changes: lr.batch,
            source: "ai",
            version: room.version,
          });
          layoutInfo = { applied: true, affected: lr.affected };
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
