import { getColorValue } from "tldraw";
import type { TLDefaultColorStyle, TLDefaultFillStyle } from "tldraw";

/**
 * DRW-186 (Task 12): visual parity для `fill` атрибута SchemaContainer
 * с native tldraw `<geo>` rectangle.
 *
 * tldraw намеренно использует "сбивающую" терминологию. Внутренний mapping
 * (`DEFAULT_FILL_COLOR_NAMES` в `T/lib/shapes/shared/defaultFills.ts`):
 *
 *   props.fill === 'solid'      → palette variant `'semi'`     (pastel, e.g. red.semi #f4dadb)
 *   props.fill === 'semi'       → top-level theme `colors.solid` (page-contrast, light #fcfffe)
 *   props.fill === 'pattern'    → palette variant `'pattern'`  (требует SVG <pattern>)
 *   props.fill === 'fill'       → palette variant `'fill'`
 *   props.fill === 'lined-fill' → palette variant `'linedFill'`
 *   props.fill === 'none'       → 'transparent'
 *
 * Этот mapping НЕ public-exported из `"tldraw"` — реплицируем inline.
 * См. `docs/probes/2026-05-27-drw-186-probe-tool-api.md` §Task 2.
 *
 * Pattern fill (а также `fill` / `lined-fill`) пока не поддерживаются SchemaContainer
 * на уровне UI — фолбэк на `palette.semi` сохраняет старое поведение
 * (Pattern out of scope для v0.1, см. spec § Out of scope).
 *
 * @param colors  `theme.colors[colorMode]` (light/dark sub-палитра)
 * @param color   палитровое имя цвета или произвольный hex (тогда getColorValue
 *                сам вернёт значение без изменений)
 * @param fill    `TLDefaultFillStyle`
 * @returns CSS fill значение для атрибута `<rect fill="...">`
 */
// `getColorValue` принимает `TLThemeColors` (не re-exported из `"tldraw"`),
// поэтому выводим его тип через `Parameters` — это держит код public-API-clean.
type ThemeColors = Parameters<typeof getColorValue>[0];

export function resolveContainerFill(
  colors: ThemeColors,
  color: TLDefaultColorStyle,
  fill: TLDefaultFillStyle,
): string {
  switch (fill) {
    case "none":
      return "transparent";
    case "semi":
      // top-level theme color (page-contrast), не per-color variant
      return (colors as unknown as { solid: string }).solid;
    case "solid":
      // pastel: tldraw маппит fill='solid' → palette.semi
      return getColorValue(colors, color, "semi");
    case "pattern":
      // Pattern требует SVG <defs>/<pattern>; SchemaContainer не поддерживает.
      // Фолбэк на semi — сохраняет старое поведение (см. spec § Out of scope).
      return getColorValue(colors, color, "semi");
    case "fill":
    case "lined-fill":
      // Эти моды tldraw тоже не поддерживаются SchemaContainer-стилем
      // (UI panel ограничен none/semi/solid), но enum DefaultFillStyle их включает —
      // покрываем для exhaustiveness, фолбэк на semi.
      return getColorValue(colors, color, "semi");
  }
}
