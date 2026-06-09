// apps/frontend/src/canvas/pin-auto-toggle.test.ts
//
// Pure-helper tests для pin-auto-toggle module.
// Logic concentrated в pure helpers (computePinUpdates, shouldPin) —
// state-machine wiring смотрится в live verification через dev stand.

import { describe, expect, it } from "bun:test";
import type { TLShapeId } from "tldraw";
import { computePinUpdates, shouldPin, type BBox, type Snapshot } from "./pin-auto-toggle";

describe("computePinUpdates — module smoke", () => {
  it("exports computePinUpdates as a function", () => {
    expect(typeof computePinUpdates).toBe("function");
  });
});

describe("shouldPin — threshold detection", () => {
  const baseSnap = { x: 0, y: 0, w: 100, h: 100, type: "geo" };

  it("returns moved=false, resized=false when no change", () => {
    const result = shouldPin(baseSnap, { x: 0, y: 0, w: 100, h: 100 });
    expect(result.moved).toBe(false);
    expect(result.resized).toBe(false);
  });

  it("detects movement when x changes >=1px", () => {
    const result = shouldPin(baseSnap, { x: 10, y: 0, w: 100, h: 100 });
    expect(result.moved).toBe(true);
    expect(result.resized).toBe(false);
  });

  it("detects movement when y changes >=1px", () => {
    const result = shouldPin(baseSnap, { x: 0, y: 5, w: 100, h: 100 });
    expect(result.moved).toBe(true);
    expect(result.resized).toBe(false);
  });

  it("detects resize when w changes >=1px", () => {
    const result = shouldPin(baseSnap, { x: 0, y: 0, w: 120, h: 100 });
    expect(result.moved).toBe(false);
    expect(result.resized).toBe(true);
  });

  it("detects resize when h changes >=1px", () => {
    const result = shouldPin(baseSnap, { x: 0, y: 0, w: 100, h: 80 });
    expect(result.moved).toBe(false);
    expect(result.resized).toBe(true);
  });

  it("ignores subpixel changes (<1px combined)", () => {
    const result = shouldPin(baseSnap, { x: 0.3, y: 0.2, w: 100, h: 100 });
    // abs(0.3) + abs(0.2) = 0.5 < 1 → moved=false
    expect(result.moved).toBe(false);
  });

  it("detects movement + resize combined", () => {
    const result = shouldPin(baseSnap, { x: 10, y: 10, w: 120, h: 80 });
    expect(result.moved).toBe(true);
    expect(result.resized).toBe(true);
  });
});

describe("computePinUpdates — diff and meta", () => {
  // Helper для builds mock getCurrent function.
  const makeGetCurrent = (
    shapes: Record<string, BBox & { type: string; meta: Record<string, unknown> }>,
  ) => (id: string) => shapes[id];

  it("returns empty when snapshot is empty", () => {
    const snapshot: Snapshot = new Map();
    const result = computePinUpdates(snapshot, makeGetCurrent({}), "translating");
    expect(result).toEqual([]);
  });

  it("returns empty when no shape moved", () => {
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({
      "shape:a": { x: 0, y: 0, w: 100, h: 100, type: "geo", meta: {} },
    });
    const result = computePinUpdates(snapshot, getCurrent, "translating");
    expect(result).toEqual([]);
  });

  it("sets pinned=true on translate with movement", () => {
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({
      "shape:a": { x: 50, y: 0, w: 100, h: 100, type: "geo", meta: { foo: "bar" } },
    });
    const result = computePinUpdates(snapshot, getCurrent, "translating");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("shape:a");
    expect(result[0].type).toBe("geo");
    expect(result[0].meta.pinned).toBe(true);
    expect(result[0].meta.didrawSizePinned).toBeUndefined();
    // Preserves existing meta.
    expect(result[0].meta.foo).toBe("bar");
  });

  it("sets both pinned and didrawSizePinned on resize with bbox change", () => {
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({
      "shape:a": { x: 0, y: 0, w: 150, h: 120, type: "geo", meta: {} },
    });
    const result = computePinUpdates(snapshot, getCurrent, "resizing");
    expect(result).toHaveLength(1);
    expect(result[0].meta.pinned).toBe(true);
    expect(result[0].meta.didrawSizePinned).toBe(true);
    // DRW-232: a user drag-resize marks the size as user-owned → auto-text-fit
    // never re-fits over it (distinct from auto-fit's origin "fit").
    expect(result[0].meta.didrawSizeOrigin).toBe("user");
  });

  it("DRW-232: user resize overrides a prior auto-fit origin (fit → user)", () => {
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({
      "shape:a": {
        x: 0,
        y: 0,
        w: 150,
        h: 120,
        type: "geo",
        meta: { didrawSizePinned: true, didrawSizeOrigin: "fit" },
      },
    });
    const result = computePinUpdates(snapshot, getCurrent, "resizing");
    expect(result[0].meta.didrawSizeOrigin).toBe("user");
  });

  it("does not set didrawSizePinned on translate-only (no resize)", () => {
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({
      "shape:a": { x: 50, y: 50, w: 100, h: 100, type: "geo", meta: {} },
    });
    const result = computePinUpdates(snapshot, getCurrent, "translating");
    expect(result[0].meta.didrawSizePinned).toBeUndefined();
    // DRW-232: a move never marks size-origin (size didn't change).
    expect(result[0].meta.didrawSizeOrigin).toBeUndefined();
  });

  it("handles resize with no bbox movement (anchored resize)", () => {
    // Resize в правый нижний угол: x/y не меняются, только w/h.
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({
      "shape:a": { x: 0, y: 0, w: 150, h: 100, type: "geo", meta: {} },
    });
    const result = computePinUpdates(snapshot, getCurrent, "resizing");
    expect(result).toHaveLength(1);
    expect(result[0].meta.pinned).toBe(true);  // resize всегда pin'ит position
    expect(result[0].meta.didrawSizePinned).toBe(true);
  });

  it("handles multi-shape: pins each shape with movement, skips unchanged", () => {
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
      ["shape:b" as TLShapeId, { x: 200, y: 0, w: 100, h: 100, type: "geo" }],
      ["shape:c" as TLShapeId, { x: 400, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({
      "shape:a": { x: 50, y: 0, w: 100, h: 100, type: "geo", meta: {} },
      "shape:b": { x: 200, y: 0, w: 100, h: 100, type: "geo", meta: {} },  // unchanged
      "shape:c": { x: 450, y: 50, w: 100, h: 100, type: "geo", meta: {} },
    });
    const result = computePinUpdates(snapshot, getCurrent, "translating");
    const ids = result.map((u) => u.id);
    expect(ids).toContain("shape:a");
    expect(ids).toContain("shape:c");
    expect(ids).not.toContain("shape:b");
  });

  it("skips shape if getCurrent returns undefined (e.g., deleted)", () => {
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({}); // pretend a was deleted
    const result = computePinUpdates(snapshot, getCurrent, "translating");
    expect(result).toEqual([]);
  });
});
