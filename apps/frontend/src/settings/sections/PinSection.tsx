// apps/frontend/src/settings/sections/PinSection.tsx
import type { FC } from "react";

export type PinField = { field: "size" | "position"; label: string };

export const PIN_FIELDS: ReadonlyArray<PinField> = [
  { field: "size", label: "size" },
  { field: "position", label: "position" },
];

export type PinSectionProps = {
  values: { size: boolean; position: boolean };
  onToggle: (field: PinField["field"]) => void;
  bulkLabel?: boolean;
};

export const PinSection: FC<PinSectionProps> = ({ values, onToggle, bulkLabel }) => (
  <div className="settings-section settings-section--pin">
    <div className="settings-section__label">Size &amp; Position</div>
    <div className="settings-section__row">
      {PIN_FIELDS.map((f) => (
        <button
          key={f.field}
          type="button"
          role="switch"
          aria-checked={values[f.field]}
          onClick={() => onToggle(f.field)}
          className={`settings-btn${values[f.field] ? " settings-btn--on" : ""}`}
        >
          📌 {bulkLabel ? "all " : ""}{f.label}
        </button>
      ))}
    </div>
  </div>
);
