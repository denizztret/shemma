// apps/frontend/src/settings/sections/ArrowKindSection.tsx
//
// DRW-207: переключатель типа стрелок (arc / elbow).
// BoardPanel — board default для НОВЫХ стрелок (tri-state: re-click активной
// снимает выбор → статус-кво «ручные arc, AI elbow»; обрабатывается caller'ом).
// SelectionPanel — переключение props.kind уже существующих выделенных стрелок.

import type { FC } from "react";
import type { ArrowKind } from "@shemma/domain";

export type ArrowKindSectionProps = {
  /** null = unset (board) или mixed/нет стрелок (selection). */
  current: ArrowKind | null;
  onChange: (v: ArrowKind) => void;
  /** Опционально: subtitle ("По умолчанию" / "Для выделения"). */
  subtitle?: string;
};

const KIND_LABELS: Record<ArrowKind, string> = {
  arc: "Дуга",
  elbow: "Угловая",
};

const KIND_TOOLTIP =
  "Тип стрелок: дуговые (свободные) или угловые (ортогональные, как у импортированных схем).";

export const ArrowKindSection: FC<ArrowKindSectionProps> = ({
  current,
  onChange,
  subtitle,
}) => (
  <div className="settings-section settings-section--arrow-kind">
    <div className="settings-section__label">Стрелки</div>
    {subtitle && <div className="settings-section__sublabel">{subtitle}</div>}
    <div className="settings-section__row" title={KIND_TOOLTIP}>
      <span className="settings-section__rowlabel">Тип</span>
      {(["arc", "elbow"] as const).map((v) => (
        <button
          key={v}
          type="button"
          data-arrow-kind={v}
          onClick={() => onChange(v)}
          className={`settings-btn${current === v ? " settings-btn--on" : ""}`}
        >
          {KIND_LABELS[v]}
        </button>
      ))}
    </div>
  </div>
);
