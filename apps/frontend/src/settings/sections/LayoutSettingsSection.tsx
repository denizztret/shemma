// apps/frontend/src/settings/sections/LayoutSettingsSection.tsx
import type { FC } from "react";

// Spec 7.3: null variants = mixed / indeterminate state for multi-selection.
export type LayoutSettingsValue = {
  preset: "compact" | "normal" | "loose" | null;
  autoDirection: boolean | null;
  midpoint: "even" | "fixed-0.5" | null;
};

// UI labels (Compact / Normal / Roomy) intentionally differ from the @shemma/domain
// Spacing enum ("compact" | "normal" | "loose"). "Roomy" — пользовательская строка для "loose".
export const PRESET_LABELS: Record<"compact" | "normal" | "loose", string> = {
  compact: "Compact",
  normal: "Normal",
  loose: "Roomy",
};

export const PRESET_HINTS: Record<"compact" | "normal" | "loose", string> = {
  compact: "Плотная компоновка — больше элементов на экране",
  normal: "Стандартный шаг сетки",
  loose: "Просторно — легче читать диаграмму",
};

const MIDPOINT_LABELS: Record<"even" | "fixed-0.5", string> = {
  even: "равномерно",
  "fixed-0.5": "по центру",
};

const MIDPOINT_HINTS: Record<"even" | "fixed-0.5", string> = {
  even: "Распределить стрелки равномерно на одной стороне",
  "fixed-0.5": "Все стрелки сходятся в центр стороны",
};

export type LayoutSettingsSectionProps = {
  current: LayoutSettingsValue;
  onPreset: (p: "compact" | "normal" | "loose") => void;
  onAutoDirection: (v: boolean) => void;
  onMidpoint: (m: "even" | "fixed-0.5") => void;
  onAdvanced: () => void;
  onReset: () => void;
  showReset: boolean;
};

function autoDirLabel(v: boolean | null): string {
  if (v === null) return "Авто-направление: —";
  return v ? "Авто-направление: вкл" : "Авто-направление: выкл";
}

export const LayoutSettingsSection: FC<LayoutSettingsSectionProps> = ({
  current,
  onPreset,
  onAutoDirection,
  onMidpoint,
  onAdvanced,
  onReset,
  showReset,
}) => (
  <div className="settings-section settings-section--layout-settings">
    <div className="settings-section__label">Компоновка</div>
    <div className="settings-section__row">
      {(["compact", "normal", "loose"] as const).map((p) => (
        <button
          key={p}
          type="button"
          data-preset={p}
          title={PRESET_HINTS[p]}
          onClick={() => onPreset(p)}
          className={`settings-btn${current.preset === p ? " settings-btn--on" : ""}`}
        >
          {PRESET_LABELS[p]}
        </button>
      ))}
    </div>
    <button
      type="button"
      data-role="auto-direction"
      title="Автоматически выбирать направление компоновки по топологии"
      onClick={() => onAutoDirection(!(current.autoDirection ?? false))}
      className={
        "settings-btn" +
        (current.autoDirection === true ? " settings-btn--on" : "") +
        (current.autoDirection === null ? " settings-btn--indeterminate" : "")
      }
    >
      {autoDirLabel(current.autoDirection)}
    </button>
    <div className="settings-section__row">
      {(["even", "fixed-0.5"] as const).map((m) => (
        <button
          key={m}
          type="button"
          data-midpoint={m}
          title={MIDPOINT_HINTS[m]}
          onClick={() => onMidpoint(m)}
          className={`settings-btn${current.midpoint === m ? " settings-btn--on" : ""}`}
        >
          {MIDPOINT_LABELS[m]}
        </button>
      ))}
    </div>
    <button
      type="button"
      data-role="advanced"
      onClick={onAdvanced}
      className="settings-link"
    >
      Advanced ›
    </button>
    {showReset && (
      <button
        type="button"
        data-role="reset"
        onClick={onReset}
        className="settings-link settings-link--muted"
      >
        Сброс к defaults
      </button>
    )}
  </div>
);
