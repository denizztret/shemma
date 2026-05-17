import { tokens } from "../design-tokens";

export type FilterTab = "current" | "archived";

export function FilterTabs({
  active,
  onChange,
}: {
  active: FilterTab;
  onChange: (tab: FilterTab) => void;
}) {
  const tabs: Array<{ id: FilterTab; label: string }> = [
    { id: "current", label: "Current workspace" },
    { id: "archived", label: "Archived" },
    // "All workspaces" tab shown when DRW-032 lands (SHEMMA_CROSS_WORKSPACE=1)
  ];

  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        borderBottom: `1px solid ${tokens.color.border}`,
        paddingBottom: 0,
        marginBottom: 24,
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            style={{
              fontFamily: tokens.font.sans,
              fontSize: tokens.font.base,
              color: isActive ? tokens.color.accent : tokens.color.textMuted,
              background: "transparent",
              border: "none",
              borderBottom: isActive
                ? `2px solid ${tokens.color.accent}`
                : "2px solid transparent",
              padding: "8px 16px",
              cursor: "pointer",
              fontWeight: isActive ? 600 : 400,
              marginBottom: -1,
              borderRadius: 0,
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
