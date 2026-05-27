import { describe, expect, test } from "bun:test";
import { SPACING_PRESETS, applyPreset, reverseMapPreset } from "./presets";

describe("SPACING_PRESETS", () => {
  test("has Compact, Normal, Roomy", () => {
    expect(Object.keys(SPACING_PRESETS)).toEqual(["Compact", "Normal", "Roomy"]);
  });

  test("Normal matches DEFAULT_LAYOUT_PARAMS spacing fields", () => {
    expect(SPACING_PRESETS.Normal).toEqual({
      spacing: "normal",
      nodePadding: 16,
      containerPadding: 24,
      edgeSpacing: 16,
      edgeNodeSpacing: 20,
    });
  });

  test("each preset includes spacing field (compact/normal/loose)", () => {
    expect(SPACING_PRESETS.Compact.spacing).toBe("compact");
    expect(SPACING_PRESETS.Normal.spacing).toBe("normal");
    expect(SPACING_PRESETS.Roomy.spacing).toBe("loose");
  });
});

describe("applyPreset", () => {
  test("applies spacing + 4 numeric fields from preset, preserves other LayoutParams", () => {
    const base = {
      nodePadding: 999,
      defaultDirection: "LR" as const,
      autoDirectionEnabled: false,
    };
    const result = applyPreset(base, "Compact");
    expect(result).toMatchObject({
      spacing: "compact",
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
  test("returns Normal when spacing + all 4 fields match", () => {
    expect(reverseMapPreset({
      spacing: "normal",
      nodePadding: 16,
      containerPadding: 24,
      edgeSpacing: 16,
      edgeNodeSpacing: 20,
    })).toBe("Normal");
  });

  test("returns Compact when spacing + all 4 fields match Compact", () => {
    expect(reverseMapPreset({
      spacing: "compact",
      nodePadding: 8,
      containerPadding: 16,
      edgeSpacing: 12,
      edgeNodeSpacing: 12,
    })).toBe("Compact");
  });

  test("returns null when any field deviates (custom)", () => {
    expect(reverseMapPreset({
      spacing: "normal",
      nodePadding: 16,
      containerPadding: 24,
      edgeSpacing: 16,
      edgeNodeSpacing: 21,
    })).toBeNull();
  });

  test("returns null when spacing deviates from numeric fields preset", () => {
    expect(reverseMapPreset({
      spacing: "compact",
      nodePadding: 16,
      containerPadding: 24,
      edgeSpacing: 16,
      edgeNodeSpacing: 20,
    })).toBeNull();
  });
});
