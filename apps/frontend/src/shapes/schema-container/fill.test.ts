import { describe, it, expect } from "bun:test";
import { resolveContainerFill } from "./fill";

// Минимальный mock theme в форме `TLThemeColors` (light sub-палитра).
// Воспроизводим только нужные ветки: top-level `solid` + per-color варианты.
// Реальные значения взяты из probe-доки (DRW-186 §Task 2.3).
const mockColors = {
  solid: "#fcfffe", // top-level page-contrast (light)
  red: {
    solid: "#e03131",
    semi: "#f4dadb",
    fill: "#e03131",
    linedFill: "#e75f5f",
    pattern: "#e55959",
  },
  blue: {
    solid: "#4465e9",
    semi: "#dce1f8",
    fill: "#4465e9",
    linedFill: "#6580ec",
    pattern: "#6681ee",
  },
} as unknown as Parameters<typeof resolveContainerFill>[0];

describe("resolveContainerFill (DRW-186 Task 12)", () => {
  it("fill='none' → 'transparent'", () => {
    expect(resolveContainerFill(mockColors, "red", "none")).toBe("transparent");
    expect(resolveContainerFill(mockColors, "blue", "none")).toBe("transparent");
  });

  it("fill='solid' → palette.semi (pastel parity с native rect)", () => {
    expect(resolveContainerFill(mockColors, "red", "solid")).toBe("#f4dadb");
    expect(resolveContainerFill(mockColors, "blue", "solid")).toBe("#dce1f8");
  });

  it("fill='semi' → top-level theme.solid (page-contrast)", () => {
    expect(resolveContainerFill(mockColors, "red", "semi")).toBe("#fcfffe");
    expect(resolveContainerFill(mockColors, "blue", "semi")).toBe("#fcfffe");
  });

  it("fill='pattern' fallback → palette.semi (Pattern out of scope для v0.1)", () => {
    expect(resolveContainerFill(mockColors, "red", "pattern")).toBe("#f4dadb");
  });

  it("fill='fill' / 'lined-fill' fallback → palette.semi (UI panel не предлагает эти моды)", () => {
    expect(resolveContainerFill(mockColors, "red", "fill")).toBe("#f4dadb");
    expect(resolveContainerFill(mockColors, "red", "lined-fill")).toBe("#f4dadb");
  });
});
