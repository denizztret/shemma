// apps/frontend/src/settings/sections/LayoutActionsSection.tsx
import type { FC } from "react";
import { getActiveBinding } from "../shortcuts/config";
import { formatBinding } from "../shortcuts/match";

export type LayoutAction = {
  // Kept as a union so `pending` / `onAction` typing stays stable; the single
  // button always reports "tidy" — force is decided by the Opt modifier.
  id: "tidy" | "force-unpin";
};

export type LayoutActionsSectionProps = {
  onAction: (id: LayoutAction["id"], modifiers: { alt: boolean }) => void;
  disabled?: boolean;
  pending?: LayoutAction["id"] | null;
  /** Opt held → the single button shows «Принудительно» (force) live. */
  altHeld?: boolean;
};

export const LayoutActionsSection: FC<LayoutActionsSectionProps> = ({
  onAction,
  disabled,
  pending,
  altHeld,
}) => (
  <div className="settings-section settings-section--layout">
    <div className="settings-section__label">Компоновка</div>
    <div className="settings-section__row settings-section__row--stacked">
      <button
        type="button"
        title={
          altHeld
            ? "Пересобрать раскладку, игнорируя закрепления один раз (флаги pin сохраняются)"
            : "Пересчитать раскладку с учётом закреплений. Зажмите Opt — принудительно"
        }
        disabled={disabled || pending != null}
        onClick={(e) => onAction("tidy", { alt: e.altKey })}
        className="settings-btn"
      >
        <span className="settings-btn__label">
          {altHeld ? "Принудительно" : "Упорядочить"}
        </span>
        <kbd className="settings-btn__kbd">
          {formatBinding(
            getActiveBinding(altHeld ? "force-relayout" : "tidy-layout"),
          )}
        </kbd>
        {pending != null && (
          <span className="settings-btn__spinner" aria-label="Сохраняем">
            …
          </span>
        )}
      </button>
    </div>
  </div>
);
