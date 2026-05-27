// packages/shemma-domain/src/layout-params.ts
//
// DRW-178: LayoutParams — single source of configuration for the layout
// pipeline. Replaces hardcoded numbers in apps/backend/src/domain/layout.ts
// helpers so that callers (route, future UI panel) can override per-call.

import type { Spacing } from "./layout-modes";

export type Direction = "TB" | "BT" | "LR" | "RL";

export type LayoutParams = {
  // Node sizing
  nodeMinWidth: number;
  nodeMinHeight: number;
  nodePadding: number;

  // Container insets
  containerPadding: number;
  containerLabelHeight: number;

  // Edge spacing
  edgeSpacing: number;
  edgeNodeSpacing: number;
  edgeLabelMaxWidth: number;
  edgeLabelMaxLines: number;
  edgeLabelMargin: number;
  edgeLabelFontSize: number;

  // Direction
  defaultDirection: Direction;
  autoDirectionEnabled: boolean;

  // Anchor + midpoint behavior
  anchorOffsetMode: "distribute" | "center";
  midpointDistribution: "even" | "fixed-0.5";

  // Per-anchor ELK spacing preset override (frame-container-direction-layout
  // task #3). Если задано — runLayoutSubgraph будет использовать это значение
  // вместо hint.spacing для subgraph anchor'а. Optional: на board-level
  // используется hint.spacing (см. apps/backend/src/domain/layout.ts).
  spacing?: Spacing;
};

export const DEFAULT_LAYOUT_PARAMS: LayoutParams = {
  nodeMinWidth: 120,
  nodeMinHeight: 60,
  nodePadding: 16,
  containerPadding: 24,
  containerLabelHeight: 32,
  edgeSpacing: 16,
  edgeNodeSpacing: 20,
  edgeLabelMaxWidth: 200,
  edgeLabelMaxLines: 3,
  edgeLabelMargin: 12,
  edgeLabelFontSize: 16,
  defaultDirection: "TB",
  autoDirectionEnabled: true,
  anchorOffsetMode: "distribute",
  midpointDistribution: "even",
};

const NUMERIC_FIELDS: ReadonlyArray<keyof LayoutParams> = [
  "nodeMinWidth",
  "nodeMinHeight",
  "nodePadding",
  "containerPadding",
  "containerLabelHeight",
  "edgeSpacing",
  "edgeNodeSpacing",
  "edgeLabelMaxWidth",
  "edgeLabelMaxLines",
  "edgeLabelMargin",
  "edgeLabelFontSize",
];

const VALID_DIRECTIONS: ReadonlySet<Direction> = new Set(["TB", "BT", "LR", "RL"]);
const VALID_ANCHOR_MODES = new Set(["distribute", "center"]);
const VALID_MID_MODES = new Set(["even", "fixed-0.5"]);
const VALID_SPACINGS = new Set<Spacing>(["compact", "normal", "loose"]);

export function applyLayoutParamsDefaults(partial: Partial<LayoutParams>): LayoutParams {
  return { ...DEFAULT_LAYOUT_PARAMS, ...partial };
}

export function validateLayoutParams(p: Partial<LayoutParams>): void {
  for (const key of NUMERIC_FIELDS) {
    const v = p[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`LayoutParams.${String(key)} must be a non-negative finite number; got ${String(v)}`);
    }
  }
  if (p.defaultDirection !== undefined && !VALID_DIRECTIONS.has(p.defaultDirection)) {
    throw new Error(`LayoutParams.defaultDirection must be one of TB|BT|LR|RL; got ${String(p.defaultDirection)}`);
  }
  if (p.anchorOffsetMode !== undefined && !VALID_ANCHOR_MODES.has(p.anchorOffsetMode)) {
    throw new Error(`LayoutParams.anchorOffsetMode must be distribute|center; got ${String(p.anchorOffsetMode)}`);
  }
  if (p.midpointDistribution !== undefined && !VALID_MID_MODES.has(p.midpointDistribution)) {
    throw new Error(`LayoutParams.midpointDistribution must be even|fixed-0.5; got ${String(p.midpointDistribution)}`);
  }
  if (p.autoDirectionEnabled !== undefined && typeof p.autoDirectionEnabled !== "boolean") {
    throw new Error(`LayoutParams.autoDirectionEnabled must be boolean; got ${typeof p.autoDirectionEnabled}`);
  }
  if (p.spacing !== undefined && !VALID_SPACINGS.has(p.spacing as Spacing)) {
    throw new Error(`LayoutParams.spacing must be compact|normal|loose; got ${String(p.spacing)}`);
  }
}

// Container-level override для layout params (frame OR schema-container).
// `null` — сигнализирует backend удалить meta key (см. spec 4.1).
// Stored on `shape.meta.didrawLayoutParams`.
export type ContainerLayoutOverride = Partial<LayoutParams> | null;
