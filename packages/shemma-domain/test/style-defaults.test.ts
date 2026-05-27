import { describe, expect, it } from "bun:test";
import {
  validateStyleDefaults,
  applyStyleDefaultsResolution,
  DEFAULT_STYLE_DEFAULTS,
  type StyleDefaults,
} from "../src/style-defaults";

describe("validateStyleDefaults", () => {
  it("accepts empty object", () => {
    expect(() => validateStyleDefaults({})).not.toThrow();
  });

  it("accepts valid full object", () => {
    expect(() =>
      validateStyleDefaults({ dash: "solid", font: "sans", size: "m" }),
    ).not.toThrow();
  });

  it("rejects invalid dash", () => {
    expect(() =>
      validateStyleDefaults({ dash: "dashed" as never }),
    ).toThrow(/dash/);
  });

  it("rejects invalid font", () => {
    expect(() =>
      validateStyleDefaults({ font: "serif" as never }),
    ).toThrow(/font/);
  });

  it("rejects invalid size", () => {
    expect(() =>
      validateStyleDefaults({ size: "xxl" as never }),
    ).toThrow(/size/);
  });
});

describe("applyStyleDefaultsResolution", () => {
  it("returns native defaults when no chain", () => {
    expect(applyStyleDefaultsResolution([])).toEqual(DEFAULT_STYLE_DEFAULTS);
  });

  it("nearest-first wins per key", () => {
    const room: StyleDefaults = { dash: "solid", font: "sans", size: "m" };
    const frame: StyleDefaults = { font: "mono" };
    expect(applyStyleDefaultsResolution([frame, room])).toEqual({
      dash: "solid",
      font: "mono",
      size: "m",
    });
  });

  it("undefined fields fall through", () => {
    const partial: StyleDefaults = { dash: "draw" };
    expect(applyStyleDefaultsResolution([partial])).toEqual({
      dash: "draw",
      font: "draw",
      size: "m",
    });
  });
});
