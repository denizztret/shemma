// apps/backend/src/domain/anchors.ts
//
// DRW-172: Per-edge arrow anchor distribution.
//
// Cardinal-snap algorithm:
//   1. For each arrow with both bindings, compute angle from source center to
//      target center; snap to cardinal side (top/bottom/left/right).
//   2. Group arrow terminals by (shapeId, side).
//   3. Within each group sort by perpendicular position of the peer center
//      (top/bottom group → sort by peer x; left/right → sort by peer y) for
//      stable distribution.
//   4. Distribute offsets: offset_i = (i+1) / (n+1), so 1 arrow → 0.5, 2 →
//      0.33/0.67, 3 → 0.25/0.5/0.75, etc. Hub-spoke deterministically maps
//      to distinct anchor points per side.
//   5. Write binding.props.normalizedAnchor for the chosen anchor point and
//      binding.props.isPrecise = true so tldraw uses the exact anchor at
//      render (no auto-projection on periphery).
//   6. Write arrow.meta.didrawSourcePort + .didrawTargetPort = side — input
//      contract for DRW-173 libavoid edge router (router needs port sides to
//      route paths without obstacles).
//
// Preservation:
//   - dangling arrows (≠2 bindings) → skip (no anchor math possible).
//   - binding.props.isExact === true → skip (user-manual pin).
//   - arrow.meta.styleOwnedBy === "user" → skip (user-pinned arrow).
//
// Coordinate space: shape.x/y in tldraw are parent-relative. We accumulate
// parent offsets to compute absolute page-space centers (mirrors layout.ts
// collectPositions walk pattern).

import type { StoreChangeBatch, TLRecord, TLStoreSnapshot } from "../store-types";

export type Side = "top" | "bottom" | "left" | "right";

const DEFAULT_W = 120;
const DEFAULT_H = 60;
const DEFAULT_FRAME_W = 400;
const DEFAULT_FRAME_H = 300;

