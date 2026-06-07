// apps/frontend/src/settings/sections/TextFitSection.tsx
//
// DRW-219: кнопка «Обтянуть текст» в панели выделения. Подгоняет размер
// выделенных объектов с текстом под содержимое (оптимальная ширина,
// минимальная высота). Видна, когда выделение содержит текстовый объект.

import type { FC } from "react";
import { getActiveBinding } from "../shortcuts/config";
import { formatBinding } from "../shortcuts/match";

export type TextFitSectionProps = {
  onFit: () => void;
};

export const TextFitSection: FC<TextFitSectionProps> = ({ onFit }) => (
  <div className="settings-section settings-section--text-fit">
    <div className="settings-section__label">Текст</div>
    <div className="settings-section__row settings-section__row--stacked">
      <button
        type="button"
        data-role="text-fit"
        title="Подогнать размер под текст: оптимальная ширина, минимальная высота, без обрезки"
        onClick={onFit}
        className="settings-btn"
      >
        <span className="settings-btn__label">Обтянуть текст</span>
        <kbd className="settings-btn__kbd">
          {formatBinding(getActiveBinding("fit-text"))}
        </kbd>
      </button>
    </div>
  </div>
);
