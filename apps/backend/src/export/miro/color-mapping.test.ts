import { describe, expect, it } from "bun:test";
import {
  nearestShapeColor,
  nearestStickyColor,
  SHAPE_PRESETS,
  STICKY_COLOR_RGB,
} from "./color-mapping";

describe("nearestShapeColor — happy path", () => {
  it("pure white #ffffff → exact match (#ffffff in preset)", () => {
    expect(nearestShapeColor("#ffffff")).toBe("#ffffff");
  });

  it("near-red #ff2200 → red-family preset (not white, not blue)", () => {
    const result = nearestShapeColor("#ff2200");
    const [r, , b] = parseHexHelper(result);
    expect(r).toBeGreaterThan(180);
    expect(b).toBeLessThan(100);
  });

  it("near-blue #4488ff → blue-family preset", () => {
    const result = nearestShapeColor("#4488ff");
    const [r, , b] = parseHexHelper(result);
    expect(b).toBeGreaterThan(180);
    expect(r).toBeLessThan(150);
  });

  it("returns lowercase hex with leading #", () => {
    const out = nearestShapeColor("#FFFFFF");
    expect(out.startsWith("#")).toBe(true);
    expect(out).toBe(out.toLowerCase());
  });
});

describe("nearestShapeColor — edge cases", () => {
  it("equidistant inputs → first-match-wins (deterministic)", () => {
    const a = nearestShapeColor("#808080");
    const b = nearestShapeColor("#808080");
    expect(a).toBe(b);
  });

  it("upper-case #FF0000 === lower-case #ff0000", () => {
    expect(nearestShapeColor("#FF0000")).toBe(nearestShapeColor("#ff0000"));
  });

  it("mixed case #FfAaCc normalized", () => {
    expect(() => nearestShapeColor("#FfAaCc")).not.toThrow();
  });

  it("3-char shorthand #f00 expands to #ff0000", () => {
    expect(nearestShapeColor("#f00")).toBe(nearestShapeColor("#ff0000"));
  });

  it("3-char shorthand #abc expands to #aabbcc", () => {
    expect(nearestShapeColor("#abc")).toBe(nearestShapeColor("#aabbcc"));
  });

  it("missing # accepted (e.g. 'ff0000')", () => {
    expect(nearestShapeColor("ff0000")).toBe(nearestShapeColor("#ff0000"));
  });

  it("null input → throws", () => {
    expect(() => nearestShapeColor(null as unknown as string)).toThrow();
  });

  it("empty string → throws", () => {
    expect(() => nearestShapeColor("")).toThrow();
  });

  it("non-hex chars '#zzgghh' → throws", () => {
    expect(() => nearestShapeColor("#zzgghh")).toThrow();
  });

  it("wrong length '#ffff' → throws", () => {
    expect(() => nearestShapeColor("#ffff")).toThrow();
  });

  it("property: 200 random hex inputs return normalized lowercase #rrggbb", () => {
    for (let i = 0; i < 200; i++) {
      const r = Math.floor(Math.random() * 256);
      const g = Math.floor(Math.random() * 256);
      const b = Math.floor(Math.random() * 256);
      const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      const out = nearestShapeColor(hex);
      expect(out).toMatch(/^#[0-9a-f]{6}$/);
      expect(out).toBe(hex);
    }
  });
});

describe("nearestStickyColor — happy path", () => {
  it("yellow-ish #ffe066 → maps to yellow-family enum", () => {
    const result = nearestStickyColor("#ffe066");
    expect(["yellow", "light_yellow", "orange"]).toContain(result);
  });

  it("dark green #1a7a3a → dark_green or green", () => {
    const result = nearestStickyColor("#1a7a3a");
    expect(["dark_green", "green"]).toContain(result);
  });

  it("returns one of 16 Miro named colors", () => {
    const named = Object.keys(STICKY_COLOR_RGB);
    expect(named.length).toBe(16);
    expect(named).toContain(nearestStickyColor("#888888"));
  });
});

describe("nearestStickyColor — edge cases", () => {
  it("equidistant → first-match-wins (deterministic)", () => {
    const a = nearestStickyColor("#808080");
    const b = nearestStickyColor("#808080");
    expect(a).toBe(b);
  });

  it("case insensitive", () => {
    expect(nearestStickyColor("#FFE066")).toBe(nearestStickyColor("#ffe066"));
  });

  it("3-char shorthand", () => {
    expect(nearestStickyColor("#fe6")).toBe(nearestStickyColor("#ffee66"));
  });

  it("malformed → throws", () => {
    expect(() => nearestStickyColor("#zz")).toThrow();
    expect(() => nearestStickyColor("")).toThrow();
  });

  it("property: 200 random hex inputs always return ∈ STICKY_COLOR_RGB keys", () => {
    const named = new Set(Object.keys(STICKY_COLOR_RGB));
    for (let i = 0; i < 200; i++) {
      const r = Math.floor(Math.random() * 256);
      const g = Math.floor(Math.random() * 256);
      const b = Math.floor(Math.random() * 256);
      const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      expect(named.has(nearestStickyColor(hex))).toBe(true);
    }
  });
});

function parseHexHelper(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
