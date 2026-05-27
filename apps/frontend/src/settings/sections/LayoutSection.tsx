// apps/frontend/src/settings/sections/LayoutSection.tsx
import type { FC } from "react";

export type LayoutAction = { id: "tidy" | "force-unpin"; label: string; shortcut: string };

export const LAYOUT_ACTIONS: ReadonlyArray<LayoutAction> = [
  { id: "tidy", label: "Tidy", shortcut: "⌘⇧L" },
  { id: "force-unpin", label: "Force re-layout", shortcut: "⌘⇧⌥L" },
];

export type LayoutSectionProps = {
  onAction: (id: LayoutAction["id"]) => void;
  disabled?: boolean;
  pending?: LayoutAction["id"] | null;
};

export const LayoutSection: FC<LayoutSectionProps> = ({ onAction, disabled, pending }) => (
  <div className="settings-section settings-section--layout">
    <div className="settings-section__label">Layout</div>
    <div className="settings-section__row settings-section__row--stacked">
      {LAYOUT_ACTIONS.map((a) => (
        <button
          key={a.id}
          type="button"
          disabled={disabled || pending !== null}
          onClick={() => onAction(a.id)}
          className="settings-btn"
        >
          <span className="settings-btn__label">{a.label}</span>
          <kbd className="settings-btn__kbd">{a.shortcut}</kbd>
          {pending === a.id && <span className="settings-btn__spinner" aria-label="Saving">…</span>}
        </button>
      ))}
    </div>
  </div>
);
