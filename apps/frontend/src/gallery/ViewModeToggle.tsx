import { tokens } from "../design-tokens";

export type ViewMode = "grid" | "list";

const VIEW_MODE_KEY = "shemma:gallery-view-mode";

export function loadViewMode(): ViewMode {
  try {
    const raw = localStorage.getItem(VIEW_MODE_KEY);
    return raw === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function saveViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // localStorage may throw (quota / disabled) — silently ignore.
  }
}

/** Two-button segmented control toggling grid ↔ list view for the gallery. */
export function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  const seg = (target: ViewMode, label: string, title: string) => {
    const isActive = mode === target;
    return (
      <button
        type="button"
        onClick={() => onChange(target)}
        title={title}
        aria-pressed={isActive}
        style={{
          fontFamily: tokens.font.sans,
          fontSize: tokens.font.base,
          color: isActive ? tokens.color.accent : tokens.color.textMuted,
          background: isActive ? "rgba(0,170,119,0.10)" : "transparent",
          border: "none",
          borderRadius: tokens.radius.sm,
          padding: "3px 10px",
          cursor: "pointer",
          fontWeight: isActive ? 600 : 400,
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      style={{
        display: "inline-flex",
        gap: 2,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.bgOverlay,
        padding: 2,
      }}
    >
      {seg("grid", "▦ Grid", "Grid view")}
      {seg("list", "☰ List", "List view")}
    </div>
  );
}
