export type LayoutMode = "layered-lr" | "layered-tb" | "layered-bt" | "layered-rl" | "tree" | "pack" | "force";
export type Spacing = "compact" | "normal" | "loose";

export const ALL_MODES: readonly LayoutMode[] = ["layered-lr", "layered-tb", "layered-bt", "layered-rl", "tree", "pack", "force"];
export const ALL_SPACINGS: readonly Spacing[] = ["compact", "normal", "loose"];

export function isValidLayoutMode(s: string): s is LayoutMode {
  return (ALL_MODES as readonly string[]).includes(s);
}

// DRW-079: tuned for 220x80 default shapes — `normal` was too tight, edge labels
// overlapped neighboring nodes. Includes layered-specific between-layers spacing
// (Y-direction in TB, X-direction in LR) and edge-label spacing.
const SPACING_PRESETS: Record<
  Spacing,
  {
    nodeNode: number;
    edgeNode: number;
    componentComponent: number;
    nodeNodeBetweenLayers: number;
    edgeEdgeBetweenLayers: number;
    edgeLabel: number;
  }
> = {
  compact: {
    nodeNode: 30,
    edgeNode: 15,
    componentComponent: 50,
    nodeNodeBetweenLayers: 60,
    edgeEdgeBetweenLayers: 12,
    edgeLabel: 6,
  },
  normal: {
    nodeNode: 60,
    edgeNode: 30,
    componentComponent: 100,
    nodeNodeBetweenLayers: 120,
    edgeEdgeBetweenLayers: 20,
    edgeLabel: 10,
  },
  loose: {
    nodeNode: 100,
    edgeNode: 50,
    componentComponent: 180,
    nodeNodeBetweenLayers: 200,
    edgeEdgeBetweenLayers: 32,
    edgeLabel: 14,
  },
};

export function modeToElkOptions(mode: LayoutMode, spacing: Spacing): Record<string, string> {
  const sp = SPACING_PRESETS[spacing];
  const base: Record<string, string> = {
    "elk.spacing.nodeNode": String(sp.nodeNode),
    "elk.spacing.edgeNode": String(sp.edgeNode),
    "elk.spacing.edgeEdge": String(sp.edgeNode),
    "elk.spacing.edgeLabel": String(sp.edgeLabel),
    "elk.spacing.componentComponent": String(sp.componentComponent),
  };
  const layeredExtras: Record<string, string> = {
    "elk.layered.spacing.nodeNodeBetweenLayers": String(sp.nodeNodeBetweenLayers),
    "elk.layered.spacing.edgeNodeBetweenLayers": String(sp.edgeNode),
    "elk.layered.spacing.edgeEdgeBetweenLayers": String(sp.edgeEdgeBetweenLayers),
  };
  switch (mode) {
    case "layered-lr":
      return {
        ...base,
        ...layeredExtras,
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      };
    case "layered-tb":
      return {
        ...base,
        ...layeredExtras,
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      };
    case "layered-bt":
      return {
        ...base,
        ...layeredExtras,
        "elk.algorithm": "layered",
        "elk.direction": "UP",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      };
    case "layered-rl":
      return {
        ...base,
        ...layeredExtras,
        "elk.algorithm": "layered",
        "elk.direction": "LEFT",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      };
    case "tree":
      return { ...base, "elk.algorithm": "mrtree" };
    case "pack":
      return { ...base, "elk.algorithm": "rectpacking" };
    case "force":
      return { ...base, "elk.algorithm": "force" };
  }
}
