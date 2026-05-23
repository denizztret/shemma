export type RGB = [number, number, number];

/**
 * Miro shape palette — UI swatch colors. Documentary only.
 * Live probe (2026-05-20) confirmed Miro REST v2 accepts arbitrary hex
 * for shape style.fillColor; `nearestShapeColor` is therefore identity.
 */
export const SHAPE_PRESETS: Array<{ hex: string; rgb: RGB }> = [
  { hex: "#ffffff", rgb: [255, 255, 255] }, // White (default)
  { hex: "#f5f6f8", rgb: [245, 246, 248] }, // Light grey
  { hex: "#d5f692", rgb: [213, 246, 146] }, // Light lime green
  { hex: "#d0e17a", rgb: [208, 225, 122] }, // Yellow-green
  { hex: "#93d275", rgb: [147, 210, 117] }, // Medium green
  { hex: "#67c6c0", rgb: [103, 198, 192] }, // Teal
  { hex: "#23bfe7", rgb: [35, 191, 231] },  // Cyan/light blue
  { hex: "#a6ccf5", rgb: [166, 204, 245] }, // Light blue
  { hex: "#7b92ff", rgb: [123, 146, 255] }, // Blue-violet
  { hex: "#fff9b1", rgb: [255, 249, 177] }, // Light yellow (Post-it)
  { hex: "#f5d128", rgb: [245, 209, 40] },  // Yellow
  { hex: "#ff9d48", rgb: [255, 157, 72] },  // Orange
  { hex: "#f16c7f", rgb: [241, 108, 127] }, // Salmon/red-pink
  { hex: "#ea94bb", rgb: [234, 148, 187] }, // Pink
  { hex: "#ffcee0", rgb: [255, 206, 224] }, // Light pink
  { hex: "#b384bb", rgb: [179, 132, 187] }, // Purple
  { hex: "#000000", rgb: [0, 0, 0] },       // Black
];

/** Miro sticky-note named color → approximate RGB. */
export const STICKY_COLOR_RGB: Record<string, RGB> = {
  gray: [200, 200, 200],
  light_yellow: [255, 244, 178],
  yellow: [255, 232, 102],
  orange: [255, 178, 102],
  light_green: [178, 232, 153],
  green: [102, 204, 102],
  dark_green: [25, 122, 56],
  cyan: [102, 217, 217],
  light_pink: [255, 204, 217],
  pink: [255, 102, 178],
  violet: [191, 102, 217],
  red: [217, 51, 51],
  light_blue: [178, 217, 255],
  blue: [102, 178, 255],
  dark_blue: [25, 76, 153],
  black: [0, 0, 0],
};

export function parseHex(hex: string): RGB {
  if (typeof hex !== "string" || hex.length === 0) {
    throw new Error(`parseHex: invalid input ${JSON.stringify(hex)}`);
  }
  const raw = hex.replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(raw)) {
    throw new Error(`parseHex: non-hex characters in ${JSON.stringify(hex)}`);
  }
  let full: string;
  if (raw.length === 3) {
    full = raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2];
  } else if (raw.length === 6) {
    full = raw;
  } else {
    throw new Error(
      `parseHex: wrong length (expected 3 or 6 hex chars) in ${JSON.stringify(hex)}`
    );
  }
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function euclidean(a: RGB, b: RGB): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

export function nearestShapeColor(hex: string): string {
  const [r, g, b] = parseHex(hex);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Task 1: tldraw named color → hex
// ---------------------------------------------------------------------------

/** Type-safe union of all 12 tldraw named colors. */
export type TldrawNamedColor =
  | "black"
  | "grey"
  | "light-violet"
  | "violet"
  | "blue"
  | "light-blue"
  | "yellow"
  | "orange"
  | "green"
  | "light-green"
  | "light-red"
  | "red";

/** Maps tldraw color names → their representative hex values (v0.4 probe). */
export const TLDRAW_NAMED_TO_HEX: Record<TldrawNamedColor, string> = {
  "black": "#1d1d1d",
  "grey": "#9fa8b2",
  "light-violet": "#e085f4",
  "violet": "#ae3ec9",
  "blue": "#4465e9",
  "light-blue": "#4ba1f1",
  "yellow": "#f1ac4b",
  "orange": "#e16919",
  "green": "#099268",
  "light-green": "#4cb05e",
  "light-red": "#f87777",
  "red": "#e03131",
};

/**
 * Convert a tldraw named color to its hex value.
 * Unknown / undefined inputs fall back to black ("#1d1d1d").
 */
export function tldrawNamedToHex(color: string | undefined): string {
  if (!color) return TLDRAW_NAMED_TO_HEX["black"];
  return (TLDRAW_NAMED_TO_HEX as Record<string, string>)[color] ?? TLDRAW_NAMED_TO_HEX["black"];
}

export function nearestStickyColor(hex: string): string {
  const rgb = parseHex(hex);
  let bestName = "gray";
  let bestDist = Infinity;
  for (const [name, presetRgb] of Object.entries(STICKY_COLOR_RGB)) {
    const d = euclidean(rgb, presetRgb);
    if (d < bestDist) {
      bestDist = d;
      bestName = name;
    }
  }
  return bestName;
}

// ---------------------------------------------------------------------------
// Task 5: stickyFillColor (§ 4.5)
// ---------------------------------------------------------------------------

/**
 * Determine the Miro sticky note fillColor from a tldraw note shape.
 * Falls back to "yellow" when props.color is absent (preserves legacy default —
 * sticky without explicit color should be yellow per whiteboard convention).
 */
export function stickyFillColor(note: { props?: { color?: string } }): string {
  const named = note.props?.color;
  if (!named) return "yellow";
  return nearestStickyColor(tldrawNamedToHex(named));
}
