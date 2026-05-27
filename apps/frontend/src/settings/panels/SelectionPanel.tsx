import type { FC } from "react";
import { DirectionSection, type DirectionValue } from "../sections/DirectionSection";
import { LayoutSection, type LayoutAction } from "../sections/LayoutSection";
import { PinSection } from "../sections/PinSection";

export type SelectionCounts = { containers: number; nodes: number };

function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function selectionFooterCounter(c: SelectionCounts): string {
  const total = c.containers + c.nodes;
  if (c.containers > 0 && c.nodes > 0) {
    const containerWord = plural(c.containers, "контейнер", "контейнера", "контейнеров");
    const nodeWord = plural(c.nodes, "узел", "узла", "узлов");
    return `${c.containers} ${containerWord}, ${c.nodes} ${nodeWord}`;
  }
  if (c.containers > 0) {
    return `${c.containers} ${plural(c.containers, "контейнер", "контейнера", "контейнеров")}`;
  }
  return `${total} ${plural(total, "элемент", "элемента", "элементов")}`;
}

export function selectionHasContainer(c: SelectionCounts): boolean {
  return c.containers > 0;
}

export type SelectionPanelProps = {
  counts: SelectionCounts;
  /**
   * Conservative rule: показывать Direction/Layout sections только если все
   * selected — containers (нет leaf-узлов вне). Task 12 будет full-wire через
   * rendering rule; currently passed for forward compatibility.
   */
  showContainerSections?: boolean;
  direction: DirectionValue | null;
  onDirectionChange: (d: DirectionValue) => void;
  onLayoutAction: (id: LayoutAction["id"]) => void;
  pinValues: { size: boolean; position: boolean };
  onPinToggle: (field: "size" | "position") => void;
  pending: LayoutAction["id"] | null;
};

export const SelectionPanel: FC<SelectionPanelProps> = ({
  counts, showContainerSections: _showContainerSections, direction, onDirectionChange, onLayoutAction, pinValues, onPinToggle, pending,
}) => {
  const total = counts.containers + counts.nodes;
  return (
    <div className="settings-popover__panel" role="dialog" aria-label="Настройки выделения">
      {selectionHasContainer(counts) && (
        <DirectionSection current={direction} onChange={onDirectionChange} />
      )}
      <LayoutSection onAction={onLayoutAction} pending={pending} />
      <PinSection values={pinValues} onToggle={onPinToggle} bulkLabel={total > 1} />
      <div className="settings-popover__footer">{selectionFooterCounter(counts)}</div>
    </div>
  );
};
