import type { FC } from "react";
import { DirectionSection, type DirectionValue } from "../sections/DirectionSection";
import { LayoutSection, type LayoutAction } from "../sections/LayoutSection";
import { PinSection } from "../sections/PinSection";

export type SelectionCounts = { containers: number; nodes: number };

export function selectionFooterCounter(c: SelectionCounts): string {
  const total = c.containers + c.nodes;
  if (c.containers > 0 && c.nodes > 0) {
    return `${c.containers} container${c.containers > 1 ? "s" : ""}, ${c.nodes} node${c.nodes > 1 ? "s" : ""}`;
  }
  if (c.containers > 0) {
    return `${c.containers} container${c.containers > 1 ? "s" : ""}`;
  }
  return `${total} shape${total > 1 ? "s" : ""}`;
}

export function selectionHasContainer(c: SelectionCounts): boolean {
  return c.containers > 0;
}

export type SelectionPanelProps = {
  counts: SelectionCounts;
  direction: DirectionValue | null;
  onDirectionChange: (d: DirectionValue) => void;
  onLayoutAction: (id: LayoutAction["id"]) => void;
  pinValues: { size: boolean; position: boolean };
  onPinToggle: (field: "size" | "position") => void;
  pending: LayoutAction["id"] | null;
};

export const SelectionPanel: FC<SelectionPanelProps> = ({
  counts, direction, onDirectionChange, onLayoutAction, pinValues, onPinToggle, pending,
}) => {
  const total = counts.containers + counts.nodes;
  return (
    <div className="settings-popover__panel" role="dialog" aria-label="Selection settings">
      {selectionHasContainer(counts) && (
        <DirectionSection current={direction} onChange={onDirectionChange} />
      )}
      <LayoutSection onAction={onLayoutAction} pending={pending} />
      <PinSection values={pinValues} onToggle={onPinToggle} bulkLabel={total > 1} />
      <div className="settings-popover__footer">{selectionFooterCounter(counts)}</div>
    </div>
  );
};
