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
    expect(
      (out["shape:arr"] as { props: Record<string, unknown> }).props.kind,
    ).toBe("arc");
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
    expect(
      (out["shape:arr"] as { props: Record<string, unknown> }).props.kind,
    ).toBe("elbow");
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
      (out["shape:arr"] as { props: Record<string, unknown> }).props
        .elbowMidPoint,
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
      (out["shape:arr"] as { props: Record<string, unknown> }).props
        .elbowMidPoint,
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

  it("strips legacy props.text from arrow shapes (tldraw 5.x removed text, uses richText)", () => {
    const store = {
      "shape:arr": {
        id: "shape:arr",
        typeName: "shape",
        type: "arrow",
        props: { kind: "arc", elbowMidPoint: 0.5, text: "" },
      },
    };
    const out = backfillStoreRecords(store);
    const props = (out["shape:arr"] as { props: Record<string, unknown> })
      .props;
    expect(Object.prototype.hasOwnProperty.call(props, "text")).toBe(false);
  });

  it("passes through arrow shapes without text unchanged (no spurious writes)", () => {
    const store = {
      "shape:arr": {
        id: "shape:arr",
        typeName: "shape",
        type: "arrow",
        props: { kind: "arc", elbowMidPoint: 0.5 },
      },
    };
    const out = backfillStoreRecords(store);
    expect(out["shape:arr"]).toEqual(store["shape:arr"]);
  });

  it("adds snap='none' on arrow bindings missing snap (tldraw 5.x ElbowArrowSnap)", () => {
    const store = {
      "binding:b1": {
        id: "binding:b1",
        typeName: "binding",
        type: "arrow",
        fromId: "shape:arrow1",
        toId: "shape:geo1",
        props: {
          terminal: "start",
          normalizedAnchor: { x: 0.5, y: 0.5 },
          isExact: false,
          isPrecise: false,
        },
        meta: {},
      },
    };
    const out = backfillStoreRecords(store);
    const props = (out["binding:b1"] as { props: Record<string, unknown> })
      .props;
    expect(props.snap).toBe("none");
  });

  it("does not overwrite existing snap on arrow bindings (idempotent backfill)", () => {
    const store = {
      "binding:b2": {
        id: "binding:b2",
        typeName: "binding",
        type: "arrow",
        fromId: "shape:arrow1",
        toId: "shape:geo1",
        props: {
          terminal: "end",
          normalizedAnchor: { x: 0.5, y: 0.5 },
          isExact: false,
          isPrecise: false,
          snap: "edge",
        },
        meta: {},
      },
    };
    const out = backfillStoreRecords(store);
    const props = (out["binding:b2"] as { props: Record<string, unknown> })
      .props;
    expect(props.snap).toBe("edge");
  });

  // DRW-080 — tldraw 5.x added required props.color to TLFrameShape
  // (migration AddColorProp, default "black"). Frames persisted before this
  // become invalid on loadSnapshot — backfill default.
  it("adds color='black' on frame shapes missing color", () => {
    const store = {
      "shape:fr1": {
        id: "shape:fr1",
        typeName: "shape",
        type: "frame",
        props: { w: 400, h: 300, name: "integration" },
      },
    };
    const out = backfillStoreRecords(store);
    const props = (out["shape:fr1"] as { props: Record<string, unknown> })
      .props;
    expect(props.color).toBe("black");
    expect(props.name).toBe("integration");
  });

  it("does not overwrite existing color on frame shapes (idempotent)", () => {
    const store = {
      "shape:fr2": {
        id: "shape:fr2",
        typeName: "shape",
        type: "frame",
        props: { w: 400, h: 300, name: "UIView", color: "blue" },
      },
    };
    const out = backfillStoreRecords(store);
    const props = (out["shape:fr2"] as { props: Record<string, unknown> })
      .props;
    expect(props.color).toBe("blue");
  });

  // DRW-113 — tldraw 5.x added required props to TLNoteShape via migrations:
  //   AddLabelColor    → labelColor: "black"
  //   AddFirstEditedBy → textFirstEditedBy: null
  // Notes from older `shemma_note` payloads omit them → loadSnapshot rejects.
  it("adds labelColor='black' and textFirstEditedBy=null on note shapes missing both", () => {
    const store = {
      "shape:nt1": {
        id: "shape:nt1",
        typeName: "shape",
        type: "note",
        props: { color: "yellow", size: "m", align: "middle" },
      },
    };
    const out = backfillStoreRecords(store);
    const props = (out["shape:nt1"] as { props: Record<string, unknown> })
      .props;
    expect(props.labelColor).toBe("black");
    expect(props.textFirstEditedBy).toBeNull();
    expect(props.color).toBe("yellow");
  });

  it("does not overwrite existing labelColor on note shapes (idempotent)", () => {
    const store = {
      "shape:nt2": {
        id: "shape:nt2",
        typeName: "shape",
        type: "note",
        props: {
          color: "yellow",
          labelColor: "red",
          textFirstEditedBy: "user:42",
          size: "m",
        },
      },
    };
    const out = backfillStoreRecords(store);
    const props = (out["shape:nt2"] as { props: Record<string, unknown> })
      .props;
    expect(props.labelColor).toBe("red");
    expect(props.textFirstEditedBy).toBe("user:42");
  });

  it("backfills only the missing note prop when one is already set", () => {
    const store = {
      "shape:nt3": {
        id: "shape:nt3",
        typeName: "shape",
        type: "note",
        props: { color: "blue", labelColor: "white", size: "m" },
      },
    };
    const out = backfillStoreRecords(store);
    const props = (out["shape:nt3"] as { props: Record<string, unknown> })
      .props;
    expect(props.labelColor).toBe("white");
    expect(props.textFirstEditedBy).toBeNull();
  });

  // DRW-231: raw hex props.color (e.g. from a mermaid style directive) makes
  // strict tldraw loadSnapshot throw and blanks the entire board. Coerce to the
  // nearest palette name before load.
  it("coerces a raw hex props.color to the nearest palette name", () => {
    const store = {
      "shape:c": {
        id: "shape:c",
        typeName: "shape",
        type: "schema-container",
        props: { color: "#6A1B9A", w: 200, h: 100 },
      },
    };
    const out = backfillStoreRecords(store);
    const props = (out["shape:c"] as { props: Record<string, unknown> }).props;
    expect(props.color).toBe("violet");
  });

  it("coerces a raw hex props.labelColor to the nearest palette name", () => {
    const store = {
      "shape:g": {
        id: "shape:g",
        typeName: "shape",
        type: "geo",
        props: { color: "blue", labelColor: "#E65100", w: 200, h: 100 },
      },
    };
    const out = backfillStoreRecords(store);
    const props = (out["shape:g"] as { props: Record<string, unknown> }).props;
    expect(props.color).toBe("blue"); // valid → untouched
    expect(props.labelColor).toBe("orange");
  });

  it("leaves a valid palette color untouched (idempotent, no spurious writes)", () => {
    const store = {
      "shape:g": {
        id: "shape:g",
        typeName: "shape",
        type: "geo",
        props: { color: "green", w: 200, h: 100 },
      },
    };
    const out = backfillStoreRecords(store);
    expect(out["shape:g"]).toEqual(store["shape:g"]);
  });
});
