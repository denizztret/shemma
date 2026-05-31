import { useState } from "react";
import { tokens } from "../design-tokens";
import type { RoomTag } from "../transport/api";
import { TagChip } from "./TagChip";
import { TagEditor } from "./TagEditor";

/**
 * Renders a room's tag chips + (for non-archived rooms) a "+ tag" affordance
 * that opens the inline TagEditor popover anchored to it. Shared by RoomCard
 * (grid) and RoomListRow (list).
 */
export function RoomTagsRow({
  space,
  roomId,
  tags,
  archived,
  onTagClick,
  onTagsChanged,
}: {
  space: string;
  roomId: string;
  tags: RoomTag[];
  archived?: boolean;
  onTagClick?: (tag: RoomTag) => void;
  onTagsChanged?: (roomId: string, tags: RoomTag[]) => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 4,
      }}
    >
      {tags.map((t, i) => (
        <TagChip
          key={`${t.name}-${i}`}
          tag={t}
          onClick={onTagClick ? () => onTagClick(t) : undefined}
        />
      ))}
      {!archived && (
        <button
          type="button"
          // Open-only: a toggle here can never close, because TagEditor's
          // click-outside fires first (setEditing(false)) and the toggle then
          // flips it straight back to true. Close stays via Esc/Cancel/outside.
          onClick={() => setEditing(true)}
          title="Edit tags"
          style={{
            fontFamily: tokens.font.sans,
            fontSize: tokens.font.sm,
            color: tokens.color.textMuted,
            background: "transparent",
            border: `1px dashed ${tokens.color.border}`,
            borderRadius: 999,
            padding: "0 8px",
            lineHeight: 1.6,
            cursor: "pointer",
          }}
        >
          + tag
        </button>
      )}
      {editing && (
        <TagEditor
          space={space}
          roomId={roomId}
          initialTags={tags}
          onApplied={(next) => onTagsChanged?.(roomId, next)}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}
