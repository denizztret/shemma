import { describe, expect, test } from "bun:test";
import {
  applyLayoutParamsDefaults,
  validateLayoutParams,
  DEFAULT_LAYOUT_PARAMS,
  type LayoutParams,
} from "./layout-params";

describe("layout params", () => {
  test("DEFAULT_LAYOUT_PARAMS has expected baseline values", () => {
    expect(DEFAULT_LAYOUT_PARAMS.nodeMinWidth).toBe(120);
    expect(DEFAULT_LAYOUT_PARAMS.nodeMinHeight).toBe(60);
    expect(DEFAULT_LAYOUT_PARAMS.edgeLabelMaxWidth).toBe(200);
    expect(DEFAULT_LAYOUT_PARAMS.edgeLabelMaxLines).toBe(3);
    expect(DEFAULT_LAYOUT_PARAMS.edgeLabelMargin).toBe(12);
    expect(DEFAULT_LAYOUT_PARAMS.defaultDirection).toBe("TB");
    expect(DEFAULT_LAYOUT_PARAMS.autoDirectionEnabled).toBe(true);
    expect(DEFAULT_LAYOUT_PARAMS.anchorOffsetMode).toBe("distribute");
    expect(DEFAULT_LAYOUT_PARAMS.midpointDistribution).toBe("even");
  });

  test("applyLayoutParamsDefaults fills missing fields", () => {
    const full = applyLayoutParamsDefaults({});
    expect(full.nodeMinWidth).toBe(120);
    expect(full.edgeSpacing).toBe(16);
    expect(full.defaultDirection).toBe("TB");
    expect(full.autoDirectionEnabled).toBe(true);
  });

  test("user values override defaults; other defaults preserved", () => {
    const full = applyLayoutParamsDefaults({ nodeMinWidth: 200, defaultDirection: "LR" });
    expect(full.nodeMinWidth).toBe(200);
    expect(full.defaultDirection).toBe("LR");
    expect(full.nodeMinHeight).toBe(60); // default kept
  });

  test("validateLayoutParams rejects negative numeric values", () => {
    expect(() => validateLayoutParams({ nodeMinWidth: -10 } as Partial<LayoutParams>)).toThrow();
  });

  test("validateLayoutParams rejects non-finite numbers", () => {
    expect(() => validateLayoutParams({ edgeSpacing: Number.POSITIVE_INFINITY } as Partial<LayoutParams>)).toThrow();
    expect(() => validateLayoutParams({ edgeSpacing: Number.NaN } as Partial<LayoutParams>)).toThrow();
  });

  test("validateLayoutParams accepts empty object", () => {
    expect(() => validateLayoutParams({})).not.toThrow();
  });

  test("validateLayoutParams accepts complete valid object", () => {
    expect(() => validateLayoutParams({ nodeMinWidth: 150, edgeSpacing: 20, defaultDirection: "LR" })).not.toThrow();
  });

  test("validateLayoutParams rejects invalid defaultDirection enum", () => {
    expect(() => validateLayoutParams({ defaultDirection: "ZZ" } as unknown as Partial<LayoutParams>)).toThrow();
  });

  test("validateLayoutParams accepts all 4 directions", () => {
    for (const d of ["TB", "BT", "LR", "RL"] as const) {
      expect(() => validateLayoutParams({ defaultDirection: d })).not.toThrow();
    }
  });
});
