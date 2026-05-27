import type { LayoutParams, Spacing } from "@shemma/domain";

export type PresetName = "Compact" | "Normal" | "Roomy";

type PresetFields = Pick<
  LayoutParams,
  "spacing" | "nodePadding" | "containerPadding" | "edgeSpacing" | "edgeNodeSpacing"
>;

// spacing — domain enum, ПРИВЯЗАН к ELK spacing options (modeToElkOptions).
// Без него backend всегда применяет "normal" → Compact/Normal/Roomy visually идентичны
// для пользователя. nodePadding/containerPadding/edgeSpacing/edgeNodeSpacing — также
// плумбленные numeric fields (используются в Pass A frame writeback + label gap).
export const SPACING_PRESETS: Record<PresetName, PresetFields> = {
  Compact: { spacing: "compact", nodePadding: 8,  containerPadding: 16, edgeSpacing: 12, edgeNodeSpacing: 12 },
  Normal:  { spacing: "normal",  nodePadding: 16, containerPadding: 24, edgeSpacing: 16, edgeNodeSpacing: 20 },
  Roomy:   { spacing: "loose",   nodePadding: 24, containerPadding: 32, edgeSpacing: 24, edgeNodeSpacing: 32 },
};

export function applyPreset(
  current: Partial<LayoutParams>,
  preset: PresetName,
): Partial<LayoutParams> {
  return { ...current, ...SPACING_PRESETS[preset] };
}

export function reverseMapPreset(params: Partial<PresetFields>): PresetName | null {
  for (const [name, fields] of Object.entries(SPACING_PRESETS) as Array<[PresetName, PresetFields]>) {
    if (
      params.spacing === fields.spacing &&
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

// Helper для SelectionPanel: aggregate selected[i].meta.didrawLayoutParams.spacing
// в PresetName | null (нужен для подсветки активного preset).
export function spacingToPreset(spacing: Spacing | undefined | null): PresetName | null {
  if (spacing === "compact") return "Compact";
  if (spacing === "normal") return "Normal";
  if (spacing === "loose") return "Roomy";
  return null;
}
