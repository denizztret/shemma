// apps/frontend/src/settings/sections/TextFitSection.tsx
//
// DRW-219: кнопка «Обтянуть текст» в панели выделения. Подгоняет размер
// выделенных объектов с текстом под содержимое (оптимальная ширина,
// минимальная высота). Видна, когда выделение содержит текстовый объект.

import type { FC } from "react";
import { getActiveBinding } from "../shortcuts/config";
import { formatBinding } from "../shortcuts/match";

export type TextFitSectionProps = {
  /** force=true (Opt-клик / ⌘⌥⇧F) — обтянуть и узлы с заданным вручную размером. */
  onFit: (force: boolean) => void;
  /** Opt held → кнопка live показывает «(с пинами)» + шорткат ⌘⌥⇧F (как «Принудительно»). */
  altHeld?: boolean;
};

export const TextFitSection: FC<TextFitSectionProps> = ({ onFit, altHeld }) => (
  <div className="settings-section settings-section--text-fit">
    <div className="settings-section__label">Текст</div>
    <div className="settings-section__row settings-section__row--stacked">
      <button
        type="button"
        data-role="text-fit"
        title={
          altHeld
            ? "Обтянуть текст выделения и всех вложенных, включая узлы с заданным вручную размером (игнор size-pin)"
            : "Подогнать размер под текст для выделения и всех вложенных объектов. Зажмите Opt — включая узлы с заданным вручную размером"
        }
        onClick={(e) => onFit(e.altKey)}
        className="settings-btn"
      >
        <span className="settings-btn__label">
          {altHeld ? "Обтянуть с пинами" : "Обтянуть текст"}
        </span>
        <kbd className="settings-btn__kbd">
          {formatBinding(
            getActiveBinding(altHeld ? "fit-text-force" : "fit-text"),
          )}
        </kbd>
      </button>
    </div>
  </div>
);
