// apps/frontend/src/settings/sections/PinSection.tsx
import type { FC } from "react";

export type PinField = {
  field: "size" | "position";
  label: string;
  hint: string;
};

/** Aggregate pin state across a set of objects: all on / all off / mixed. */
export type PinTriState = "on" | "off" | "mixed";

export function aggregatePinState(values: boolean[]): PinTriState {
  if (values.length === 0) return "off";
  if (values.every((v) => v)) return "on";
  if (values.every((v) => !v)) return "off";
  return "mixed";
}

export const PIN_FIELDS: ReadonlyArray<PinField> = [
  {
    field: "size",
    label: "Размер",
    hint: "Закрепить текущий размер — авто-раскладка не будет менять ширину/высоту",
  },
  {
    field: "position",
    label: "Позиция",
    hint: "Закрепить текущее положение — авто-раскладка не будет двигать узел",
  },
];

export type PinSectionProps = {
  values: { size: PinTriState; position: PinTriState };
  onToggle: (field: PinField["field"], modifiers: { alt: boolean }) => void;
  /**
   * Section header — communicates the scope (which objects the buttons act on).
   * The caller swaps it live while Opt is held (объекты ↔ фрейм/контейнер).
   */
  label?: string;
};

const classFor = (state: PinTriState): string =>
  state === "on"
    ? " settings-btn--on"
    : state === "mixed"
      ? " settings-btn--indeterminate"
      : "";

const ariaFor = (state: PinTriState): "true" | "false" | "mixed" =>
  state === "on" ? "true" : state === "mixed" ? "mixed" : "false";

export const PinSection: FC<PinSectionProps> = ({
  values,
  onToggle,
  label = "Размер и позиция",
}) => (
  <div className="settings-section settings-section--pin">
    <div className="settings-section__label">{label}</div>
    <div className="settings-section__row">
      {PIN_FIELDS.map((f) => {
        const state = values[f.field];
        return (
          <button
            key={f.field}
            type="button"
            role="switch"
            aria-checked={ariaFor(state)}
            title={f.hint}
            onClick={(e) => onToggle(f.field, { alt: e.altKey })}
            className={`settings-btn${classFor(state)}`}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  </div>
);
