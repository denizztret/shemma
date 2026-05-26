// apps/backend/src/domain/layout-determinism.test.ts
//
// DRW-178: layout pipeline determinism — same topology produces same layout
// regardless of starting positions. Guards against accidental introduction
// of position-dependent decisions (e.g. RNG, mutation order, etc.).

import { describe, expect, test } from "bun:test";
import { runLayout } from "./layout";
import type { TLStoreSnapshot } from "../store-types";

type Pos = { x: number; y: number };

function chainStore(positions: Pos[]): TLStoreSnapshot {
  const ids = ["A", "B", "C", "D"];
  const store: Record<string, unknown> = {
    "shape:frame": {
      id: "shape:frame",
      typeName: "shape",
      type: "frame",
      x: 0,
      y: 0,
      parentId: "page:page",
      index: "a1",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: { w: 800, h: 400, name: "F" },
      meta: {},
    },
  };
  ids.forEach((id, i) => {
    store[`shape:${id}`] = {
      id: `shape:${id}`,
      typeName: "shape",
      type: "geo",
      x: positions[i]!.x,
      y: positions[i]!.y,
      parentId: "shape:frame",
      index: "a1",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: { geo: "rectangle", w: 120, h: 60 },
      meta: {},
    };
  });
  // Chain arrows A→B→C→D
  for (let i = 0; i < ids.length - 1; i++) {
    const aId = `shape:a${i}`;
    store[aId] = {
      id: aId,
      typeName: "shape",
      type: "arrow",
      x: 0,
      y: 0,
      parentId: "shape:frame",
      index: "a3",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: {
        kind: "elbow",
        color: "black",
        fill: "none",
        dash: "draw",
        size: "m",
        labelColor: "black",
        font: "draw",
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
        bend: 0,
        elbowMidPoint: 0.5,
        labelPosition: 0.5,
        scale: 1,
        richText: { type: "doc", content: [{ type: "paragraph" }] },
        arrowheadStart: "none",
        arrowheadEnd: "arrow",
      },
      meta: {},
    };
    store[`binding:s${i}`] = {
      id: `binding:s${i}`,
      typeName: "binding",
      type: "arrow",
      fromId: aId,
      toId: `shape:${ids[i]}`,
      props: {
        terminal: "start",
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: "none",
      },
    };
    store[`binding:e${i}`] = {
      id: `binding:e${i}`,
      typeName: "binding",
      type: "arrow",
      fromId: aId,
      toId: `shape:${ids[i + 1]}`,
      props: {
        terminal: "end",
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: "none",
      },
    };
  }
  return {
    store: store as Record<string, any>,
    schema: {
      schemaVersion: 1,
      sequenceNumber: 0,
      storeVersion: 1,
      recordVersions: {},
    },
  };
}

function finalPositions(
  res: Awaited<ReturnType<typeof runLayout>>,
  original: TLStoreSnapshot
) {
  const ids = ["A", "B", "C", "D"];
  return ids.map((id) => {
    const updated = res.batch.updated[`shape:${id}`]?.[1] as
      | { x?: number; y?: number }
      | undefined;
    const src = original.store[`shape:${id}`] as {
      x?: number;
      y?: number;
    };
    return {
      id,
      x: updated?.x ?? src.x ?? 0,
      y: updated?.y ?? src.y ?? 0,
    };
  });
}

describe("layout pipeline determinism (DRW-178)", () => {
  test("same topology, different starting positions → identical final positions", async () => {
    const s1 = chainStore([
      { x: 100, y: 100 },
      { x: 300, y: 50 },
      { x: 50, y: 200 },
      { x: 400, y: 250 },
    ]);
    const s2 = chainStore([
      { x: 500, y: 200 },
      { x: 50, y: 100 },
      { x: 250, y: 50 },
      { x: 100, y: 250 },
    ]);

    const r1 = await runLayout(
      s1,
      { mode: "layered-lr", scope: "all" },
      new Map()
    );
    const r2 = await runLayout(
      s2,
      { mode: "layered-lr", scope: "all" },
      new Map()
    );

    expect(finalPositions(r1, s1)).toEqual(finalPositions(r2, s2));
  });

  test("same topology run twice with identical input → identical output (basic idempotency check)", async () => {
    const positions: Pos[] = [
      { x: 100, y: 100 },
      { x: 300, y: 50 },
      { x: 50, y: 200 },
      { x: 400, y: 250 },
    ];
    const s1 = chainStore(positions);
    const s2 = chainStore(positions);

    const r1 = await runLayout(
      s1,
      { mode: "layered-lr", scope: "all" },
      new Map()
    );
    const r2 = await runLayout(
      s2,
      { mode: "layered-lr", scope: "all" },
      new Map()
    );

    expect(finalPositions(r1, s1)).toEqual(finalPositions(r2, s2));
  });

  test("custom LayoutParams (e.g. nodeMinHeight=100) produces consistent results across runs", async () => {
    const positions: Pos[] = [
      { x: 100, y: 100 },
      { x: 300, y: 50 },
      { x: 50, y: 200 },
      { x: 400, y: 250 },
    ];
    const s1 = chainStore(positions);
    const s2 = chainStore([
      { x: 500, y: 200 },
      { x: 50, y: 100 },
      { x: 250, y: 50 },
      { x: 100, y: 250 },
    ]);

    const params = { nodeMinHeight: 100, edgeSpacing: 30 };
    const r1 = await runLayout(
      s1,
      { mode: "layered-lr", scope: "all" },
      new Map(),
      params
    );
    const r2 = await runLayout(
      s2,
      { mode: "layered-lr", scope: "all" },
      new Map(),
      params
    );

    expect(finalPositions(r1, s1)).toEqual(finalPositions(r2, s2));
  });
});
