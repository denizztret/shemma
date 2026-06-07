// apps/backend/src/routes/style-apply.ts
//
// Style propagation: atomic sweep endpoint. Принимает selectedIds + styles
// + optional respectUserOwned. Применяет props на самих selected, на всех
// recursive descendants frame'ов / schema-container'ов в selection, и
// пишет sticky meta.didrawStyleDefaults на frame/schema-container в selection.
//
// Applicability matrix:
//   geo:               dash + font + size
//   note:              font + size
//   text:              font + size
//   arrow:             dash + font + size
//   schema-container:  dash + sticky meta (font/size только sticky)
//   frame:             sticky meta only
//
// Dashed/dotted preservation: shapes с current dash ∈ {dashed, dotted} —
// dash skipped, font/size применяются.

import { Hono } from "hono";
import { config } from "../config";
import { resolveRoomId, pushOpLog } from "../rooms";
import { applyStoreChanges, rebuildDidrawIndex } from "../store-ops";
import { validateStyleDefaults, type StyleDefaults } from "@shemma/domain";
import type { TLRecord } from "../store-types";
import type { StoreChangeBus } from "../types";
import { bundleForRequest } from "./_space-context";

type ShapeType = "geo" | "note" | "text" | "arrow" | "schema-container";

type ApplyMatrix = Record<
  ShapeType,
  { dash: boolean; font: boolean; size: boolean; kind: boolean }
>;

// Applicability matrix — определяет какие props меняются по типу shape.
// frame здесь отсутствует намеренно: applyApplicable вернёт null для неизвестных типов;
// sticky meta на frame пишется через applyStickyMeta (Pass 1).
// kind (DRW-207, styles.arrowKind → props.kind) применим только к стрелкам.
const APPLY_MATRIX: ApplyMatrix = {
  geo: { dash: true, font: true, size: true, kind: false },
  note: { dash: false, font: true, size: true, kind: false },
  text: { dash: false, font: true, size: true, kind: false },
  arrow: { dash: true, font: true, size: true, kind: true },
  "schema-container": { dash: true, font: false, size: false, kind: false },
};

// Shapes с этими значениями dash НЕ получают изменения dash (preservation).
const PRESERVED_DASH = new Set(["dashed", "dotted"]);

function isStickyParent(type: string): boolean {
  return type === "frame" || type === "schema-container";
}

/**
 * Применяет styles к props shape'а согласно applicability matrix.
 * Возвращает обновлённый TLRecord или null, если ничего не изменилось.
 */
function applyApplicable(
  shape: TLRecord,
  styles: StyleDefaults,
  respectUserOwned: boolean,
): TLRecord | null {
  if (shape.typeName !== "shape") return null;
  const shapeType = (shape as { type?: string }).type as ShapeType | undefined;
  if (!shapeType || !(shapeType in APPLY_MATRIX)) return null;

  const meta = ((shape as { meta?: Record<string, unknown> }).meta ?? {}) as Record<string, unknown>;
  if (respectUserOwned && meta.styleOwnedBy === "user") return null;

  const allowance = APPLY_MATRIX[shapeType];
  const props = ((shape as { props?: Record<string, unknown> }).props ?? {}) as Record<string, unknown>;
  const nextProps = { ...props };
  let changed = false;

  const canSetDash =
    styles.dash !== undefined &&
    allowance.dash &&
    !PRESERVED_DASH.has(props.dash as string) &&
    nextProps.dash !== styles.dash;
  if (canSetDash) {
    nextProps.dash = styles.dash;
    changed = true;
  }
  if (styles.font !== undefined && allowance.font && nextProps.font !== styles.font) {
    nextProps.font = styles.font;
    changed = true;
  }
  if (styles.size !== undefined && allowance.size && nextProps.size !== styles.size) {
    nextProps.size = styles.size;
    changed = true;
  }
  if (
    styles.arrowKind !== undefined &&
    allowance.kind &&
    nextProps.kind !== styles.arrowKind
  ) {
    nextProps.kind = styles.arrowKind;
    changed = true;
  }

  if (!changed) return null;
  return { ...shape, props: nextProps } as TLRecord;
}

/**
 * Пишет sticky meta.didrawStyleDefaults на frame / schema-container.
 * Возвращает обновлённый TLRecord или null, если тип не подходит или ничего не изменилось.
 */
