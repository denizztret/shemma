export type LayoutMode = "layered-lr" | "layered-tb" | "tree" | "pack" | "force";
export type Spacing = "compact" | "normal" | "loose";

export const ALL_MODES: readonly LayoutMode[] = ["layered-lr", "layered-tb", "tree", "pack", "force"];

export function isValidLayoutMode(s: string): s is LayoutMode {
  return (ALL_MODES as readonly string[]).includes(s);
}

const SPACING_PRESETS: Record<Spacing, { nodeNode: number; edgeNode: number; componentComponent: number }> = {
  compact: { nodeNode: 20, edgeNode: 10, componentComponent: 40 },
  normal:  { nodeNode: 40, edgeNode: 20, componentComponent: 80 },
  loose:   { nodeNode: 80, edgeNode: 40, componentComponent: 160 },
};

export function modeToElkOptions(mode: LayoutMode, spacing: Spacing): Record<string, string> {
  const sp = SPACING_PRESETS[spacing];
  const base: Record<string, string> = {
    "elk.spacing.nodeNode": String(sp.nodeNode),
    "elk.spacing.edgeNode": String(sp.edgeNode),
    "elk.spacing.componentComponent": String(sp.componentComponent),
  };
  switch (mode) {
    case "layered-lr":
      return { ...base, "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.edgeRouting": "ORTHOGONAL", "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX" };
    case "layered-tb":
      return { ...base, "elk.algorithm": "layered", "elk.direction": "DOWN", "elk.edgeRouting": "ORTHOGONAL", "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX" };
    case "tree":
      return { ...base, "elk.algorithm": "mrtree" };
    case "pack":
      return { ...base, "elk.algorithm": "rectpacking" };
    case "force":
      return { ...base, "elk.algorithm": "force" };
  }
}
