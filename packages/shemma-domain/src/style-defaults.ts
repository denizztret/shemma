// packages/shemma-domain/src/style-defaults.ts
//
// Style propagation (sub-project 3 of DRW-180): тип централизованных
// дефолтов стиля. Хранится в room.meta.styleDefaults (board level) и
// в meta.didrawStyleDefaults на frame / schema-container (sticky per-container).
//
// Resolution chain: nearest container → parent containers → room → native default.

export type StyleDash = "draw" | "solid";
export type StyleFont = "draw" | "sans" | "mono";
export type StyleSize = "s" | "m" | "l" | "xl";

export type StyleDefaults = {
  dash?: StyleDash;
  font?: StyleFont;
  size?: StyleSize;
};

export type ResolvedStyleDefaults = Required<StyleDefaults>;

export const DEFAULT_STYLE_DEFAULTS: ResolvedStyleDefaults = {
  dash: "draw",
  font: "draw",
  size: "m",
};

const VALID_DASH: ReadonlySet<StyleDash> = new Set(["draw", "solid"]);
const VALID_FONT: ReadonlySet<StyleFont> = new Set(["draw", "sans", "mono"]);
const VALID_SIZE: ReadonlySet<StyleSize> = new Set(["s", "m", "l", "xl"]);

export function validateStyleDefaults(p: StyleDefaults): void {
  if (p.dash !== undefined && !VALID_DASH.has(p.dash)) {
    throw new Error(
      `StyleDefaults.dash must be draw|solid; got ${String(p.dash)}`,
    );
  }
  if (p.font !== undefined && !VALID_FONT.has(p.font)) {
    throw new Error(
      `StyleDefaults.font must be draw|sans|mono; got ${String(p.font)}`,
    );
  }
  if (p.size !== undefined && !VALID_SIZE.has(p.size)) {
    throw new Error(
      `StyleDefaults.size must be s|m|l|xl; got ${String(p.size)}`,
    );
  }
}

/**
 * Resolves a chain of partial defaults (nearest-first order) into fully-defined
 * defaults. First defined value per key wins; gaps filled from
 * DEFAULT_STYLE_DEFAULTS.
 */
export function applyStyleDefaultsResolution(
  chain: StyleDefaults[],
): ResolvedStyleDefaults {
  const out: ResolvedStyleDefaults = { ...DEFAULT_STYLE_DEFAULTS };
  let dashSet = false;
  let fontSet = false;
  let sizeSet = false;
  for (const layer of chain) {
    if (!dashSet && layer.dash !== undefined) {
      out.dash = layer.dash;
      dashSet = true;
    }
    if (!fontSet && layer.font !== undefined) {
      out.font = layer.font;
      fontSet = true;
    }
    if (!sizeSet && layer.size !== undefined) {
      out.size = layer.size;
      sizeSet = true;
    }
    if (dashSet && fontSet && sizeSet) break;
  }
  return out;
}
