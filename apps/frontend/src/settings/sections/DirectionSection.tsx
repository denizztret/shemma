import type { FC } from "react";

export type DirectionValue = "TB" | "LR" | "BT" | "RL" | "custom";

export const DIRECTION_OPTIONS: ReadonlyArray<{ value: DirectionValue; label: string }> = [
  { value: "TB", label: "TB" },
  { value: "LR", label: "LR" },
  { value: "BT", label: "BT" },
  { value: "RL", label: "RL" },
  { value: "custom", label: "Custom" },
];

export type DirectionSectionProps = {
  current: DirectionValue | null;
  onChange: (next: DirectionValue) => void;
  disabled?: boolean;
};

export const DirectionSection: FC<DirectionSectionProps> = ({ current, onChange, disabled }) => {
  return (
    <div className="settings-section settings-section--direction" role="radiogroup" aria-label="Direction">
      <div className="settings-section__label">Direction</div>
      <div className="settings-section__row">
        {DIRECTION_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={current === o.value}
            disabled={disabled}
            data-direction={o.value}
            onClick={() => onChange(o.value)}
            className={`settings-btn${current === o.value ? " settings-btn--on" : ""}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
};
