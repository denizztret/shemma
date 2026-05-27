import type { FC } from "react";
import { DirectionSection, type DirectionValue } from "../sections/DirectionSection";
import { StylesSection } from "../sections/StylesSection";
import { SPACING_PRESETS, reverseMapPreset, type PresetName } from "../presets";
import type { LayoutParams } from "@shemma/domain";

const PRESET_HINTS: Record<PresetName, string> = {
  Compact: "Плотная компоновка — больше элементов на экране",
  Normal: "Стандартный шаг сетки",
  Roomy: "Просторно — легче читать диаграмму",
};

const DIRECTION_HINTS: Record<DirectionValue, string> = {
  TB: "Сверху вниз",
  LR: "Слева направо",
  BT: "Снизу вверх",
  RL: "Справа налево",
  custom: "Пользовательское направление контейнеров",
};

const MIDPOINT_HINTS = {
  even: "Стрелки на одной стороне распределяются равномерно (1/3, 2/3 и т.д.)",
  "fixed-0.5": "Все стрелки на одной стороне сходятся в её середину",
} as const;

const AUTO_DIRECTION_HINT =
  "Подбирать направление подграфов автоматически по топологии связей (только для контейнеров без явного direction). На уже заданные вручную направления не влияет.";

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
      <div className="settings-section settings-section--layout">
        <div className="settings-section__label">Компоновка</div>
        <div className="settings-section__row" role="radiogroup" aria-label="Шаг сетки">
          {(Object.keys(SPACING_PRESETS) as PresetName[]).map((name) => (
            <span key={name} className="settings-preset-cell">
              <button
                type="button"
                role="radio"
                aria-checked={currentPreset === name}
                aria-describedby={`preset-hint-${name}`}
                title={PRESET_HINTS[name]}
                onClick={() => onPresetSelect(name)}
                className={`settings-btn${currentPreset === name ? " settings-btn--on" : ""}`}
              >
                {name}
              </button>
              <span id={`preset-hint-${name}`} className="sr-only">{PRESET_HINTS[name]}</span>
            </span>
          ))}
          {currentPreset === null && <span className="settings-section__hint">Custom</span>}
        </div>
        <div className="settings-section__row">
          <button
            type="button"
            role="switch"
            aria-checked={effective.autoDirectionEnabled}
            title={AUTO_DIRECTION_HINT}
            onClick={() => onToggleAutoDirection(!effective.autoDirectionEnabled)}
            className={`settings-btn${effective.autoDirectionEnabled ? " settings-btn--on" : ""}`}
          >
            Автонаправление: {effective.autoDirectionEnabled ? "вкл" : "выкл"}
          </button>
        </div>
        <div className="settings-section__row" role="radiogroup" aria-label="Привязка стрелок">
          {(["even", "fixed-0.5"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={effective.midpointDistribution === mode}
              title={MIDPOINT_HINTS[mode]}
              onClick={() => onMidpointModeChange(mode)}
              className={`settings-btn${effective.midpointDistribution === mode ? " settings-btn--on" : ""}`}
            >
              {mode === "fixed-0.5" ? "по центру" : "равномерно"}
            </button>
          ))}
        </div>
      </div>
      <StylesSection />
      <div className="settings-section">
        <button type="button" className="settings-link" onClick={onOpenAdvanced}>
          Дополнительно ›
        </button>
      </div>
    </div>
  );
};
