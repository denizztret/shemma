import { describe, it, expect } from "bun:test";
import { applyResize } from "../widths";

describe("applyResize", () => {
  it("shifts width from i+1 to i for positive delta", () => {
    expect(applyResize([50, 50], 0, 10)).toEqual([60, 40]);
  });

  it("shifts width from i to i+1 for negative delta", () => {
    expect(applyResize([50, 50], 0, -10)).toEqual([40, 60]);
  });

  it("clamps to min 10% on the right side", () => {
    expect(applyResize([50, 50], 0, 50)).toEqual([90, 10]);
  });

  it("clamps to min 10% on the left side", () => {
    expect(applyResize([50, 50], 0, -50)).toEqual([10, 90]);
  });

  it("preserves total width during clamp", () => {
    const result = applyResize([30, 70], 0, 100);
    expect(result[0] + result[1]).toBe(100);
  });

  it("returns copy of input if index out of range", () => {
    const orig = [50, 50];
    const result = applyResize(orig, 2, 10);
    expect(result).toEqual(orig);
    expect(result).not.toBe(orig);
  });

  it("works with 3 columns affecting only the targeted pair", () => {
    expect(applyResize([30, 30, 40], 0, 10)).toEqual([40, 20, 40]);
  });

  it("does not affect untargeted columns when clamping", () => {
    const result = applyResize([30, 30, 40], 0, 50);
    expect(result[2]).toBe(40); // untouched
    expect(result[0] + result[1]).toBe(60); // pair preserved
  });
});
