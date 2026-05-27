// apps/frontend/src/settings/sections/PinSection.tsx
import type { FC } from "react";

export type PinField = {
  field: "size" | "position";
  label: string;
  labelBulk: string;
  hint: string;
};

export const PIN_FIELDS: ReadonlyArray<PinField> = [
  {
    field: "size",
    label: "Размер",
    labelBulk: "Все размеры",
    hint: "Закрепить текущий размер — авто-раскладка не будет менять ширину/высоту",
  },
  {
    field: "position",
    label: "Позиция",
    labelBulk: "Все позиции",
    hint: "Закрепить текущее положение — авто-раскладка не будет двигать узел",
  },
];

export type PinSectionProps = {
  values: { size: boolean; position: boolean };
  onToggle: (field: PinField["field"]) => void;
  bulkLabel?: boolean;
};

export const PinSection: FC<PinSectionProps> = ({ values, onToggle, bulkLabel }) => (
  <div className="settings-section settings-section--pin">
    <div className="settings-section__label">Размер и позиция</div>
    <div className="settings-section__row">
      {PIN_FIELDS.map((f) => (
        <button
          key={f.field}
          type="button"
          role="switch"
          aria-checked={values[f.field]}
          title={f.hint}
          onClick={() => onToggle(f.field)}
          className={`settings-btn${values[f.field] ? " settings-btn--on" : ""}`}
        >
          {bulkLabel ? f.labelBulk : f.label}
        </button>
      ))}
    </div>
  </div>
);
