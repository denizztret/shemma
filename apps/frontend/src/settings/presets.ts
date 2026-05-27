import type { LayoutParams } from "@shemma/domain";

export type PresetName = "Compact" | "Normal" | "Roomy";

type PresetFields = Pick<
  LayoutParams,
  "nodePadding" | "containerPadding" | "edgeSpacing" | "edgeNodeSpacing"
>;

export const SPACING_PRESETS: Record<PresetName, PresetFields> = {
  Compact: { nodePadding: 8, containerPadding: 16, edgeSpacing: 12, edgeNodeSpacing: 12 },
  Normal:  { nodePadding: 16, containerPadding: 24, edgeSpacing: 16, edgeNodeSpacing: 20 },
  Roomy:   { nodePadding: 24, containerPadding: 32, edgeSpacing: 24, edgeNodeSpacing: 32 },
};

export function applyPreset(
  current: Partial<LayoutParams>,
  preset: PresetName,
): Partial<LayoutParams> {
  return { ...current, ...SPACING_PRESETS[preset] };
}

export function reverseMapPreset(params: PresetFields): PresetName | null {
  for (const [name, fields] of Object.entries(SPACING_PRESETS) as Array<[PresetName, PresetFields]>) {
    if (
      params.nodePadding === fields.nodePadding &&
      params.containerPadding === fields.containerPadding &&
      params.edgeSpacing === fields.edgeSpacing &&
      params.edgeNodeSpacing === fields.edgeNodeSpacing
    ) {
      return name;
    }
  }
  return null;
}
