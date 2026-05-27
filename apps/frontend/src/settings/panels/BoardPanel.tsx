// apps/frontend/src/settings/panels/BoardPanel.tsx
import type { FC } from "react";
import { DirectionSection, type DirectionValue } from "../sections/DirectionSection";
import { StylesSection } from "../sections/StylesSection";
import { SPACING_PRESETS, reverseMapPreset, type PresetName } from "../presets";
import type { LayoutParams } from "@shemma/domain";

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
  const currentPreset = reverseMapPreset({
    nodePadding: effective.nodePadding,
    containerPadding: effective.containerPadding,
    edgeSpacing: effective.edgeSpacing,
    edgeNodeSpacing: effective.edgeNodeSpacing,
  });

  return (
    <div className="settings-popover__panel" role="dialog" aria-label="Board layout">
      <DirectionSection current={effective.defaultDirection} onChange={onDirectionChange} />
      <div className="settings-section settings-section--layout">
        <div className="settings-section__label">Layout</div>
        <div className="settings-section__row" role="radiogroup" aria-label="Spacing preset">
          {(Object.keys(SPACING_PRESETS) as PresetName[]).map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={currentPreset === name}
              onClick={() => onPresetSelect(name)}
              className={`settings-btn${currentPreset === name ? " settings-btn--on" : ""}`}
            >
              {name}
            </button>
          ))}
          {currentPreset === null && <span className="settings-section__hint">Custom</span>}
        </div>
        <div className="settings-section__row">
          <button
            type="button"
            role="switch"
            aria-checked={effective.autoDirectionEnabled}
            onClick={() => onToggleAutoDirection(!effective.autoDirectionEnabled)}
            className={`settings-btn${effective.autoDirectionEnabled ? " settings-btn--on" : ""}`}
          >
            Auto-direction: {effective.autoDirectionEnabled ? "on" : "off"}
          </button>
        </div>
        <div className="settings-section__row" role="radiogroup" aria-label="Midpoint mode">
          {(["even", "fixed-0.5"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={effective.midpointDistribution === mode}
              onClick={() => onMidpointModeChange(mode)}
              className={`settings-btn${effective.midpointDistribution === mode ? " settings-btn--on" : ""}`}
            >
              {mode === "fixed-0.5" ? "center" : "even"}
            </button>
          ))}
        </div>
      </div>
      <StylesSection />
      <div className="settings-section">
        <button type="button" className="settings-link" onClick={onOpenAdvanced}>
          All 16 params →
        </button>
      </div>
    </div>
  );
};
