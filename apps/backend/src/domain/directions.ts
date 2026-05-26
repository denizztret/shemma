// apps/backend/src/domain/directions.ts
//
// DRW-178: 4-way heuristic for choosing TB / BT / LR / RL per container when
// mermaid did not specify direction explicitly. Picks the direction such that
// the side with the most external edges aligns with the side where the
// receiving child sits.
//
// DRW-178 Task 2.6: inferContainerDirection — parallel-lanes rule.
// When ≥2 children each have edges exclusively to the SAME cardinal side,
// the container should be arranged perpendicular to that flow (lanes).

import type { LayoutParams } from "@shemma/domain";
import type { TLRecord } from "../store-types";

export type Direction = "TB" | "BT" | "LR" | "RL";
export type CardinalSide = "top" | "bottom" | "left" | "right";

export type ExternalEdge = { side: CardinalSide };

export type DetermineInput = {
  container: TLRecord & { meta?: { didrawDirection?: string } };
  edgesIn: ExternalEdge[];
  edgesOut: ExternalEdge[];
};

const TIE_PRIORITY: Direction[] = ["TB", "LR", "BT", "RL"];

const SIDE_TO_DIRECTION: Record<CardinalSide, Direction> = {
  top: "TB",
  bottom: "BT",
  left: "LR",
  right: "RL",
};

// =====================================================================
// DRW-178 Task 2.6: inferContainerDirection — parallel-lanes rule
// =====================================================================

export type InferDirectionInput = {
  container: TLRecord & { meta?: { didrawDirection?: string } };
  /** Direction of the parent container (or "TB" if no parent / root). */
  parentDirection: Direction;
  /** Map from child shape id → array of external edge sides. */
  externalEdgesPerChild: Map<string, ExternalEdge[]>;
};

/**
 * Infer the optimal layout direction for a container.
 *
 * Parallel-lanes rule: if ≥2 children each have external edges
 * exclusively to the SAME cardinal side, arrange children perpendicular
 * (lanes) so they don't cross through each other.
 *
 * Falls back to determineContainerDirection (side-count heuristic) when
 * the parallel-lanes rule doesn't apply.
 */
export function inferContainerDirection(input: InferDirectionInput): Direction {
  // Explicit user / mermaid override always wins.
  const explicit = input.container.meta?.didrawDirection;
  if (explicit === "TB" || explicit === "BT" || explicit === "LR" || explicit === "RL") {
    return explicit;
  }

  // Parallel-lanes rule: requires ≥2 children with external edges.
  const childrenWithEdges = [...input.externalEdgesPerChild.entries()].filter(
    ([, edges]) => edges.length > 0,
  );

  if (childrenWithEdges.length >= 2) {
    // Each child must have edges to exactly ONE side, AND that side must be
    // identical across ALL children with edges.
    let commonSide: CardinalSide | null = null;
    let allMatch = true;

    for (const [, edges] of childrenWithEdges) {
      const sides = new Set(edges.map((e) => e.side));
      if (sides.size !== 1) {
        // This child has edges to multiple sides → rule doesn't apply.
        allMatch = false;
        break;
      }
      const side = [...sides][0] as CardinalSide;
      if (commonSide === null) {
        commonSide = side;
      } else if (commonSide !== side) {
        // Children point to different sides → rule doesn't apply.
        allMatch = false;
        break;
      }
    }

    if (allMatch && commonSide !== null) {
      // Perpendicular to parent flow: TB/BT → LR lanes; LR/RL → TB lanes.
      return commonSide === "top" || commonSide === "bottom" ? "LR" : "TB";
    }
  }

  // Fallback: aggregate all external edges and use the count-based heuristic.
  const aggregated: ExternalEdge[] = [];
  for (const [, edges] of input.externalEdgesPerChild) {
    for (const e of edges) aggregated.push(e);
  }
  return determineContainerDirection({
    container: input.container,
    edgesIn: aggregated,
    edgesOut: [],
  });
}

export function determineContainerDirection(
  input: DetermineInput,
  params?: Pick<LayoutParams, "defaultDirection" | "autoDirectionEnabled">,
): Direction {
  const explicit = input.container.meta?.didrawDirection;
  if (explicit === "TB" || explicit === "BT" || explicit === "LR" || explicit === "RL") {
    return explicit;
  }

  if (params && params.autoDirectionEnabled === false) {
    return params.defaultDirection ?? "TB";
  }

  const counts: Record<CardinalSide, number> = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const e of input.edgesIn) counts[e.side] += 1;
  for (const e of input.edgesOut) counts[e.side] += 1;

  const total = counts.top + counts.bottom + counts.left + counts.right;
  if (total === 0) return "TB";

  let bestSide: CardinalSide = "top";
  let bestCount = -1;
  for (const dir of TIE_PRIORITY) {
    const side = (Object.keys(SIDE_TO_DIRECTION) as CardinalSide[]).find(
      (s) => SIDE_TO_DIRECTION[s] === dir
    )!;
    if (counts[side] > bestCount) {
      bestCount = counts[side];
      bestSide = side;
    }
  }
  return SIDE_TO_DIRECTION[bestSide];
}
