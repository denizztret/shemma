import type { FC } from "react";
import { DirectionSection, type DirectionValue } from "../sections/DirectionSection";
import {
  LayoutSettingsSection,
  type LayoutSettingsValue,
} from "../sections/LayoutSettingsSection";
import { StylesSection } from "../sections/StylesSection";
import type { PresetName } from "../presets";
import type { LayoutParams, Spacing } from "@shemma/domain";

const DIRECTION_HINTS: Record<DirectionValue, string> = {
  TB: "Сверху вниз",
  LR: "Слева направо",
  BT: "Снизу вверх",
  RL: "Справа налево",
  custom: "Пользовательское направление контейнеров",
};

// Mapping helpers — UI PresetName vs domain Spacing enum.
function spacingToPresetName(spacing: Spacing | undefined): PresetName {
  if (spacing === "compact") return "Compact";
  if (spacing === "loose") return "Roomy";
  return "Normal";
}

export type BoardPanelProps = {
  effective: LayoutParams;
  onDirectionChange: (d: DirectionValue) => void;
  onPresetSelect: (preset: PresetName) => void;
  onToggleAutoDirection: (enabled: boolean) => void;
  onMidpointModeChange: (mode: "even" | "fixed-0.5") => void;
  onOpenAdvanced: () => void;
};

export const BoardPanel: FC<BoardPanelProps> = ({
  effective, onDirectionChange, onPresetSelect, onToggleAutoDirection, onMidpointModeChange, onOpenAdvanced,
}) => {
  // Convert effective LayoutParams → LayoutSettingsValue (shared с SelectionPanel).
  const layoutSettings: LayoutSettingsValue = {
    preset: effective.spacing ?? null,
    autoDirection: effective.autoDirectionEnabled,
    midpoint: effective.midpointDistribution,
  };

  return (
    <div className="settings-popover__panel" role="dialog" aria-label="Настройки доски">
      <h2
        className="settings-popover__title settings-tooltip"
        data-tooltip="Применяется к новому содержимому, импорту и AI-агенту. На уже размещённые на доске схемы не влияет."
      >
        По умолчанию
      </h2>
      <DirectionSection
        current={effective.defaultDirection}
        onChange={onDirectionChange}
        hints={DIRECTION_HINTS}
      />
      <LayoutSettingsSection
        current={layoutSettings}
        onPreset={(s) => onPresetSelect(spacingToPresetName(s))}
        onAutoDirection={onToggleAutoDirection}
        onMidpoint={onMidpointModeChange}
        onAdvanced={onOpenAdvanced}
        onReset={() => {}}
        showReset={false}
        showAdvanced={true}
      />
      <StylesSection />
    </div>
  );
};
