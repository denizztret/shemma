// apps/frontend/src/settings/sections/ContainerTitlePositionSection.tsx
//
// DRW-186 Task 8 — UI-секция выбора позиции заголовка SchemaContainer.
//
// Pure-props компонент с 4 toggle-кнопками (phase 2). Используется в BoardPanel
// (board-default) и SelectionPanel (per-container override, Task 9) — поэтому
// принимает optional `title` для смены подписи между этими контекстами.
//
// Классы выровнены по конвенции sibling-секций (`settings-section`,
// `settings-section__label`, `settings-section__row`, `settings-btn`,
// `settings-btn--on`) — см. StylesSection / DirectionSection. CSS-row
// допускает wrap при tight width — 4 кнопки могут лечь в 2 ряда.

import type { FC } from "react";
import type { SchemaContainerTitlePosition } from "../../shapes/schema-container/title-position";

// Подписи укорочены под одну строку в BoardPanel/SelectionPanel (4 кнопки ×
// ≤6 символов влезают side-by-side без wrap'а). DRW-186 phase 2 — user fix.
const OPTIONS: { value: SchemaContainerTitlePosition; label: string }[] = [
  { value: "outside-frame", label: "Frame" },
  { value: "outside-banner", label: "Баннер" },
  { value: "inside-center", label: "Центр" },
  { value: "inside-left", label: "Слева" },
];

export type ContainerTitlePositionSectionProps = {
  current: SchemaContainerTitlePosition;
  onChange: (next: SchemaContainerTitlePosition) => void;
  /** Подпись секции; default — "Заголовок контейнеров" (BoardPanel). */
  title?: string;
};

export const ContainerTitlePositionSection: FC<
  ContainerTitlePositionSectionProps
> = ({ current, onChange, title = "Заголовок контейнеров" }) => (
  <div
    className="settings-section settings-section--container-title-position"
    role="radiogroup"
    aria-label={title}
  >
    <div className="settings-section__label">{title}</div>
    <div className="settings-section__row">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={current === opt.value}
          data-container-title-position={opt.value}
          onClick={() => onChange(opt.value)}
          className={`settings-btn${current === opt.value ? " settings-btn--on" : ""}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  </div>
);
