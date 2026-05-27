import type { FC } from "react";
import { DirectionSection, type DirectionValue } from "../sections/DirectionSection";
import { LayoutActionsSection, type LayoutAction } from "../sections/LayoutActionsSection";
import { LayoutSettingsSection, type LayoutSettingsValue } from "../sections/LayoutSettingsSection";
import { PinSection } from "../sections/PinSection";
import { StylesSection, type StyleSectionValue } from "../sections/StylesSection";
import type { StyleDash, StyleFont, StyleSize } from "@shemma/domain";

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
   * Conservative rule (spec 7.5): Direction + LayoutSettings секции рендерятся
   * только когда все selected — containers (containers > 0 && nodes === 0).
   * Mixed selection (containers + nodes) → false → секции скрыты, остаются
   * Pin + LayoutActions.
   */
  showContainerSections: boolean;
  direction: DirectionValue | null;
  onDirectionChange: (d: DirectionValue) => void;
  /** Aggregate layout-params для текущего выделения (null = mixed/indeterminate per field). */
  layoutSettings: LayoutSettingsValue;
  onPreset: (p: "compact" | "normal" | "loose") => void;
  onAutoDirection: (v: boolean) => void;
  onMidpoint: (m: "even" | "fixed-0.5") => void;
  onAdvanced: () => void;
  onReset: () => void;
  /** Показывать ли Reset link — true если хоть у одного из selected есть meta.didrawLayoutParams. */
  showReset: boolean;
  onLayoutAction: (id: LayoutAction["id"]) => void;
  pinValues: { size: boolean; position: boolean };
  onPinToggle: (field: "size" | "position") => void;
  pending: LayoutAction["id"] | null;
  /** Style section visibility — true когда в selection ≥1 frame/schema-container. */
  showStyles: boolean;
  styleState: StyleSectionValue;
  onStyleDash: (v: StyleDash) => void;
  onStyleFont: (v: StyleFont) => void;
  onStyleSize: (v: StyleSize) => void;
};

export const SelectionPanel: FC<SelectionPanelProps> = ({
  counts,
  showContainerSections,
  direction,
  onDirectionChange,
  layoutSettings,
  onPreset,
  onAutoDirection,
  onMidpoint,
  onAdvanced,
  onReset,
  showReset,
  onLayoutAction,
  pinValues,
  onPinToggle,
  pending,
  showStyles,
  styleState,
  onStyleDash,
  onStyleFont,
  onStyleSize,
}) => {
  const total = counts.containers + counts.nodes;
  return (
    <div className="settings-popover__panel" role="dialog" aria-label="Настройки выделения">
      {showContainerSections && (
        <>
          <DirectionSection current={direction} onChange={onDirectionChange} />
          <LayoutSettingsSection
            current={layoutSettings}
            onPreset={onPreset}
            onAutoDirection={onAutoDirection}
            onMidpoint={onMidpoint}
            onAdvanced={onAdvanced}
            onReset={onReset}
            showReset={showReset}
            showAdvanced={false}
          />
        </>
      )}
      <LayoutActionsSection onAction={onLayoutAction} pending={pending} />
      <PinSection values={pinValues} onToggle={onPinToggle} bulkLabel={total > 1} />
      {showStyles && (
        <StylesSection
          current={styleState}
          onDash={onStyleDash}
          onFont={onStyleFont}
          onSize={onStyleSize}
          subtitle="Для выделения"
        />
      )}
      <div className="settings-popover__footer">{selectionFooterCounter(counts)}</div>
    </div>
  );
};
