import { describe, expect, test } from "bun:test";
import { computeElbowMidpoints } from "./midpoints";
import type { TLStoreSnapshot } from "../store-types";

function makeArrow(id: string, srcSide: string, dstSide: string): any {
  return {
    id,
    typeName: "shape",
    type: "arrow",
    x: 0,
    y: 0,
    parentId: "page:page",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { kind: "elbow", elbowMidPoint: 0.5 },
    meta: { didrawSourcePort: srcSide, didrawTargetPort: dstSide },
  };
}

function makeBinding(
  id: string,
  fromId: string,
  toId: string,
  terminal: "start" | "end"
): any {
  return {
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
  };
}

function makeStore(records: Record<string, any>): TLStoreSnapshot {
  return {
    store: records,
    schema: {
      schemaVersion: 1,
      sequenceNumber: 0,
      storeVersion: 1,
      recordVersions: {},
    },
  } as unknown as TLStoreSnapshot;
}

describe("computeElbowMidpoints", () => {
  test("single arrow keeps default 0.5 (no update emitted)", () => {
    const store = makeStore({
      "shape:a1": makeArrow("shape:a1", "right", "left"),
      "binding:s1": makeBinding("binding:s1", "shape:a1", "shape:A", "start"),
      "binding:e1": makeBinding("binding:e1", "shape:a1", "shape:B", "end"),
    });
    const batch = computeElbowMidpoints(store);
    expect(Object.keys(batch.updated).length).toBe(0);
  });

  test("three arrows same source/target sides get 0.25/0.5/0.75", () => {
    const store = makeStore({
      "shape:a1": makeArrow("shape:a1", "right", "top"),
      "shape:a2": makeArrow("shape:a2", "right", "top"),
      "shape:a3": makeArrow("shape:a3", "right", "top"),
      "binding:s1": makeBinding("binding:s1", "shape:a1", "shape:A", "start"),
      "binding:e1": makeBinding("binding:e1", "shape:a1", "shape:B", "end"),
      "binding:s2": makeBinding("binding:s2", "shape:a2", "shape:A", "start"),
      "binding:e2": makeBinding("binding:e2", "shape:a2", "shape:B", "end"),
      "binding:s3": makeBinding("binding:s3", "shape:a3", "shape:A", "start"),
      "binding:e3": makeBinding("binding:e3", "shape:a3", "shape:B", "end"),
    });
    const batch = computeElbowMidpoints(store);
    // a1 and a3 change from 0.5 to 0.25 and 0.75 respectively
    // a2 stays at 0.5, so it's not emitted
    expect((batch.updated["shape:a1"]?.[1] as any)?.props?.elbowMidPoint).toBe(0.25);
    expect((batch.updated["shape:a3"]?.[1] as any)?.props?.elbowMidPoint).toBe(0.75);
    expect(batch.updated["shape:a2"]).toBeUndefined();
  });

  test("different sides do not share a group (each stays singleton at 0.5)", () => {
    const store = makeStore({
      "shape:a1": makeArrow("shape:a1", "right", "top"),
      "shape:a2": makeArrow("shape:a2", "right", "bottom"),
      "binding:s1": makeBinding("binding:s1", "shape:a1", "shape:A", "start"),
      "binding:e1": makeBinding("binding:e1", "shape:a1", "shape:B", "end"),
      "binding:s2": makeBinding("binding:s2", "shape:a2", "shape:A", "start"),
      "binding:e2": makeBinding("binding:e2", "shape:a2", "shape:B", "end"),
    });
    const batch = computeElbowMidpoints(store);
    expect(Object.keys(batch.updated).length).toBe(0);
  });

  test("arrows without port meta are skipped", () => {
    const a: any = makeArrow("shape:a1", "right", "left");
    delete a.meta.didrawSourcePort;
    const store = makeStore({
      "shape:a1": a,
      "binding:s1": makeBinding("binding:s1", "shape:a1", "shape:A", "start"),
      "binding:e1": makeBinding("binding:e1", "shape:a1", "shape:B", "end"),
    });
    const batch = computeElbowMidpoints(store);
    expect(Object.keys(batch.updated).length).toBe(0);
  });

  test("arrows that are not elbow are skipped", () => {
    const a: any = makeArrow("shape:a1", "right", "top");
    a.props.kind = "arc";
    const a2: any = makeArrow("shape:a2", "right", "top");
    a2.props.kind = "arc";
    const store = makeStore({
      "shape:a1": a,
      "shape:a2": a2,
      "binding:s1": makeBinding("binding:s1", "shape:a1", "shape:A", "start"),
      "binding:e1": makeBinding("binding:e1", "shape:a1", "shape:B", "end"),
      "binding:s2": makeBinding("binding:s2", "shape:a2", "shape:A", "start"),
      "binding:e2": makeBinding("binding:e2", "shape:a2", "shape:B", "end"),
    });
    const batch = computeElbowMidpoints(store);
    expect(Object.keys(batch.updated).length).toBe(0);
  });

  test("does not emit update if midpoint already correct", () => {
    const a1: any = makeArrow("shape:a1", "right", "top");
    a1.props.elbowMidPoint = 1 / 3;
    const a2: any = makeArrow("shape:a2", "right", "top");
    a2.props.elbowMidPoint = 2 / 3;
    const store = makeStore({
      "shape:a1": a1,
      "shape:a2": a2,
      "binding:s1": makeBinding("binding:s1", "shape:a1", "shape:A", "start"),
      "binding:e1": makeBinding("binding:e1", "shape:a1", "shape:B", "end"),
      "binding:s2": makeBinding("binding:s2", "shape:a2", "shape:A", "start"),
      "binding:e2": makeBinding("binding:e2", "shape:a2", "shape:B", "end"),
    });
    const batch = computeElbowMidpoints(store);
    expect(Object.keys(batch.updated).length).toBe(0);
  });
});
