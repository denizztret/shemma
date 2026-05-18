// Tests for backfillStoreRecords — legacy field backfill (DRW-076).
//
// tldraw 5.x added required props on arrow shapes that legacy rooms lack.
// backfillStoreRecords must add defaults idempotently so loadSnapshot passes
// validation without touching user data.

import { describe, expect, it } from "bun:test";
import { backfillStoreRecords } from "./schema-placeholder";

describe("backfillStoreRecords", () => {
  it("adds kind='arc' on arrow shapes missing kind", () => {
    const store = {
      "shape:arr": {
        id: "shape:arr",
        typeName: "shape",
        type: "arrow",
        props: { bend: 0 },
      },
    };
    const out = backfillStoreRecords(store);
    expect((out["shape:arr"] as { props: Record<string, unknown> }).props.kind).toBe("arc");
  });

  it("does not overwrite existing kind on arrow shapes", () => {
    const store = {
      "shape:arr": {
        id: "shape:arr",
        typeName: "shape",
        type: "arrow",
        props: { kind: "elbow", bend: 0 },
      },
    };
    const out = backfillStoreRecords(store);
    expect((out["shape:arr"] as { props: Record<string, unknown> }).props.kind).toBe("elbow");
  });

  it("adds elbowMidPoint=0.5 on arrow shapes missing elbowMidPoint (tldraw 5.0+ schema)", () => {
    const store = {
      "shape:arr": {
        id: "shape:arr",
        typeName: "shape",
        type: "arrow",
        props: { kind: "arc", bend: 0 },
      },
    };
    const out = backfillStoreRecords(store);
    expect(
      (out["shape:arr"] as { props: Record<string, unknown> }).props.elbowMidPoint,
    ).toBe(0.5);
  });

  it("does not overwrite existing elbowMidPoint on arrow shapes", () => {
    const store = {
      "shape:arr": {
        id: "shape:arr",
        typeName: "shape",
        type: "arrow",
        props: { kind: "arc", elbowMidPoint: 0.75 },
      },
    };
    const out = backfillStoreRecords(store);
    expect(
      (out["shape:arr"] as { props: Record<string, unknown> }).props.elbowMidPoint,
    ).toBe(0.75);
  });

  it("passes through non-arrow shapes unchanged", () => {
    const store = {
      "shape:geo": {
        id: "shape:geo",
        typeName: "shape",
        type: "geo",
        props: { w: 100 },
      },
    };
    const out = backfillStoreRecords(store);
    expect(out["shape:geo"]).toEqual(store["shape:geo"]);
  });

  it("returns empty object for undefined store", () => {
    const out = backfillStoreRecords(undefined);
    expect(out).toEqual({});
  });
});