function applyStickyMeta(shape: TLRecord, styles: StyleDefaults): TLRecord | null {
  if (shape.typeName !== "shape") return null;
  const shapeType = (shape as { type?: string }).type;
  if (!isStickyParent(shapeType as string)) return null;

  const meta = ((shape as { meta?: Record<string, unknown> }).meta ?? {}) as Record<string, unknown>;
  const prev = (meta.didrawStyleDefaults ?? {}) as StyleDefaults;
  const next: StyleDefaults = { ...prev };
  let changed = false;

  for (const key of ["dash", "font", "size"] as const) {
    const v = styles[key];
    if (v !== undefined && next[key] !== v) {
      (next as Record<string, unknown>)[key] = v;
      changed = true;
    }
  }

  if (!changed) return null;
  const newMeta = { ...meta, didrawStyleDefaults: next };
  return { ...shape, meta: newMeta } as TLRecord;
}

/**
 * BFS-обход всех потомков rootIds в store.
 * Возвращает Set<id> включающий rootIds + всех рекурсивных children.
 */
function collectDescendants(
  storeMap: Record<string, TLRecord>,
  rootIds: Iterable<string>,
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const rec of Object.values(storeMap)) {
    if (rec.typeName !== "shape") continue;
    const parentId = (rec as { parentId?: string }).parentId;
    if (!parentId) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId)!.push(rec.id);
  }

  const out = new Set<string>();
  const stack = Array.from(rootIds);
  while (stack.length > 0) {
    const id = stack.pop()!;
    out.add(id);
    const kids = childrenByParent.get(id);
    if (kids) {
      for (const k of kids) {
        if (!out.has(k)) stack.push(k);
      }
    }
  }
  return out;
}

export function styleApplyRoutes(bus: StoreChangeBus) {
  return new Hono().post("/api/agent/style-apply", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;

    const body = (await c.req.json().catch(() => ({}))) as {
      selectedIds?: unknown;
      styles?: unknown;
      respectUserOwned?: unknown;
    };

    const selectedIds: string[] = Array.isArray(body.selectedIds)
      ? (body.selectedIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const styles = (body.styles ?? {}) as StyleDefaults;
    const respectUserOwned = body.respectUserOwned !== false;

    // Validate BEFORE any store mutation — invalid value → atomic 400.
    try {
      validateStyleDefaults(styles);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }

    if (selectedIds.length === 0 || Object.keys(styles).length === 0) {
      return c.json({ ok: true, count: 0 });
    }

    const { rooms, scheduleSave, space } = bundleForRequest(c);
    const r = await rooms.get(id);
    if (!r) return c.json({ ok: false, error: "room not found" }, 404);

    // Collect all shapes to sweep: selected + all recursive descendants.
    const targetIds = collectDescendants(r.store.store, selectedIds);

    // updated map: id → [preImage, postImage]
    const updated: Record<string, [TLRecord, TLRecord]> = {};

    // Pass 1: sticky meta на selected frame / schema-container.
    for (const sid of selectedIds) {
      const rec = r.store.store[sid];
      if (!rec) continue;
      const next = applyStickyMeta(rec, styles);
      if (next) {
        updated[sid] = [rec, next];
      }
    }

    // Pass 2: props на всех target shapes (selected + descendants).
    // Если shape уже присутствует в updated (sticky meta pass), используем
    // промежуточный postImage как базу чтобы не потерять sticky изменения.
    for (const tid of targetIds) {
      const baseShape = updated[tid]?.[1] ?? r.store.store[tid];
      if (!baseShape) continue;
      const next = applyApplicable(baseShape, styles, respectUserOwned);
      if (next) {
        const preImage = updated[tid]?.[0] ?? r.store.store[tid]!;
        updated[tid] = [preImage, next];
      }
    }

    if (Object.keys(updated).length === 0) {
      return c.json({ ok: true, count: 0 });
    }

    const batch = { added: {}, updated, removed: {} };
    r.store = applyStoreChanges(r.store, batch);
    r.didrawIndex = rebuildDidrawIndex(r.store);
    r.version += 1;
    pushOpLog(
      r,
      { ops: batch, source: "user", version: r.version, at: Date.now() },
      config.opLogMaxSize,
    );
    r.dirty = true;
    scheduleSave(id, r);
    bus.publish(space.id, id, {
      changes: batch,
      source: "user",
      version: r.version,
    });

    return c.json({
      ok: true,
      count: Object.keys(updated).length,
      version: r.version,
    });
  });
}
