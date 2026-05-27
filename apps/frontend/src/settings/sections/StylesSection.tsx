// apps/frontend/src/settings/sections/StylesSection.tsx
//
// Style propagation: переключатели Линия / Шрифт / Размер. Состояние derived
// (null = mixed/indeterminate, иначе одно из enum значений). Один клик —
// одна atomic операция: sticky на parent (frame/container) + props sweep на
// descendants (см. parent calls applyStyleToSelection / postStyleDefaults).

import type { FC } from "react";
import type { StyleDash, StyleFont, StyleSize } from "@shemma/domain";

export type StyleSectionValue = {
  dash: StyleDash | null;
  font: StyleFont | null;
  size: StyleSize | null;
};

export type StylesSectionProps = {
  current: StyleSectionValue;
  onDash: (v: StyleDash) => void;
  onFont: (v: StyleFont) => void;
  onSize: (v: StyleSize) => void;
  /** Опционально: subtitle ("По умолчанию" в BoardPanel / "Для выделения" в SelectionPanel). */
  subtitle?: string;
};

const DASH_LABELS: Record<StyleDash, string> = {
  draw: "Draw",
  solid: "Solid",
};

const FONT_LABELS: Record<StyleFont, string> = {
  draw: "Draw",
  sans: "Sans",
  mono: "Mono",
};

const SIZE_LABELS: Record<StyleSize, string> = {
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
};

const DASH_TOOLTIP =
  "Применяется только к непрерывным линиям (Draw / Solid). Пунктирные и точечные настраиваются через нативную панель.";

export const StylesSection: FC<StylesSectionProps> = ({
  current,
  onDash,
  onFont,
  onSize,
  subtitle,
}) => (
  <div className="settings-section settings-section--styles">
    <div className="settings-section__label">Стили</div>
    {subtitle && <div className="settings-section__sublabel">{subtitle}</div>}

    <div className="settings-section__row" title={DASH_TOOLTIP}>
      <span className="settings-section__rowlabel">Линия</span>
      {(["draw", "solid"] as const).map((v) => (
        <button
          key={v}
          type="button"
          data-style-dash={v}
          onClick={() => onDash(v)}
          className={`settings-btn${current.dash === v ? " settings-btn--on" : ""}`}
        >
          {DASH_LABELS[v]}
        </button>
      ))}
    </div>

    <div className="settings-section__row">
      <span className="settings-section__rowlabel">Шрифт</span>
      {(["draw", "sans", "mono"] as const).map((v) => (
        <button
          key={v}
          type="button"
          data-style-font={v}
          onClick={() => onFont(v)}
          className={`settings-btn${current.font === v ? " settings-btn--on" : ""}`}
        >
          {FONT_LABELS[v]}
        </button>
      ))}
    </div>

    <div className="settings-section__row">
      <span className="settings-section__rowlabel">Размер</span>
      {(["s", "m", "l", "xl"] as const).map((v) => (
        <button
          key={v}
          type="button"
          data-style-size={v}
          onClick={() => onSize(v)}
          className={`settings-btn${current.size === v ? " settings-btn--on" : ""}`}
        >
          {SIZE_LABELS[v]}
        </button>
      ))}
    </div>
  </div>
);
