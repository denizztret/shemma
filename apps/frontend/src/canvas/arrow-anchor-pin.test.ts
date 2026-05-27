// apps/frontend/src/canvas/arrow-anchor-pin.test.ts
//
// Pure-helper tests для DRW-190 arrow-anchor-pin module.
// Wiring (registerArrowAnchorPin) — live-verified в browser.

import { describe, expect, test } from "bun:test";
import {
  computeBindingPinUpdates,
  shouldPinBinding,
  type BindingSnapshot,
  type Snapshot,
} from "./arrow-anchor-pin";

function makeSnapshot(opts: {
  bindingId?: string;
  toId?: string;
  anchor?: { x: number; y: number };
  isExact?: boolean;
}): BindingSnapshot {
  return {
    bindingId: opts.bindingId ?? "binding:1",
    arrowId: "shape:arrow1",
    terminal: "start",
    toId: opts.toId ?? "shape:target1",
    normalizedAnchor: opts.anchor ?? { x: 0.5, y: 0.5 },
    isExact: opts.isExact ?? false,
  };
}

describe("shouldPinBinding", () => {
  test("returns true when normalizedAnchor changed", () => {
    const before = makeSnapshot({ anchor: { x: 0.5, y: 0.5 } });
    const result = shouldPinBinding(before, {
      toId: before.toId,
      normalizedAnchor: { x: 0.2, y: 0.8 },
      isExact: false,
    });
    expect(result).toBe(true);
  });

  test("returns true when bound to different shape", () => {
    const before = makeSnapshot({ toId: "shape:target-A" });
    const result = shouldPinBinding(before, {
      toId: "shape:target-B",
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
    });
    expect(result).toBe(true);
  });

  test("returns false when anchor unchanged within threshold", () => {
    const before = makeSnapshot({ anchor: { x: 0.5, y: 0.5 } });
    const result = shouldPinBinding(before, {
      toId: before.toId,
      normalizedAnchor: { x: 0.5001, y: 0.5 },
      isExact: false,
    });
    expect(result).toBe(false);
  });

  test("returns false when already pinned (isExact=true)", () => {
    const before = makeSnapshot({ anchor: { x: 0.5, y: 0.5 } });
    const result = shouldPinBinding(before, {
      toId: before.toId,
      normalizedAnchor: { x: 0.1, y: 0.1 },
      isExact: true,
    });
    expect(result).toBe(false);
  });
});

describe("computeBindingPinUpdates", () => {
  test("returns ids of bindings that moved", () => {
    const snapshot: Snapshot = new Map([
      ["b1", makeSnapshot({ bindingId: "b1", anchor: { x: 0.5, y: 0.5 } })],
      ["b2", makeSnapshot({ bindingId: "b2", anchor: { x: 0.5, y: 0.5 } })],
    ]);
    const ids = computeBindingPinUpdates(snapshot, (id) => {
      if (id === "b1") {
        return {
          toId: "shape:target1",
          normalizedAnchor: { x: 0.5, y: 0.5 },
          isExact: false,
        };
      }
      return {
        toId: "shape:target1",
        normalizedAnchor: { x: 0.2, y: 0.8 },
        isExact: false,
      };
    });
    expect(ids).toEqual(["b2"]);
  });

  test("skips bindings that no longer exist", () => {
    const snapshot: Snapshot = new Map([
      ["b1", makeSnapshot({ bindingId: "b1", anchor: { x: 0.5, y: 0.5 } })],
    ]);
    const ids = computeBindingPinUpdates(snapshot, () => undefined);
    expect(ids).toEqual([]);
  });

  test("returns empty when nothing moved", () => {
    const snapshot: Snapshot = new Map([
      ["b1", makeSnapshot({ bindingId: "b1", anchor: { x: 0.5, y: 0.5 } })],
    ]);
    const ids = computeBindingPinUpdates(snapshot, () => ({
      toId: "shape:target1",
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
    }));
    expect(ids).toEqual([]);
  });

  test("skips bindings already pinned even if moved", () => {
    const snapshot: Snapshot = new Map([
      ["b1", makeSnapshot({ bindingId: "b1", anchor: { x: 0.5, y: 0.5 } })],
    ]);
    const ids = computeBindingPinUpdates(snapshot, () => ({
      toId: "shape:target1",
      normalizedAnchor: { x: 0.1, y: 0.1 },
      isExact: true,
    }));
    expect(ids).toEqual([]);
  });
});
