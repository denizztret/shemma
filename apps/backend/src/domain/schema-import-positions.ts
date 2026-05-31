// apps/backend/src/domain/schema-import-positions.ts
//
// Stage 1: apply mermaid-blueprint positions to freshly-built v2 schema shapes
// WITHOUT running ELK. Writes parent-relative child coords, leaf/container w/h,
// and frame w/h (union of top-level bounds + pad). Pure: maps in, batch out.
//
// Coordinate model (spec §2.2):
//  - blueprint coords are layout-FLAT.
//  - top-level items (parented to frame): flat coords ARE frame-relative (frame's
//    own page position carries the global offset) → written as-is.
//  - children of a subgraph (parented to a schema-container): converted to
//    container-relative via (childFlat - subgraphFlat).
//  - frame.x/y preserved; only frame.props.w/h recomputed.

import type { NodePos } from "@shemma/domain";
import type { StoreChangeBatch, TLRecord, TLStoreSnapshot } from "../store-types";

export type ApplyImportPositionsInput = {
  store: TLStoreSnapshot;
  frameId: string;
  /** keyed by mermaid id (leaf + subgraph). */
  positions: Record<string, NodePos>;
  /** mermaid id → leaf geo shape.id */
  leafShapeIdByMermaidId: Map<string, string>;
  /** subgraph mermaid id → schema-container shape.id */
  containerShapeIdByMermaidId: Map<string, string>;
  /** member mermaid id → its subgraph mermaid id (for parent-relative conversion) */
  subgraphMermaidIdByMemberMermaidId: Map<string, string>;
  /** padding added to the frame around its content union. */
  framePad: number;
};

export type ApplyImportPositionsResult = StoreChangeBatch & { unmatched: string[] };

function readNum(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

export function applyImportPositions(input: ApplyImportPositionsInput): ApplyImportPositionsResult {
  const {
    store, frameId, positions,
    leafShapeIdByMermaidId, containerShapeIdByMermaidId,
    subgraphMermaidIdByMemberMermaidId, framePad,
  } = input;

  const updated: Record<string, [TLRecord, TLRecord]> = {};
  const unmatched: string[] = [];

  // Track top-level (frame-relative) bounds for frame sizing.
  let maxRight = 0;
  let maxBottom = 0;
  const noteTopLevel = (x: number, y: number, w: number, h: number) => {
    if (x + w > maxRight) maxRight = x + w;
    if (y + h > maxBottom) maxBottom = y + h;
  };

  const writeShape = (
    shapeId: string,
    x: number, y: number,
    w?: number, h?: number,
  ) => {
    const old = store.store[shapeId] as TLRecord | undefined;
    if (!old) { return; }
    const newRec: TLRecord = { ...old, x, y };
    if (w !== undefined || h !== undefined) {
      const oldProps = (old.props ?? {}) as Record<string, unknown>;
      const newProps: Record<string, unknown> = { ...oldProps };
      if (w !== undefined) newProps.w = w;
      if (h !== undefined) newProps.h = h;
      // measured-bounds discipline (DRW-174): nullify growY so written h sticks.
      if ("growY" in oldProps) newProps.growY = 0;
      (newRec as { props?: Record<string, unknown> }).props = newProps;
    }
    updated[shapeId] = [old, newRec];
  };

  for (const mermaidId in positions) {
    const pos = positions[mermaidId];

    // Container (subgraph) — frame-relative, w/h required.
    const containerShapeId = containerShapeIdByMermaidId.get(mermaidId);
    if (containerShapeId) {
      writeShape(containerShapeId, pos.x, pos.y, pos.w, pos.h);
      noteTopLevel(pos.x, pos.y, readNum(pos.w, 0), readNum(pos.h, 0));
      continue;
    }

    // Leaf
    const leafShapeId = leafShapeIdByMermaidId.get(mermaidId);
    if (!leafShapeId) { unmatched.push(mermaidId); continue; }

    const parentSub = subgraphMermaidIdByMemberMermaidId.get(mermaidId);
    if (parentSub) {
      const sp = positions[parentSub];
      const px = sp ? sp.x : 0;
      const py = sp ? sp.y : 0;
      writeShape(leafShapeId, pos.x - px, pos.y - py, pos.w, pos.h);
      // child is inside a container → NOT part of frame's top-level union
    } else {
      writeShape(leafShapeId, pos.x, pos.y, pos.w, pos.h);
      const old = store.store[leafShapeId] as TLRecord | undefined;
      const w = readNum(pos.w, readNum((old?.props as { w?: unknown })?.w, 0));
      const h = readNum(pos.h, readNum((old?.props as { h?: unknown })?.h, 0));
      noteTopLevel(pos.x, pos.y, w, h);
    }
  }

  // Frame sizing: union of top-level bounds + pad. frame.x/y preserved.
  const frame = store.store[frameId] as TLRecord | undefined;
  if (frame) {
    const frameProps = (frame.props ?? {}) as Record<string, unknown>;
    const newRec: TLRecord = {
      ...frame,
      props: { ...frameProps, w: maxRight + framePad, h: maxBottom + framePad },
    } as TLRecord;
    updated[frameId] = [frame, newRec];
  }

  return { added: {}, updated, removed: {}, unmatched };
}
