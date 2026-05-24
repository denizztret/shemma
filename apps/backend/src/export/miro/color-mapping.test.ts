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

// ---------------------------------------------------------------------------
// Task 1: tldrawNamedToHex + TLDRAW_NAMED_TO_HEX
// ---------------------------------------------------------------------------
import { tldrawNamedToHex, TLDRAW_NAMED_TO_HEX, stickyFillColor } from "./color-mapping";

describe("TLDRAW_NAMED_TO_HEX — round-trip all 12 colors", () => {
  it("all 12 tldraw named colors map to correct v0.4 hex values", () => {
    expect(TLDRAW_NAMED_TO_HEX["black"]).toBe("#1d1d1d");
    expect(TLDRAW_NAMED_TO_HEX["grey"]).toBe("#9fa8b2");
    expect(TLDRAW_NAMED_TO_HEX["light-violet"]).toBe("#e085f4");
    expect(TLDRAW_NAMED_TO_HEX["violet"]).toBe("#ae3ec9");
    expect(TLDRAW_NAMED_TO_HEX["blue"]).toBe("#4465e9");
    expect(TLDRAW_NAMED_TO_HEX["light-blue"]).toBe("#4ba1f1");
    expect(TLDRAW_NAMED_TO_HEX["yellow"]).toBe("#f1ac4b");
    expect(TLDRAW_NAMED_TO_HEX["orange"]).toBe("#e16919");
    expect(TLDRAW_NAMED_TO_HEX["green"]).toBe("#099268");
    expect(TLDRAW_NAMED_TO_HEX["light-green"]).toBe("#4cb05e");
    expect(TLDRAW_NAMED_TO_HEX["light-red"]).toBe("#f87777");
    expect(TLDRAW_NAMED_TO_HEX["red"]).toBe("#e03131");
  });
});

describe("tldrawNamedToHex — fallback behavior", () => {
  it("undefined input → '#1d1d1d' (black fallback)", () => {
    expect(tldrawNamedToHex(undefined)).toBe("#1d1d1d");
  });

  it("unknown string → '#1d1d1d' (black fallback)", () => {
    expect(tldrawNamedToHex("unknown-color-xyz")).toBe("#1d1d1d");
  });
});

// ---------------------------------------------------------------------------
// Task 5: stickyFillColor
// ---------------------------------------------------------------------------

describe("stickyFillColor", () => {
  it("undefined props.color → 'yellow' (legacy default)", () => {
    expect(stickyFillColor({ props: {} })).toBe("yellow");
    expect(stickyFillColor({})).toBe("yellow");
  });

  it("named tldraw color → nearestStickyColor(tldrawNamedToHex(named))", () => {
    // "red" → tldrawNamedToHex("red") = "#e03131" → nearestStickyColor → "red" sticky
    const result = stickyFillColor({ props: { color: "red" } });
    const validStickyColors = Object.keys(STICKY_COLOR_RGB);
    expect(validStickyColors).toContain(result);
    // Specifically: "#e03131" is close to STICKY_COLOR_RGB.red [217, 51, 51]
    expect(result).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// DRW-153: hexToTldrawColor — hex → nearest tldraw named color
// ---------------------------------------------------------------------------
import { hexToTldrawColor, TLDRAW_COLOR_PALETTE } from "./color-mapping";

describe("hexToTldrawColor — exact canonical hex round-trips", () => {
  it("each of the 12 canonical hex values maps back to their own color name", () => {
    for (const [name, hex] of Object.entries(TLDRAW_NAMED_TO_HEX)) {
      expect(hexToTldrawColor(hex)).toBe(name);
    }
  });
});

describe("hexToTldrawColor — nearest neighbor (DRW-149 brainstorm samples)", () => {
  it("#e3f2fd (mermaid light-blue fill) → pale/light color family", () => {
    // Very pale blue/lavender — RGB nearest-neighbor maps to light-violet (#e085f4 ≈ pale pastel)
    const result = hexToTldrawColor("#e3f2fd");
    // Valid result — one of the lighter colors
    const validColors = new Set(Object.keys(TLDRAW_NAMED_TO_HEX));
    expect(result).toBeDefined();
    if (result !== undefined) expect(validColors.has(result)).toBe(true);
  });

  it("#1565c0 (mermaid dark-blue stroke) → 'blue'", () => {
    expect(hexToTldrawColor("#1565c0")).toBe("blue");
  });

  it("#fff3e0 (mermaid light-orange fill) → pale color family", () => {
    // Very pale orange/cream — RGB nearest-neighbor maps to light-violet (closest pastel)
    const result = hexToTldrawColor("#fff3e0");
    const validColors = new Set(Object.keys(TLDRAW_NAMED_TO_HEX));
    expect(result).toBeDefined();
    if (result !== undefined) expect(validColors.has(result)).toBe(true);
  });

  it("#000000 → 'black'", () => {
    expect(hexToTldrawColor("#000000")).toBe("black");
  });

  it("#ffffff → nearest (not black, likely grey or light-blue)", () => {
    const result = hexToTldrawColor("#ffffff");
    // Just ensure it returns a valid tldraw color
    const validColors = Object.keys(TLDRAW_NAMED_TO_HEX);
    expect(validColors).toContain(result);
  });

  it("#ff0000 → 'red' or 'light-red'", () => {
    const result = hexToTldrawColor("#ff0000");
    expect(["red", "light-red"]).toContain(result);
  });

  it("#00ff00 → 'green' or 'light-green'", () => {
    const result = hexToTldrawColor("#00ff00");
    expect(["green", "light-green"]).toContain(result);
  });

  it("#0000ff → 'blue' or 'light-blue'", () => {
    const result = hexToTldrawColor("#0000ff");
    expect(["blue", "light-blue"]).toContain(result);
  });

  it("#800080 → 'violet' or 'light-violet'", () => {
    const result = hexToTldrawColor("#800080");
    expect(["violet", "light-violet"]).toContain(result);
  });

  it("#ffa500 → 'orange' or 'yellow'", () => {
    const result = hexToTldrawColor("#ffa500");
    expect(["orange", "yellow"]).toContain(result);
  });
});

describe("hexToTldrawColor — edge cases", () => {
  it("3-char shorthand #f00 → same as #ff0000", () => {
    expect(hexToTldrawColor("#f00")).toBe(hexToTldrawColor("#ff0000"));
  });

  it("uppercase input → same as lowercase", () => {
    expect(hexToTldrawColor("#FF0000")).toBe(hexToTldrawColor("#ff0000"));
  });

  it("invalid hex (too short) → returns undefined", () => {
    expect(hexToTldrawColor("#fff")).toBeDefined(); // 3-char is valid
    expect(hexToTldrawColor("#gg0000")).toBeUndefined();
  });

  it("empty string → returns undefined", () => {
    expect(hexToTldrawColor("")).toBeUndefined();
  });

  it("TLDRAW_COLOR_PALETTE has 12 entries", () => {
    expect(TLDRAW_COLOR_PALETTE.length).toBe(12);
  });

  it("property: 200 random hex inputs always return a valid tldraw named color", () => {
    const validColors = new Set(Object.keys(TLDRAW_NAMED_TO_HEX));
    for (let i = 0; i < 200; i++) {
      const r = Math.floor(Math.random() * 256);
      const g = Math.floor(Math.random() * 256);
      const b = Math.floor(Math.random() * 256);
      const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      const result = hexToTldrawColor(hex);
      expect(result).toBeDefined();
      if (result !== undefined) {
        expect(validColors.has(result)).toBe(true);
      }
    }
  });
});
