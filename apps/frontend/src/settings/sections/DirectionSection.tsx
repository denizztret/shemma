import type { FC } from "react";

export type DirectionValue = "TB" | "LR" | "BT" | "RL" | "custom";

export const DIRECTION_OPTIONS: ReadonlyArray<{
  value: DirectionValue;
  label: string;
  iconOnly?: boolean;
}> = [
  { value: "TB", label: "TB" },
  { value: "LR", label: "LR" },
  { value: "BT", label: "BT" },
  { value: "RL", label: "RL" },
  { value: "custom", label: "•", iconOnly: true },
];

const DEFAULT_HINTS: Record<DirectionValue, string> = {
  TB: "Top → Bottom",
  LR: "Left → Right",
  BT: "Bottom → Top",
  RL: "Right → Left",
  custom: "Custom per container",
};

export type DirectionSectionProps = {
  current: DirectionValue | null;
  onChange: (next: DirectionValue) => void;
  disabled?: boolean;
  hints?: Partial<Record<DirectionValue, string>>;
  label?: string;
};

export const DirectionSection: FC<DirectionSectionProps> = ({ current, onChange, disabled, hints, label }) => {
  const tipFor = (v: DirectionValue) => hints?.[v] ?? DEFAULT_HINTS[v];
  return (
    <div className="settings-section settings-section--direction" role="radiogroup" aria-label={label ?? "Direction"}>
      <div className="settings-section__label">{label ?? "Direction"}</div>
      <div className="settings-section__row">
        {DIRECTION_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={current === o.value}
            aria-label={o.iconOnly ? tipFor(o.value) : undefined}
            disabled={disabled}
            data-direction={o.value}
            title={tipFor(o.value)}
            onClick={() => onChange(o.value)}
            className={`settings-btn${o.iconOnly ? " settings-btn--icon" : ""}${current === o.value ? " settings-btn--on" : ""}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
};
