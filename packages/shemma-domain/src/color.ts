// SSOT for the tldraw default color palette and safe coercion into it.
//
// tldraw's `DefaultColorStyle` validator only accepts the 13 named palette
// colors below. A raw hex value (e.g. "#6A1B9A" carried over from a mermaid
// `style`/`classDef` directive — DRW-153) written into `props.color` passes
// the lenient backend store but makes the strict frontend `loadSnapshot`
// throw a ValidationError — which aborts the *entire* snapshot load and blanks
// the board. `coerceColor` maps any non-palette value to the nearest palette
// name (or a fallback) so bad/legacy data can never poison a load. (DRW-231)

export type RGB = readonly [number, number, number];

/** All tldraw `DefaultColorStyle` names (13, incl. "white"). */
export const TLDRAW_COLOR_NAMES = [
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
  "white",
] as const;

export type TldrawColor = (typeof TLDRAW_COLOR_NAMES)[number];

/** Representative hex per palette name (light theme; from DRW-153 probe). */
export const TLDRAW_PALETTE: Record<TldrawColor, string> = {
  black: "#1d1d1d",
  grey: "#9fa8b2",
  "light-violet": "#e085f4",
  violet: "#ae3ec9",
  blue: "#4465e9",
  "light-blue": "#4ba1f1",
  yellow: "#f1ac4b",
  orange: "#e16919",
  green: "#099268",
  "light-green": "#4cb05e",
  "light-red": "#f87777",
  red: "#e03131",
  white: "#ffffff",
};

const VALID = new Set<string>(TLDRAW_COLOR_NAMES);

/** Parse `#rgb` / `#rrggbb` → RGB tuple. Returns null on any invalid input. */
export function parseHex(hex: string): RGB | null {
  if (typeof hex !== "string" || hex.length === 0) return null;
  const raw = hex.replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(raw)) return null;
  let full: string;
  if (raw.length === 3) {
    full = raw.replace(/(.)/g, "$1$1"); // "abc" → "aabbcc"
  } else if (raw.length === 6) {
    full = raw;
  } else {
    return null;
  }
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function euclideanSq(a: RGB, b: RGB): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

const PALETTE_RGB: ReadonlyArray<{ name: TldrawColor; rgb: RGB }> = (
  Object.entries(TLDRAW_PALETTE) as Array<[TldrawColor, string]>
).map(([name, hex]) => ({ name, rgb: parseHex(hex) as RGB }));

/** True when `value` is one of the tldraw palette names. */
export function isValidColor(value: unknown): value is TldrawColor {
  return typeof value === "string" && VALID.has(value);
}

/**
 * Coerce any value into a valid tldraw palette name:
 *   - already a palette name → returned unchanged;
 *   - a parseable hex string → nearest palette name by RGB distance;
 *   - anything else → `fallback` (default "black").
 */
export function coerceColor(
  value: unknown,
  fallback: TldrawColor = "black",
): TldrawColor {
  if (isValidColor(value)) return value;
  if (typeof value === "string") {
    const rgb = parseHex(value);
    if (rgb) {
      let best: TldrawColor = fallback;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const entry of PALETTE_RGB) {
        const d = euclideanSq(rgb, entry.rgb);
        if (d < bestDist) {
          bestDist = d;
          best = entry.name;
        }
      }
      return best;
    }
  }
  return fallback;
}
