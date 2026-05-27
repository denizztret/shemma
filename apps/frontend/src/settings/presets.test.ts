import { describe, expect, test } from "bun:test";
import { SPACING_PRESETS, applyPreset, reverseMapPreset } from "./presets";

describe("SPACING_PRESETS", () => {
  test("has Compact, Normal, Roomy", () => {
    expect(Object.keys(SPACING_PRESETS)).toEqual(["Compact", "Normal", "Roomy"]);
  });

  test("Normal matches DEFAULT_LAYOUT_PARAMS spacing fields", () => {
    expect(SPACING_PRESETS.Normal).toEqual({
      nodePadding: 16,
      containerPadding: 24,
      edgeSpacing: 16,
      edgeNodeSpacing: 20,
    });
  });
});

describe("applyPreset", () => {
  test("applies all 4 fields from preset, preserves other LayoutParams", () => {
    const base = {
      nodePadding: 999,
      defaultDirection: "LR" as const,
      autoDirectionEnabled: false,
    };
    const result = applyPreset(base, "Compact");
    expect(result).toMatchObject({
      nodePadding: 8,
      containerPadding: 16,
      edgeSpacing: 12,
      edgeNodeSpacing: 12,
      defaultDirection: "LR",
      autoDirectionEnabled: false,
    });
  });
});

describe("reverseMapPreset", () => {
  test("returns Normal when all 4 fields match", () => {
    expect(reverseMapPreset({
      nodePadding: 16,
      containerPadding: 24,
      edgeSpacing: 16,
      edgeNodeSpacing: 20,
    })).toBe("Normal");
  });

  test("returns Compact when all 4 fields match Compact", () => {
    expect(reverseMapPreset({
      nodePadding: 8,
      containerPadding: 16,
      edgeSpacing: 12,
      edgeNodeSpacing: 12,
    })).toBe("Compact");
  });

  test("returns null when any field deviates (custom)", () => {
    expect(reverseMapPreset({
      nodePadding: 16,
      containerPadding: 24,
      edgeSpacing: 16,
      edgeNodeSpacing: 21,
    })).toBeNull();
  });
});