type ShapeRec = TLRecord & {
  type?: string;
  x?: number;
  y?: number;
  props?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

type BindingRec = TLRecord & {
  fromId?: string;
  toId?: string;
  props?: {
    terminal?: "start" | "end";
    normalizedAnchor?: { x: number; y: number };
    isExact?: boolean;
    isPrecise?: boolean;
    [k: string]: unknown;
  };
};

type Center = { x: number; y: number };
type AbsBounds = { x: number; y: number; w: number; h: number };

function readNumberProp(
  props: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const v = props?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function isContainer(r: ShapeRec): boolean {
  if (r.type === "frame") return true;
  if (r.type === "schema-container") return true;
  if (r.type === "geo" && r.meta?.role === "boundary") return true;
  if (r.type === "geo" && r.meta?.didrawSubgraph === true) return true;
  return false;
}

function localBounds(r: ShapeRec): { w: number; h: number } {
  const isFrame = isContainer(r);
  const w = readNumberProp(r.props, "w", isFrame ? DEFAULT_FRAME_W : DEFAULT_W);
  const baseH = readNumberProp(
    r.props,
    "h",
    isFrame ? DEFAULT_FRAME_H : DEFAULT_H,
  );
  const growY =
    r.type === "geo" || r.type === "note"
      ? readNumberProp(r.props, "growY", 0)
      : 0;
  return { w, h: baseH + growY };
}

/**
 * Compute absolute page-space bounds for `shape` by walking parentId chain
 * and accumulating offsets. Mirrors the offset walk used in layout.ts:
 * collectPositions (but here we walk only one shape's ancestor chain).
 */
function absoluteBounds(
  shape: ShapeRec,
  store: Record<string, TLRecord | undefined>,
): AbsBounds {
  let x = typeof shape.x === "number" ? shape.x : 0;
  let y = typeof shape.y === "number" ? shape.y : 0;
  let pid = shape.parentId;
  let safety = 32;
  while (pid && pid !== "page:page" && safety-- > 0) {
    const parent = store[pid] as ShapeRec | undefined;
    if (!parent || parent.typeName !== "shape") break;
    x += typeof parent.x === "number" ? parent.x : 0;
    y += typeof parent.y === "number" ? parent.y : 0;
    pid = parent.parentId;
  }
  const { w, h } = localBounds(shape);
  return { x, y, w, h };
}

function center(b: AbsBounds): Center {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/**
 * Snap angle (radians, atan2 output range (-π, π]) to cardinal side.
 *
 * Screen coords: x→right, y→down. atan2(dy, dx):
 *   right:   angle ∈ (-π/4, π/4]
 *   bottom:  angle ∈ (π/4, 3π/4]
 *   left:    angle ∈ (3π/4, π] ∪ (-π, -3π/4]
 *   top:     angle ∈ (-3π/4, -π/4]
 */
export function snapAngleToSide(angle: number): Side {
  const PI = Math.PI;
  if (angle > -PI / 4 && angle <= PI / 4) return "right";
  if (angle > PI / 4 && angle <= 3 * PI / 4) return "bottom";
  if (angle > -3 * PI / 4 && angle <= -PI / 4) return "top";
  return "left";
}

/** Normalized anchor point in [0,1]² for the given side + offset along that side. */
export function anchorForSide(side: Side, offset: number): Center {
  switch (side) {
    case "top":
      return { x: offset, y: 0 };
    case "bottom":
      return { x: offset, y: 1 };
    case "left":
      return { x: 0, y: offset };
    case "right":
      return { x: 1, y: offset };
  }
}

type ArrowInfo = {
  arrow: ShapeRec;
  startBinding: BindingRec;
  endBinding: BindingRec;
  sourceShape: ShapeRec;
  targetShape: ShapeRec;
};

function collectArrowInfos(
  store: TLStoreSnapshot,
  arrowIds?: Set<string>,
): ArrowInfo[] {
  // Group bindings by their owning arrow (fromId).
  const bindingsByArrow = new Map<string, BindingRec[]>();
  for (const id in store.store) {
    const r = store.store[id] as BindingRec | undefined;
    if (!r || r.typeName !== "binding") continue;
    if (typeof r.fromId !== "string") continue;
    const arr = bindingsByArrow.get(r.fromId) ?? [];
    arr.push(r);
    bindingsByArrow.set(r.fromId, arr);
  }

  const out: ArrowInfo[] = [];
  for (const id in store.store) {
    const arrow = store.store[id] as ShapeRec | undefined;
    if (
      !arrow ||
      arrow.typeName !== "shape" ||
      arrow.type !== "arrow"
    ) {
      continue;
    }
    if (arrowIds && !arrowIds.has(arrow.id)) continue;
    if (arrow.meta?.styleOwnedBy === "user") continue;

    const bs = bindingsByArrow.get(arrow.id) ?? [];
    if (bs.length !== 2) continue;
    const start = bs.find((b) => b.props?.terminal === "start");
    const end = bs.find((b) => b.props?.terminal === "end");
    if (!start || !end || !start.toId || !end.toId) continue;
    if (start.props?.isExact === true || end.props?.isExact === true) continue;

    const sourceShape = store.store[start.toId] as ShapeRec | undefined;
    const targetShape = store.store[end.toId] as ShapeRec | undefined;
    if (!sourceShape || !targetShape) continue;

    out.push({
      arrow,
      startBinding: start,
      endBinding: end,
      sourceShape,
      targetShape,
    });
  }
  return out;
}

type SideGroupEntry = {
  info: ArrowInfo;
  terminal: "start" | "end";
};

/**
 * DRW-172: Compute per-edge anchor distribution and return a StoreChangeBatch
 * with updated binding.props.normalizedAnchor + isPrecise=true, plus updated
 * arrow.meta.didrawSourcePort / .didrawTargetPort.
 *
 * Idempotent: bindings that already have the chosen anchor + isPrecise=true
 * are not re-emitted.
 *
 * Pass an explicit `arrowIds` set to restrict to a subset (e.g. only arrows
 * touched by a recent layout pass); omit to compute for all arrows in store.
 */
export function computeAnchors(
  store: TLStoreSnapshot,
  arrowIds?: Set<string>,
): StoreChangeBatch {
  const updated: Record<string, [TLRecord, TLRecord]> = {};

  const arrows = collectArrowInfos(store, arrowIds);
  if (arrows.length === 0) return { added: {}, updated: {}, removed: {} };

  // Cache absolute bounds per shape to avoid repeated walks.
  const boundsCache = new Map<string, AbsBounds>();
  const boundsOf = (shape: ShapeRec): AbsBounds => {
    const cached = boundsCache.get(shape.id);
    if (cached) return cached;
    const b = absoluteBounds(shape, store.store);
    boundsCache.set(shape.id, b);
    return b;
  };

  // Group terminals by (shapeId, side).
  const byShape = new Map<string, Map<Side, SideGroupEntry[]>>();

  // Track per-arrow side assignments so we can write port meta below.
  const arrowSides = new Map<
    string,
    { source: Side; target: Side }
  >();

  for (const info of arrows) {
    const sCenter = center(boundsOf(info.sourceShape));
    const tCenter = center(boundsOf(info.targetShape));
    const sourceAngle = Math.atan2(tCenter.y - sCenter.y, tCenter.x - sCenter.x);
    const targetAngle = Math.atan2(sCenter.y - tCenter.y, sCenter.x - tCenter.x);
    const sourceSide = snapAngleToSide(sourceAngle);
    const targetSide = snapAngleToSide(targetAngle);
    arrowSides.set(info.arrow.id, { source: sourceSide, target: targetSide });

    const addToGroup = (
      shapeId: string,
      side: Side,
      terminal: "start" | "end",
    ) => {
      let sideMap = byShape.get(shapeId);
      if (!sideMap) {
        sideMap = new Map();
        byShape.set(shapeId, sideMap);
      }
      const arr = sideMap.get(side) ?? [];
      arr.push({ info, terminal });
      sideMap.set(side, arr);
    };

    addToGroup(info.sourceShape.id, sourceSide, "start");
    addToGroup(info.targetShape.id, targetSide, "end");
  }

  // For each (shape, side), sort + distribute.
  // newAnchors: bindingId → new normalizedAnchor.
  const newAnchors = new Map<string, Center>();

  for (const [, sideMap] of byShape) {
    for (const [side, group] of sideMap) {
      // Sort by perpendicular position of the peer's center for visual stability.
      // top/bottom (horizontal side) → sort by peer center x.
      // left/right (vertical side) → sort by peer center y.
      group.sort((a, b) => {
        const aPeer =
          a.terminal === "start" ? a.info.targetShape : a.info.sourceShape;
        const bPeer =
          b.terminal === "start" ? b.info.targetShape : b.info.sourceShape;
        const aC = center(boundsOf(aPeer));
        const bC = center(boundsOf(bPeer));
        return side === "top" || side === "bottom"
          ? aC.x - bC.x
          : aC.y - bC.y;
      });

      const n = group.length;
      for (let i = 0; i < n; i++) {
        const offset = (i + 1) / (n + 1);
        const anchor = anchorForSide(side, offset);
        const binding =
          group[i]!.terminal === "start"
            ? group[i]!.info.startBinding
            : group[i]!.info.endBinding;
        newAnchors.set(binding.id, anchor);
      }
    }
  }

  // Emit updated bindings (skip no-op writes).
  const EPS = 1e-6;
  for (const [bindingId, anchor] of newAnchors) {
    const orig = store.store[bindingId] as BindingRec | undefined;
    if (!orig) continue;
    const oldProps = (orig.props ?? {}) as Record<string, unknown>;
    const oldAnchor = (oldProps.normalizedAnchor ?? { x: 0.5, y: 0.5 }) as {
      x: number;
      y: number;
    };
    const oldIsPrecise = oldProps.isPrecise === true;
    const sameAnchor =
      Math.abs(oldAnchor.x - anchor.x) < EPS &&
      Math.abs(oldAnchor.y - anchor.y) < EPS;
    if (sameAnchor && oldIsPrecise) continue;
    const newRec: TLRecord = {
      ...orig,
      props: {
        ...oldProps,
        normalizedAnchor: anchor,
        isPrecise: true,
      },
    };
    updated[bindingId] = [orig, newRec];
  }

  // Emit updated arrow meta with port sides (only for arrows we actually
  // wrote anchors for — same arrow set as `arrowSides`).
  for (const [arrowId, sides] of arrowSides) {
    const orig = store.store[arrowId] as ShapeRec | undefined;
    if (!orig) continue;
    const oldMeta = (orig.meta ?? {}) as Record<string, unknown>;
    const oldSourcePort = oldMeta.didrawSourcePort;
    const oldTargetPort = oldMeta.didrawTargetPort;
    if (
      oldSourcePort === sides.source &&
      oldTargetPort === sides.target
    ) {
      continue;
    }
    const newMeta = {
      ...oldMeta,
      didrawSourcePort: sides.source,
      didrawTargetPort: sides.target,
    };
    updated[arrowId] = [orig, { ...orig, meta: newMeta } as TLRecord];
  }

  return { added: {}, updated, removed: {} };
}
