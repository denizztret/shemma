import type {
  LayoutAlgorithm,
  StyleDash,
  StyleFont,
  StyleSize,
} from "@shemma/domain";
import type { FC } from "react";
import type { SchemaContainerTitlePosition } from "../../shapes/schema-container/title-position";
import { ContainerTitlePositionSection } from "../sections/ContainerTitlePositionSection";
import {
  DirectionSection,
  type DirectionValue,
} from "../sections/DirectionSection";
import {
  type LayoutAction,
  LayoutActionsSection,
} from "../sections/LayoutActionsSection";
import {
  LayoutSettingsSection,
  type LayoutSettingsValue,
} from "../sections/LayoutSettingsSection";
import { LockSection, LockedNotice } from "../sections/LockSection";
import { PinSection, type PinTriState } from "../sections/PinSection";
import {
  type StyleSectionValue,
  StylesSection,
} from "../sections/StylesSection";

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
    const containerWord = plural(
      c.containers,
      "контейнер",
      "контейнера",
      "контейнеров",
    );
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
  onEngine: (e: LayoutAlgorithm) => void;
  onAdvanced: () => void;
  onReset: () => void;
  /** Показывать ли Reset link — true если хоть у одного из selected есть meta.didrawLayoutParams. */
  showReset: boolean;
  onLayoutAction: (id: LayoutAction["id"], modifiers: { alt: boolean }) => void;
  pinValues: { size: PinTriState; position: PinTriState };
  onPinToggle: (
    field: "size" | "position",
    modifiers: { alt: boolean },
  ) => void;
  /** Pin section header (scope) — swapped live while Opt is held. */
  pinLabel?: string;
  /** Opt held — drives «Упорядочить»↔«Принудительно» + pin scope highlighting. */
  altHeld?: boolean;
  /** Lock toggle — defined only when a single frame is selected. */
  frameLocked?: boolean;
  onFrameLockToggle?: () => void;
  /** Selection is (or sits inside) a locked frame → collapse to «Разблокировать». */
  lockedFrame?: boolean;
  onUnlockFrame?: () => void;
  pending: LayoutAction["id"] | null;
  /** Style section visibility — true когда в selection ≥1 frame/schema-container. */
  showStyles: boolean;
  styleState: StyleSectionValue;
  onStyleDash: (v: StyleDash) => void;
  onStyleFont: (v: StyleFont) => void;
  onStyleSize: (v: StyleSize) => void;
  /**
   * Per-container titlePosition override. Defined только когда выбран ровно
   * один SchemaContainer; иначе оба поля undefined и секция скрывается.
   * Render-time SSOT — `shape.props.titlePosition` (spec §Title position resolution).
   */
  singleContainerTitlePosition?: SchemaContainerTitlePosition;
  onSingleContainerTitlePositionChange?: (
    next: SchemaContainerTitlePosition,
  ) => void;
  /**
   * Frame-scope bulk-apply (DRW-186 frame-scope extension). Defined только когда
   * выбран ровно один Frame. Изменение значения:
   *   1. Сохраняет `next` в `frame.meta.didrawContainerTitlePosition` (memo для
   *      inheritance newly-created child SchemaContainer'ов).
   *   2. Bulk-apply `next` в `props.titlePosition` всех existing child
   *      SchemaContainer'ов внутри этого Frame'а.
   * Сам Frame визуально НЕ меняется.
   */
  singleFrameContainerTitlePosition?: SchemaContainerTitlePosition;
  onSingleFrameContainerTitlePositionChange?: (
    next: SchemaContainerTitlePosition,
  ) => void;
};

export const SelectionPanel: FC<SelectionPanelProps> = ({
  counts,
  showContainerSections,
  direction,
  onDirectionChange,
  layoutSettings,
  onPreset,
  onEngine,
  onAdvanced,
  onReset,
  showReset,
  onLayoutAction,
  pinValues,
  onPinToggle,
  pinLabel,
  altHeld,
  frameLocked,
  onFrameLockToggle,
  lockedFrame,
  onUnlockFrame,
  pending,
  showStyles,
  styleState,
  onStyleDash,
  onStyleFont,
  onStyleSize,
  singleContainerTitlePosition,
  onSingleContainerTitlePositionChange,
  singleFrameContainerTitlePosition,
  onSingleFrameContainerTitlePositionChange,
}) => {
  if (lockedFrame && onUnlockFrame) {
    return (
      <div
        className="settings-popover__panel"
        role="dialog"
        aria-label="Заблокированный фрейм"
      >
        <LockedNotice onUnlock={onUnlockFrame} />
      </div>
    );
  }
  return (
    <div
      className="settings-popover__panel"
      role="dialog"
      aria-label="Настройки выделения"
    >
      {showContainerSections && (
        <>
          <DirectionSection current={direction} onChange={onDirectionChange} />
          <LayoutSettingsSection
            current={layoutSettings}
            onPreset={onPreset}
            onEngine={onEngine}
            onAdvanced={onAdvanced}
            onReset={onReset}
            showReset={showReset}
            showAdvanced={false}
          />
          {singleContainerTitlePosition &&
            onSingleContainerTitlePositionChange && (
              <ContainerTitlePositionSection
                current={singleContainerTitlePosition}
                onChange={onSingleContainerTitlePositionChange}
                title="Заголовок этого контейнера"
              />
            )}
          {singleFrameContainerTitlePosition !== undefined &&
            onSingleFrameContainerTitlePositionChange && (
              <ContainerTitlePositionSection
                current={singleFrameContainerTitlePosition}
                onChange={onSingleFrameContainerTitlePositionChange}
                title="Заголовок контейнеров в этом фрейме"
              />
            )}
        </>
      )}
      <LayoutActionsSection
        onAction={onLayoutAction}
        pending={pending}
        altHeld={altHeld}
      />
      {onFrameLockToggle && (
        <LockSection locked={!!frameLocked} onToggle={onFrameLockToggle} />
      )}
      <PinSection values={pinValues} onToggle={onPinToggle} label={pinLabel} />
      {showStyles && (
        <StylesSection
          current={styleState}
          onDash={onStyleDash}
          onFont={onStyleFont}
          onSize={onStyleSize}
          subtitle="Для выделения"
        />
      )}
      <div className="settings-popover__footer">
        {selectionFooterCounter(counts)}
      </div>
    </div>
  );
};
