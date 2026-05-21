// DRW-088: POST /api/agent/layout-selection
//
// Selection-aware ELK layout. Принимает список shape ids (tldraw shape:XXX
// или didrawNames), запускает runLayout с scope="affected" + affectedIds,
// возвращает only changed coords.
//
// Body: { ids: string[], mode?: LayoutMode, spacing?: Spacing }
// Ответ: { ok: true, version, count, affected: string[] }
//
// Edge cases:
//   AC#9: ids.length === 0 → {ok:true, count:0, hint: "..."}
//   AC#10: resolved ids.length < 2 → {ok:true, count:0, hint: "..."}
//   all unresolved → 400
//   invalid room → 422

import { Hono } from "hono";
import { config } from "../config";
import { runLayout } from "../domain/layout";
import { pushOpLog, resolveRoomId } from "../rooms";
import { applyStoreChanges, rebuildDidrawIndex } from "../store-ops";
import type { StoreChangeBus } from "../types";
import { bundleForRequest } from "./_space-context";

// DRW-088: AC#8 — парсим flowchart/graph direction из mermaidSource если все
// selected shapes имеют meta.mermaidSource. Regex ищет первую строку "graph LR"
// или "flowchart TB" за опциональным frontmatter-блоком.
const MERMAID_DIRECTION_RE =
  /^(?:%%\{.*?\}%%\n)?(?:graph|flowchart)\s+(TB|TD|LR|RL|BT)/m;

function detectMermaidMode(
  sources: string[],
): "layered-tb" | "layered-lr" | "layered-bt" | "layered-rl" | undefined {
  if (sources.length === 0) return undefined;
  // Все shapes должны иметь source и одинаковое направление.
  const directions: string[] = [];
  for (const src of sources) {
    const m = MERMAID_DIRECTION_RE.exec(src);
    if (!m || !m[1]) return undefined; // не можем определить — откат к default
    directions.push(m[1]);
  }
  const dir = directions[0];
  if (!directions.every((d) => d === dir)) return undefined; // разные источники
  // Маппинг Mermaid direction → LayoutMode
  const map: Record<
    string,
    "layered-tb" | "layered-lr" | "layered-bt" | "layered-rl"
  > = {
    TB: "layered-tb",
    TD: "layered-tb",
    LR: "layered-lr",
    RL: "layered-rl",
    BT: "layered-bt",
  };
  return map[dir];
}

export function layoutSelectionRoutes(bus: StoreChangeBus) {
  return new Hono().post("/api/agent/layout-selection", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;

    const body = (await c.req.json().catch(() => ({}))) as {
      ids?: unknown;
      mode?: string;
      spacing?: string;
    };

    const rawIds: string[] = Array.isArray(body.ids)
      ? (body.ids as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )
      : [];

    // AC#9: empty ids → noop
    if (rawIds.length === 0) {
      return c.json({
        ok: true,
        count: 0,
        hint: "no shapes selected — select shapes first or use full-canvas shemma_layout",
      });
    }

    // AC#10: single id → noop
    if (rawIds.length === 1) {
      return c.json({
        ok: true,
        count: 0,
        hint: "need 2+ shapes to tidy — single shape has nothing to layout against",
      });
    }

    const { rooms, scheduleSave, space } = bundleForRequest(c);
    const r = await rooms.get(id);

    // DRW-088: resolve ids — принимаем оба формата:
    //   "shape:xxx"  → raw tldraw shape id (as-is)
    //   "node-name"  → didrawName lookup через r.didrawIndex
    const affectedIds = new Set<string>();
    const unresolved: string[] = [];
    for (const raw of rawIds) {
      if (raw.startsWith("shape:")) {
        // Raw tldraw id — verify it exists in store
        if (r.store.store[raw]) {
          affectedIds.add(raw);
        } else {
          unresolved.push(raw);
        }
      } else {
        // Lookup by didrawName
        const shapeId = r.didrawIndex.get(raw);
        if (shapeId) {
          affectedIds.add(shapeId);
        } else {
          unresolved.push(raw);
        }
      }
    }

    // All ids unresolved → 400
    if (affectedIds.size === 0) {
      return c.json(
        {
          ok: false,
          error: "no shapes found — all provided ids are unresolved",
          unresolved,
        },
        400,
      );
    }

    // AC#10: after resolution, fewer than 2 → noop
    if (affectedIds.size < 2) {
      return c.json({
        ok: true,
        count: 0,
        hint: "need 2+ shapes to tidy — single shape has nothing to layout against",
        unresolved: unresolved.length > 0 ? unresolved : undefined,
      });
    }

    // AC#8: если mode не передан, пробуем определить из mermaidSource всех selected shapes.
    let resolvedMode: string = body.mode ?? "layered-tb";
    if (!body.mode) {
      const sources: string[] = [];
      let allHaveSource = true;
      for (const shapeId of affectedIds) {
        const rec = r.store.store[shapeId];
        const src = (rec?.meta as Record<string, unknown> | undefined)
          ?.mermaidSource;
        if (typeof src === "string") {
          sources.push(src);
        } else {
          allHaveSource = false;
          break;
        }
      }
      if (allHaveSource && sources.length > 0) {
        const detected = detectMermaidMode(sources);
        if (detected) resolvedMode = detected;
      }
    }

    const hint = {
      mode: resolvedMode as never,
      scope: "affected" as never,
      spacing: (body.spacing ?? "normal") as never,
      affectedIds,
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
      return c.json({
        ok: true,
        version: r.version,
        count: 0,
        affected: [],
        unresolved: unresolved.length > 0 ? unresolved : undefined,
      });
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

    return c.json({
      ok: true,
      version: r.version,
      count,
      affected: lr.affected,
      unresolved: unresolved.length > 0 ? unresolved : undefined,
    });
  });
}
