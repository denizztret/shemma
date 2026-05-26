// apps/backend/src/domain/midpoints.ts
//
// DRW-178: distribute elbowMidPoint among arrows that share the same
// (sourceId, sourceSide, targetId, targetSide). Singletons stay at 0.5.

import type { StoreChangeBatch, TLRecord, TLStoreSnapshot } from "../store-types";

type ArrowRec = TLRecord & {
  type?: string;
  props?: { elbowMidPoint?: number; kind?: string };
  meta?: { didrawSourcePort?: string; didrawTargetPort?: string };
};

type BindingRec = TLRecord & {
  fromId?: string;
  toId?: string;
  props?: { terminal?: string };
};

const EPS = 1e-6;

/**
 * Compute elbowMidPoint distribution for arrows sharing the same
 * (sourceShapeId, sourceSide, targetShapeId, targetSide) tuple.
 *
 * Algorithm:
 * 1. Filter to elbow arrows with both didrawSourcePort and didrawTargetPort meta.
 * 2. Resolve binding endpoints (start = source shape, end = target shape).
 * 3. Group by (sourceId|sourceSide|targetId|targetSide).
 * 4. For each group with N >= 2 arrows, assign elbowMidPoint = (i+1)/(N+1).
 * 5. Singletons (N=1) keep default 0.5 and are not emitted.
 * 6. Return StoreChangeBatch with only arrows that changed.
 */
export function computeElbowMidpoints(store: TLStoreSnapshot): StoreChangeBatch {
  const updated: Record<string, [TLRecord, TLRecord]> = {};
  const arrows: ArrowRec[] = [];

  // Collect all elbow arrows with port metadata
  for (const id in store.store) {
    const r = store.store[id] as ArrowRec | undefined;
    if (!r || r.typeName !== "shape" || r.type !== "arrow") continue;
    if (r.props?.kind !== "elbow") continue;
    if (!r.meta?.didrawSourcePort || !r.meta?.didrawTargetPort) continue;
    arrows.push(r);
  }

  // Resolve arrow endpoints via bindings
  const endpointsByArrow = new Map<string, { src?: string; dst?: string }>();
  for (const id in store.store) {
    const b = store.store[id] as BindingRec | undefined;
    if (!b || b.typeName !== "binding" || b.type !== "arrow") continue;
    if (typeof b.fromId !== "string") continue;
    const entry = endpointsByArrow.get(b.fromId) ?? {};
    if (b.props?.terminal === "start") entry.src = b.toId;
    else if (b.props?.terminal === "end") entry.dst = b.toId;
    endpointsByArrow.set(b.fromId, entry);
  }

  // Group arrows by (sourceShapeId, sourceSide, targetShapeId, targetSide)
  const groups = new Map<string, ArrowRec[]>();
  for (const a of arrows) {
    const ep = endpointsByArrow.get(a.id);
    if (!ep?.src || !ep?.dst) continue;
    const key = `${ep.src}|${a.meta!.didrawSourcePort}|${ep.dst}|${a.meta!.didrawTargetPort}`;
    const arr = groups.get(key) ?? [];
    arr.push(a);
    groups.set(key, arr);
  }

  // Assign midpoints: only groups with 2+ arrows are emitted
  for (const [, group] of groups) {
    if (group.length < 2) continue;

    // Stable sort by id
    group.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const n = group.length;
    for (let i = 0; i < n; i++) {
      const arrow = group[i]!;
      const newMid = (i + 1) / (n + 1);
      const oldMid = arrow.props?.elbowMidPoint ?? 0.5;

      // Emit only if value differs from computed distribution (within floating point epsilon)
      if (Math.abs(oldMid - newMid) < EPS) continue;

      const newRec = {
        ...arrow,
        props: { ...arrow.props, elbowMidPoint: newMid },
      } as TLRecord;
      updated[arrow.id] = [arrow as TLRecord, newRec];
    }
  }

  return { added: {}, updated, removed: {} };
}
