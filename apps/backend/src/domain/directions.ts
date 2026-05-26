// apps/backend/src/domain/directions.ts
//
// DRW-178: 4-way heuristic for choosing TB / BT / LR / RL per container when
// mermaid did not specify direction explicitly. Picks the direction such that
// the side with the most external edges aligns with the side where the
// receiving child sits.

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
