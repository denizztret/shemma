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

  test("different target sides from different sources each stay singleton (no common group)", () => {
    // Two arrows with completely disjoint (source, sourceSide, target, targetSide) — singleton in both perspectives
    const store = makeStore({
      "shape:a1": makeArrow("shape:a1", "right", "top"),
      "shape:a2": makeArrow("shape:a2", "left", "bottom"),
      "binding:s1": makeBinding("binding:s1", "shape:a1", "shape:A", "start"),
      "binding:e1": makeBinding("binding:e1", "shape:a1", "shape:B", "end"),
      "binding:s2": makeBinding("binding:s2", "shape:a2", "shape:C", "start"),
      "binding:e2": makeBinding("binding:e2", "shape:a2", "shape:D", "end"),
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

describe("computeElbowMidpoints — fan-in / fan-out (DRW-178 Task 2.5)", () => {
  test("three arrows from different sources into same target+side (fan-in) get 0.25/0.5/0.75", () => {
    // VP→EP, EM→EP, PX→EP all enter EP from top
    const px: any = makeArrow("shape:px_ep", "bottom", "top");
    px.props.elbowMidPoint = 0.1; // Start with non-0.5 to track update
    const store = makeStore({
      "shape:vp_ep": makeArrow("shape:vp_ep", "bottom", "top"),
      "shape:em_ep": makeArrow("shape:em_ep", "bottom", "top"),
      "shape:px_ep": px,
      "binding:vps": makeBinding("binding:vps", "shape:vp_ep", "shape:VP", "start"),
      "binding:vpe": makeBinding("binding:vpe", "shape:vp_ep", "shape:EP", "end"),
      "binding:ems": makeBinding("binding:ems", "shape:em_ep", "shape:EM", "start"),
      "binding:eme": makeBinding("binding:eme", "shape:em_ep", "shape:EP", "end"),
      "binding:pxs": makeBinding("binding:pxs", "shape:px_ep", "shape:PX", "start"),
      "binding:pxe": makeBinding("binding:pxe", "shape:px_ep", "shape:EP", "end"),
    });
    const batch = computeElbowMidpoints(store);
    const mids = ["shape:em_ep", "shape:px_ep", "shape:vp_ep"].map(
      (id) => (batch.updated[id]?.[1] as any)?.props?.elbowMidPoint
    );
    // Sorted by id: em_ep < px_ep < vp_ep → 0.25 / 0.5 / 0.75
    expect(mids).toEqual([0.25, 0.5, 0.75]);
  });

  test("two arrows from same source+side to different targets (fan-out) get 1/3 and 2/3", () => {
    // ED→AS, ED→DS both leave ED from bottom
    const store = makeStore({
      "shape:ed_as": makeArrow("shape:ed_as", "bottom", "top"),
      "shape:ed_ds": makeArrow("shape:ed_ds", "bottom", "top"),
      "binding:eds1": makeBinding("binding:eds1", "shape:ed_as", "shape:ED", "start"),
      "binding:ede1": makeBinding("binding:ede1", "shape:ed_as", "shape:AS", "end"),
      "binding:eds2": makeBinding("binding:eds2", "shape:ed_ds", "shape:ED", "start"),
      "binding:ede2": makeBinding("binding:ede2", "shape:ed_ds", "shape:DS", "end"),
    });
    const batch = computeElbowMidpoints(store);
    const mids = ["shape:ed_as", "shape:ed_ds"].map(
      (id) => (batch.updated[id]?.[1] as any)?.props?.elbowMidPoint
    );
    expect(mids).toEqual([1 / 3, 2 / 3]);
  });

  test("fan-in priority: arrow in both size-3 fan-in and size-2 fan-out groups uses fan-in", () => {
    // Fan-in group: 3 arrows into (EP, top): vp→ep, em→ep, ed→ep
    // Fan-out group: 2 arrows from (EM, bottom): em→ep, em→x
    // The em→ep arrow is in BOTH; fan-in (size 3) wins.
    const vp: any = makeArrow("shape:vp_ep", "bottom", "top");
    vp.props.elbowMidPoint = 0.1; // Start with non-0.5 to track update
    const em: any = makeArrow("shape:em_ep", "bottom", "top");
    em.props.elbowMidPoint = 0.2;
    const ed: any = makeArrow("shape:ed_ep", "bottom", "top");
    ed.props.elbowMidPoint = 0.3;
    const store = makeStore({
      "shape:vp_ep": vp,
      "shape:em_ep": em,
      "shape:ed_ep": ed,
      "shape:em_x": makeArrow("shape:em_x", "bottom", "top"),
      "binding:vps": makeBinding("binding:vps", "shape:vp_ep", "shape:VP", "start"),
      "binding:vpe": makeBinding("binding:vpe", "shape:vp_ep", "shape:EP", "end"),
      "binding:ems1": makeBinding("binding:ems1", "shape:em_ep", "shape:EM", "start"),
      "binding:eme1": makeBinding("binding:eme1", "shape:em_ep", "shape:EP", "end"),
      "binding:eds": makeBinding("binding:eds", "shape:ed_ep", "shape:ED", "start"),
      "binding:ede": makeBinding("binding:ede", "shape:ed_ep", "shape:EP", "end"),
      "binding:ems2": makeBinding("binding:ems2", "shape:em_x", "shape:EM", "start"),
      "binding:eme2": makeBinding("binding:eme2", "shape:em_x", "shape:X", "end"),
    });
    const batch = computeElbowMidpoints(store);
    // em_ep is in fan-in group {ed_ep, em_ep, vp_ep} sorted by id; index 1 → midpoint 2/4 = 0.5
    const emEpMid = (batch.updated["shape:em_ep"]?.[1] as any)?.props?.elbowMidPoint;
    // It should be 0.5 (fan-in distribution position) NOT (1/3 or 2/3) from fan-out distribution
    expect(emEpMid).toBe(0.5);
  });

  test("isolated arrow (no fan-in, no fan-out) stays at 0.5 (no update)", () => {
    const store = makeStore({
      "shape:a": makeArrow("shape:a", "right", "left"),
      "binding:s": makeBinding("binding:s", "shape:a", "shape:A", "start"),
      "binding:e": makeBinding("binding:e", "shape:a", "shape:B", "end"),
    });
    const batch = computeElbowMidpoints(store);
    expect(Object.keys(batch.updated).length).toBe(0);
  });
});

describe("computeElbowMidpoints — params control", () => {
  test("midpointDistribution=fixed-0.5 → empty batch (no distribution)", () => {
    const store = makeStore({
      "shape:a1": makeArrow("shape:a1", "right", "top"),
      "shape:a2": makeArrow("shape:a2", "right", "top"),
      "binding:s1": makeBinding("binding:s1", "shape:a1", "shape:A", "start"),
      "binding:e1": makeBinding("binding:e1", "shape:a1", "shape:B", "end"),
      "binding:s2": makeBinding("binding:s2", "shape:a2", "shape:A", "start"),
      "binding:e2": makeBinding("binding:e2", "shape:a2", "shape:B", "end"),
    });
    const batch = computeElbowMidpoints(store, { midpointDistribution: "fixed-0.5" });
    expect(Object.keys(batch.updated).length).toBe(0);
  });

  test("midpointDistribution=even (default) → distributes (existing behavior)", () => {
    const store = makeStore({
      "shape:a1": makeArrow("shape:a1", "right", "top"),
      "shape:a2": makeArrow("shape:a2", "right", "top"),
      "binding:s1": makeBinding("binding:s1", "shape:a1", "shape:A", "start"),
      "binding:e1": makeBinding("binding:e1", "shape:a1", "shape:B", "end"),
      "binding:s2": makeBinding("binding:s2", "shape:a2", "shape:A", "start"),
      "binding:e2": makeBinding("binding:e2", "shape:a2", "shape:B", "end"),
    });
    const batch = computeElbowMidpoints(store, { midpointDistribution: "even" });
    expect(Object.keys(batch.updated).length).toBe(2);
  });
});
