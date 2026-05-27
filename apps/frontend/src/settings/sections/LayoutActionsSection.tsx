// apps/frontend/src/settings/sections/LayoutActionsSection.tsx
import type { FC } from "react";

export type LayoutAction = {
  id: "tidy" | "force-unpin";
  label: string;
  shortcut: string;
  hint: string;
};

export const LAYOUT_ACTIONS: ReadonlyArray<LayoutAction> = [
  {
    id: "tidy",
    label: "Упорядочить",
    shortcut: "⌘⇧L",
    hint: "Пересчитать раскладку выделенных контейнеров с учётом существующих закреплений",
  },
  {
    id: "force-unpin",
    label: "Принудительно",
    shortcut: "⌘⇧⌥L",
    hint: "Пересобрать раскладку игнорируя закрепления один раз (флаги pin сохраняются)",
  },
];

export type LayoutActionsSectionProps = {
  onAction: (id: LayoutAction["id"]) => void;
  disabled?: boolean;
  pending?: LayoutAction["id"] | null;
};

export const LayoutActionsSection: FC<LayoutActionsSectionProps> = ({ onAction, disabled, pending }) => (
  <div className="settings-section settings-section--layout">
    <div className="settings-section__label">Компоновка</div>
    <div className="settings-section__row settings-section__row--stacked">
      {LAYOUT_ACTIONS.map((a) => (
        <button
          key={a.id}
          type="button"
          title={a.hint}
          disabled={disabled || pending !== null}
          onClick={() => onAction(a.id)}
          className="settings-btn"
        >
          <span className="settings-btn__label">{a.label}</span>
          <kbd className="settings-btn__kbd">{a.shortcut}</kbd>
          {pending === a.id && <span className="settings-btn__spinner" aria-label="Сохраняем">…</span>}
        </button>
      ))}
    </div>
  </div>
);
