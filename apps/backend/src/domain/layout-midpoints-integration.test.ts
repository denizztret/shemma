// apps/backend/src/domain/layout-midpoints-integration.test.ts
//
// DRW-178: integration test — computeElbowMidpoints is wired into runLayout.
// Two parallel arrows A→B with port meta should receive distinct elbowMidPoint
// values after layout (1/3 and 2/3 for N=2 group).

import { describe, expect, test } from "bun:test";
import { runLayout } from "./layout";
import type { TLStoreSnapshot } from "../store-types";

function makeStore(): TLStoreSnapshot {
  const baseShape = (id: string): Record<string, unknown> => ({
    id,
    typeName: "shape",
    type: "geo",
    x: 0,
    y: 0,
    parentId: "shape:frame",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { geo: "rectangle", w: 120, h: 120 },
    meta: {},
  });

  // Arrows with port meta pre-populated so computeElbowMidpoints can group them.
  // In production, meta is written by computeAnchors (route layer). In this test
  // we inject port meta directly to isolate the midpoint wiring.
  const arrowWithPorts = (id: string): Record<string, unknown> => ({
    id,
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
    // Both arrows share the same (sourcePort, targetPort) → same group → distributed.
    meta: { didrawSourcePort: "right", didrawTargetPort: "left" },
  });

  const binding = (
    id: string,
    fromId: string,
    toId: string,
    terminal: "start" | "end",
  ): Record<string, unknown> => ({
    id,
    typeName: "binding",
    type: "arrow",
    fromId,
    toId,
    props: {
      terminal,
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: true,
      snap: "none",
    },
  });

  return {
    store: {
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
      "shape:A": baseShape("shape:A"),
      "shape:B": baseShape("shape:B"),
      "shape:a1": arrowWithPorts("shape:a1"),
      "shape:a2": arrowWithPorts("shape:a2"),
      "binding:s1": binding("binding:s1", "shape:a1", "shape:A", "start"),
      "binding:e1": binding("binding:e1", "shape:a1", "shape:B", "end"),
      "binding:s2": binding("binding:s2", "shape:a2", "shape:A", "start"),
      "binding:e2": binding("binding:e2", "shape:a2", "shape:B", "end"),
    },
    schema: {
      schemaVersion: 1,
      sequenceNumber: 0,
      storeVersion: 1,
      recordVersions: {},
    },
  } as unknown as TLStoreSnapshot;
}

describe("layout pipeline — midpoints integration (DRW-178)", () => {
  test("two parallel arrows A→B with same port pair get distinct elbowMidPoint after layout", async () => {
    const store = makeStore();
    const res = await runLayout(store, { mode: "layered-lr", scope: "all" }, new Map());

    // Layout should succeed (no elk-error).
    expect(res.reason).toBeUndefined();

    const a1updated = res.batch.updated["shape:a1"];
    const a2updated = res.batch.updated["shape:a2"];

    // Both arrows should appear in the batch (midpoints changed from 0.5).
    expect(a1updated).toBeDefined();
    expect(a2updated).toBeDefined();

    const a1mid = (a1updated![1] as { props?: { elbowMidPoint?: number } })?.props?.elbowMidPoint;
    const a2mid = (a2updated![1] as { props?: { elbowMidPoint?: number } })?.props?.elbowMidPoint;

    expect(a1mid).toBeDefined();
    expect(a2mid).toBeDefined();

    // Midpoints should differ from each other.
    expect(a1mid).not.toBe(a2mid);

    // Distribution (i+1)/(N+1) for N=2 → 1/3 and 2/3.
    const sorted = [a1mid!, a2mid!].sort((a, b) => a - b);
    expect(sorted[0]).toBeCloseTo(1 / 3, 6);
    expect(sorted[1]).toBeCloseTo(2 / 3, 6);
  });

  test("single arrow keeps default 0.5 (no midpoint update emitted for singletons)", async () => {
    const singleStore: TLStoreSnapshot = {
      store: {
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
          props: { w: 400, h: 300, name: "F" },
          meta: {},
        },
        "shape:A": {
          id: "shape:A",
          typeName: "shape",
          type: "geo",
          x: 0,
          y: 0,
          parentId: "shape:frame",
          index: "a1",
          isLocked: false,
          opacity: 1,
          rotation: 0,
          props: { geo: "rectangle", w: 120, h: 60 },
          meta: {},
        },
        "shape:B": {
          id: "shape:B",
          typeName: "shape",
          type: "geo",
          x: 0,
          y: 0,
          parentId: "shape:frame",
          index: "a2",
          isLocked: false,
          opacity: 1,
          rotation: 0,
          props: { geo: "rectangle", w: 120, h: 60 },
          meta: {},
        },
        "shape:a1": {
          id: "shape:a1",
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
          meta: { didrawSourcePort: "right", didrawTargetPort: "left" },
        },
        "binding:s1": {
          id: "binding:s1",
          typeName: "binding",
          type: "arrow",
          fromId: "shape:a1",
          toId: "shape:A",
          props: {
            terminal: "start",
            normalizedAnchor: { x: 0.5, y: 0.5 },
            isExact: false,
            isPrecise: true,
            snap: "none",
          },
        },
        "binding:e1": {
          id: "binding:e1",
          typeName: "binding",
          type: "arrow",
          fromId: "shape:a1",
          toId: "shape:B",
          props: {
            terminal: "end",
            normalizedAnchor: { x: 0.5, y: 0.5 },
            isExact: false,
            isPrecise: true,
            snap: "none",
          },
        },
      },
      schema: {
        schemaVersion: 1,
        sequenceNumber: 0,
        storeVersion: 1,
        recordVersions: {},
      },
    } as unknown as TLStoreSnapshot;

    const res = await runLayout(singleStore, { mode: "layered-lr", scope: "all" }, new Map());

    // Singleton arrow must NOT appear in the batch with a changed elbowMidPoint.
    // It might appear due to position changes but props.elbowMidPoint should stay 0.5.
    const a1updated = res.batch.updated["shape:a1"];
    if (a1updated) {
      // If the arrow was updated (e.g. for some other reason), midpoint must remain 0.5.
      const mid = (a1updated[1] as { props?: { elbowMidPoint?: number } })?.props?.elbowMidPoint;
      if (mid !== undefined) {
        expect(mid).toBeCloseTo(0.5, 6);
      }
    }
  });
});
