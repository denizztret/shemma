// apps/backend/src/domain/midpoints.ts
//
// DRW-178: distribute elbowMidPoint among arrows that share the same
// (sourceId, sourceSide, targetId, targetSide). Singletons stay at 0.5.

import type { LayoutParams } from "@shemma/domain";
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
 * Compute elbowMidPoint distribution for arrows sharing fan-in/fan-out patterns.
 *
 * Algorithm:
 * 1. Filter to elbow arrows with both didrawSourcePort and didrawTargetPort meta.
 * 2. Resolve binding endpoints (start = source shape, end = target shape).
 * 3. Build TWO group maps:
 *    - Fan-in: key = (targetId|targetSide) — arrows entering same target from same side.
 *    - Fan-out: key = (sourceId|sourceSide) — arrows exiting same source from same side.
 * 4. For each arrow, decide which grouping to use:
 *    - If fan-in group size > 1 → use fan-in (priority).
 *    - Else if fan-out group size > 1 → use fan-out.
 *    - Else (both singleton) → skip (no update).
 * 5. Within chosen group, sort by id and assign elbowMidPoint = (i+1)/(N+1).
 * 6. Return StoreChangeBatch with only arrows that changed.
 */
export function computeElbowMidpoints(
  store: TLStoreSnapshot,
  params?: Pick<LayoutParams, "midpointDistribution">,
): StoreChangeBatch {
  if (params?.midpointDistribution === "fixed-0.5") {
    return { added: {}, updated: {}, removed: {} };
  }
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

  // Build fan-in and fan-out group maps
  const fanInGroups = new Map<string, ArrowRec[]>();
  const fanOutGroups = new Map<string, ArrowRec[]>();

  for (const a of arrows) {
    const ep = endpointsByArrow.get(a.id);
    if (!ep?.src || !ep?.dst) continue;

    const inKey = `${ep.dst}|${a.meta!.didrawTargetPort}`;
    const outKey = `${ep.src}|${a.meta!.didrawSourcePort}`;

    const inGroup = fanInGroups.get(inKey) ?? [];
    inGroup.push(a);
    fanInGroups.set(inKey, inGroup);

    const outGroup = fanOutGroups.get(outKey) ?? [];
    outGroup.push(a);
    fanOutGroups.set(outKey, outGroup);
  }

  // Per-arrow midpoint decision: fan-in priority > fan-out > no-op
  for (const a of arrows) {
    const ep = endpointsByArrow.get(a.id);
    if (!ep?.src || !ep?.dst) continue;

    const inKey = `${ep.dst}|${a.meta!.didrawTargetPort}`;
    const outKey = `${ep.src}|${a.meta!.didrawSourcePort}`;

    const inGroup = fanInGroups.get(inKey) ?? [];
    const outGroup = fanOutGroups.get(outKey) ?? [];

    // Choose group: fan-in priority
    let chosenGroup: ArrowRec[];
    if (inGroup.length > 1) {
      chosenGroup = inGroup;
    } else if (outGroup.length > 1) {
      chosenGroup = outGroup;
    } else {
      continue; // Singleton in both perspectives; skip
    }

    // Sort by id within chosen group
    const sorted = [...chosenGroup].sort(
      (x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
    );

    const idx = sorted.findIndex((x) => x.id === a.id);
    const n = sorted.length;
    const newMid = (idx + 1) / (n + 1);
    const oldMid = a.props?.elbowMidPoint ?? 0.5;

    // Emit only if value differs (within epsilon)
    if (Math.abs(oldMid - newMid) < EPS) continue;

    const newRec = {
      ...a,
      props: { ...a.props, elbowMidPoint: newMid },
    } as TLRecord;
    updated[a.id] = [a as TLRecord, newRec];
  }

  return { added: {}, updated, removed: {} };
}
