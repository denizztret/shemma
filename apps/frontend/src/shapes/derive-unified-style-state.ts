// apps/frontend/src/shapes/derive-unified-style-state.ts
//
// Computes unified style state for a selection (or selection + descendants).
// Mirrors backend applicability matrix:
//   - dash applies to geo/arrow/schema-container; skip note/text/frame.
//   - font applies to geo/note/text/arrow; skip frame/schema-container.
//   - size applies to geo/note/text/arrow; skip frame/schema-container.
// Dashed/dotted shapes excluded from dash unification (sweep preserves them).

import type { StyleDash, StyleFont, StyleSize } from "@shemma/domain";

export type StyleStateInput = {
  type: string;
  props: Record<string, unknown>;
};

export type UnifiedStyleState = {
  dash: StyleDash | null;
  font: StyleFont | null;
  size: StyleSize | null;
};

const DASH_TYPES = new Set(["geo", "arrow", "schema-container"]);
const FONT_TYPES = new Set(["geo", "note", "text", "arrow"]);
const SIZE_TYPES = new Set(["geo", "note", "text", "arrow"]);

const DASH_VALUES = new Set<StyleDash>(["draw", "solid"]);
const FONT_VALUES = new Set<StyleFont>(["draw", "sans", "mono"]);
const SIZE_VALUES = new Set<StyleSize>(["s", "m", "l", "xl"]);

// Accumulator: tracks unified value across shapes. `mixed=true` is a sticky
// terminal state once two different values have been observed.
type Accumulator<T extends string> = { value: T | null; mixed: boolean };

function observe<T extends string>(
  acc: Accumulator<T>,
  raw: unknown,
  validValues: ReadonlySet<T>,
): void {
  if (acc.mixed) return;
  if (typeof raw !== "string" || !validValues.has(raw as T)) return;
  const v = raw as T;
  if (acc.value === null) {
    acc.value = v;
  } else if (acc.value !== v) {
    acc.mixed = true;
    acc.value = null;
  }
}

export function deriveUnifiedStyleState(
  shapes: ReadonlyArray<StyleStateInput>,
): UnifiedStyleState {
  const dash: Accumulator<StyleDash> = { value: null, mixed: false };
  const font: Accumulator<StyleFont> = { value: null, mixed: false };
  const size: Accumulator<StyleSize> = { value: null, mixed: false };

  for (const s of shapes) {
    if (DASH_TYPES.has(s.type)) observe(dash, s.props.dash, DASH_VALUES);
    if (FONT_TYPES.has(s.type)) observe(font, s.props.font, FONT_VALUES);
    if (SIZE_TYPES.has(s.type)) observe(size, s.props.size, SIZE_VALUES);
  }

  return { dash: dash.value, font: font.value, size: size.value };
}
