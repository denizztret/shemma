// apps/frontend/src/settings/sections/LockSection.tsx
import type { FC } from "react";

export type LockSectionProps = {
  locked: boolean;
  onToggle: () => void;
};

/**
 * Frame lock toggle. When on, the frame is excluded from every auto-layout pass
 * (⌘⇧L / ⌘⌥⇧L / panel / direction / spacing) — see runElkLayout's `didrawLocked`
 * guard. Shown only when a single frame is selected.
 */
export const LockSection: FC<LockSectionProps> = ({ locked, onToggle }) => (
  <div className="settings-section settings-section--lock">
    <div className="settings-section__label">Блокировка</div>
    <div className="settings-section__row">
      <button
        type="button"
        role="switch"
        aria-checked={locked}
        title="Заблокировать фрейм — авто-раскладка (⌘⇧L, смена направления/компоновки и др.) не будет его трогать"
        onClick={onToggle}
        className={`settings-btn${locked ? " settings-btn--on" : ""}`}
      >
        {locked ? "🔒 Заблокирован" : "Заблокировать раскладку"}
      </button>
    </div>
  </div>
);

/**
 * Collapsed panel shown when the selection is (or sits inside) a locked frame:
 * every layout control is hidden so the user can't write direction/spacing meta
 * that wouldn't apply (and would mismatch after unlocking). Only «Разблокировать».
 */
export const LockedNotice: FC<{ onUnlock: () => void }> = ({ onUnlock }) => (
  <div className="settings-section settings-section--lock">
    <div className="settings-popover__empty">
      🔒 Фрейм заблокирован — раскладка и её настройки отключены
    </div>
    <div className="settings-section__row">
      <button
        type="button"
        title="Снять блокировку фрейма"
        onClick={onUnlock}
        className="settings-btn settings-btn--on"
      >
        Разблокировать
      </button>
    </div>
  </div>
);
