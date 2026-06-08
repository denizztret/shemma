import { describe, expect, test } from "bun:test";
import { TLDRAW_COLOR_NAMES, coerceColor, isValidColor } from "./color";

describe("TLDRAW_COLOR_NAMES", () => {
  test("matches tldraw DefaultColorStyle (13 named colors incl. white)", () => {
    expect([...TLDRAW_COLOR_NAMES].sort()).toEqual(
      [
        "black",
        "blue",
        "green",
        "grey",
        "light-blue",
        "light-green",
        "light-red",
        "light-violet",
        "orange",
        "red",
        "violet",
        "white",
        "yellow",
      ].sort(),
    );
  });
});

describe("isValidColor", () => {
  test("accepts every palette name", () => {
    for (const c of TLDRAW_COLOR_NAMES) expect(isValidColor(c)).toBe(true);
  });

  test("rejects hex, css names, and non-strings", () => {
    expect(isValidColor("#6A1B9A")).toBe(false);
    expect(isValidColor("purple")).toBe(false);
    expect(isValidColor("")).toBe(false);
    expect(isValidColor(undefined)).toBe(false);
    expect(isValidColor(42)).toBe(false);
  });
});

describe("coerceColor", () => {
  test("passes a valid palette name through unchanged", () => {
    expect(coerceColor("violet")).toBe("violet");
    expect(coerceColor("white")).toBe("white");
    expect(coerceColor("black")).toBe("black");
  });

  test("maps Material hex to the nearest palette name", () => {
    // The exact case from ios/tests-1 that blanked the board.
    expect(coerceColor("#6A1B9A")).toBe("violet");
    expect(coerceColor("#1565C0")).toBe("blue");
    expect(coerceColor("#2E7D32")).toBe("green");
    expect(coerceColor("#E65100")).toBe("orange");
  });

  test("handles 3-digit hex", () => {
    expect(coerceColor("#fff")).toBe("white");
    expect(coerceColor("#000")).toBe("black");
  });

  test("falls back to default for non-hex / garbage input", () => {
    expect(coerceColor("purple")).toBe("black");
    expect(coerceColor("")).toBe("black");
    expect(coerceColor(undefined)).toBe("black");
    expect(coerceColor(123 as unknown as string)).toBe("black");
  });

  test("respects a custom fallback", () => {
    expect(coerceColor("nonsense", "grey")).toBe("grey");
    expect(coerceColor(undefined, "grey")).toBe("grey");
  });
});
