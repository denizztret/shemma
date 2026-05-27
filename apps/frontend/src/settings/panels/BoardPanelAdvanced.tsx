// apps/frontend/src/settings/panels/BoardPanelAdvanced.tsx
import type { FC } from "react";
import type { LayoutParams } from "@shemma/domain";

const NUMERIC_FIELDS: ReadonlyArray<keyof LayoutParams> = [
  "nodeMinWidth", "nodeMinHeight", "nodePadding",
  "containerPadding", "containerLabelHeight",
  "edgeSpacing", "edgeNodeSpacing",
  "edgeLabelMaxWidth", "edgeLabelMaxLines", "edgeLabelMargin", "edgeLabelFontSize",
];

export type BoardPanelAdvancedProps = {
  effective: LayoutParams;
  onFieldChange: (field: keyof LayoutParams, value: number) => void;
  onReset: () => void;
  onBack: () => void;
};

export const BoardPanelAdvanced: FC<BoardPanelAdvancedProps> = ({ effective, onFieldChange, onReset, onBack }) => (
  <div className="settings-popover__panel settings-popover__panel--advanced" role="dialog" aria-label="Advanced layout params">
    <div className="settings-popover__header">
      <button type="button" onClick={onBack} className="settings-link">← Back</button>
      <button type="button" onClick={onReset} className="settings-link">Reset to defaults</button>
    </div>
    <div className="settings-popover__form">
      {NUMERIC_FIELDS.map((field) => (
        <label key={field} className="settings-field">
          <span className="settings-field__label">{field}</span>
          <input
            type="number"
            min={0}
            step={1}
            value={effective[field] as number}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) onFieldChange(field, v);
            }}
            className="settings-field__input"
          />
        </label>
      ))}
    </div>
  </div>
);
