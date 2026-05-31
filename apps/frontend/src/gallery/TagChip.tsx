import { tokens } from "../design-tokens";
import type { RoomTag } from "../transport/api";
import { TAG_COLORS } from "./tag-colors";

/**
 * A single coloured tag chip. When `onClick` is set it acts as a button
 * (click-to-filter). When `onRemove` is set a ×-affordance is shown (editor /
 * active-filter bar).
 */
export function TagChip({
  tag,
  onClick,
  onRemove,
}: {
  tag: RoomTag;
  onClick?: () => void;
  onRemove?: () => void;
}) {
  const palette = TAG_COLORS[tag.color];
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    background: palette.bg,
    color: palette.text,
    fontFamily: tokens.font.sans,
    fontSize: tokens.font.sm,
    fontWeight: 600,
    borderRadius: 999,
    padding: "1px 8px",
    border: "none",
    lineHeight: 1.5,
    maxWidth: 140,
  };

  const label = (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {tag.name}
    </span>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`Filter by "${tag.name}"`}
        style={{ ...base, cursor: "pointer" }}
      >
        {label}
        {onRemove && (
          <span
            // biome-ignore lint/a11y/useKeyWithClickEvents: nested remove inside button row
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            role="button"
            title="Remove"
            style={{ cursor: "pointer", opacity: 0.85 }}
          >
            ×
          </span>
        )}
      </button>
    );
  }

  return (
    <span style={base}>
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove"
          style={{
            background: "transparent",
            border: "none",
            color: palette.text,
            cursor: "pointer",
            padding: 0,
            fontSize: tokens.font.base,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}
