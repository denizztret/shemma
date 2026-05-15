import { describe, expect, test } from "bun:test";
import { postProcess } from "../../src/domain/layout-postprocess";

describe("postProcess", () => {
  test("snap-to-grid rounds to 10px", () => {
    const r = postProcess({ a: { x: 12.7, y: 5.4 } }, new Map());
    expect(r.a).toEqual({ x: 10, y: 10 });   // snap up at 5
  });

  test("snap rounding goes to nearest", () => {
    expect(postProcess({ a: { x: 4, y: 4 } }, new Map()).a).toEqual({ x: 0, y: 0 });
    expect(postProcess({ a: { x: 5, y: 5 } }, new Map()).a).toEqual({ x: 10, y: 10 });
  });

  test("min-spacing pushes nodes ≥20px apart", () => {
    const sizes = new Map([
      ["a", { w: 100, h: 50 }],
      ["b", { w: 100, h: 50 }],
    ]);
    const r = postProcess(
      { a: { x: 0, y: 0 }, b: { x: 110, y: 0 } },  // gap = 10px after a's width
      sizes,
    );
    expect(r.b.x - (r.a.x + 100)).toBeGreaterThanOrEqual(20);
  });

  test("non-overlapping nodes are not touched", () => {
    const sizes = new Map([
      ["a", { w: 100, h: 50 }],
      ["b", { w: 100, h: 50 }],
    ]);
    const before = { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } };
    const r = postProcess(before, sizes);
    expect(r.b).toEqual({ x: 200, y: 0 });
  });
});
