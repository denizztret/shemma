import { tokens } from "../design-tokens";

export type SortMode = "lastTouched" | "name";

export function GroupHeader({
  title,
  count,
  sortMode,
  onToggleSort,
}: {
  title: string;
  count: number;
  sortMode: SortMode;
  onToggleSort: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 12,
        paddingBottom: 6,
        borderBottom: `1px solid ${tokens.color.border}`,
      }}
    >
      <span
        style={{
          fontFamily: tokens.font.sans,
          fontSize: tokens.font.base,
          fontWeight: 600,
          color: tokens.color.text,
        }}
      >
        {title}{" "}
        <span
          style={{
            fontWeight: 400,
            color: tokens.color.textMuted,
            fontSize: tokens.font.sm,
          }}
        >
          ({count})
        </span>
      </span>
      <button
        type="button"
        onClick={onToggleSort}
        title="Toggle sort order"
        style={{
          fontFamily: tokens.font.sans,
          fontSize: tokens.font.sm,
          color: tokens.color.textMuted,
          background: tokens.color.bgOverlay,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          padding: "2px 8px",
          cursor: "pointer",
        }}
      >
        {sortMode === "lastTouched" ? "Sort: recent first" : "Sort: name A→Z"}
      </button>
    </div>
  );
}
