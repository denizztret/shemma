import { useRef } from "react";
import { tokens } from "../design-tokens";
import type { RoomTag } from "../transport/api";
import { humanize } from "./humanize";
import { actionBtnStyle, type RoomCardData } from "./RoomCard";
import { RoomTagsRow } from "./RoomTagsRow";
import { useRoomActions } from "./use-room-actions";

const inlineInputStyle: React.CSSProperties = {
  fontFamily: tokens.font.mono,
  fontSize: tokens.font.base,
  fontWeight: 600,
  color: tokens.color.text,
  background: "transparent",
  border: "none",
  borderBottom: `2px solid ${tokens.color.accent}`,
  borderRadius: 0,
  padding: "0 2px",
  minWidth: 0,
  outline: "none",
  flex: 1,
};

/**
 * List-mode presentation of a single room — same behaviour as RoomCard but a
 * single flex row instead of a card. Shares all action handlers via
 * useRoomActions. `tagsSlot`/`editorSlot` are filled by the tags feature.
 */
export function RoomListRow({
  space,
  room,
  sessionId,
  onArchived,
  onRestored,
  onDeleted,
  onRefresh,
  onTagClick,
  onTagsChanged,
}: {
  space: string;
  room: RoomCardData;
  sessionId: string | null;
  onArchived: (id: string) => void;
  onRestored: (id: string) => void;
  onDeleted: (id: string) => void;
  onRefresh?: () => void;
  onTagClick?: (tag: RoomTag) => void;
  onTagsChanged?: (roomId: string, tags: RoomTag[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const {
    renameEditing,
    renameValue,
    setRenameValue,
    openRoom,
    startRename,
    cancelRename,
    handleTitleKeyDown,
    handleDuplicate,
    handleArchive,
    handleRestore,
    handleDeletePermanently,
    handleExport,
  } = useRoomActions({
    space,
    room,
    onArchived,
    onRestored,
    onDeleted,
    onRefresh,
  });

  const isLinked =
    room.linkedSession !== undefined &&
    sessionId !== null &&
    room.linkedSession === sessionId;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 12px",
        borderBottom: `1px solid ${tokens.color.border}`,
        fontFamily: tokens.font.sans,
        cursor: room.archived ? "default" : "pointer",
      }}
      // Whole-row open — except clicks on interactive children (action buttons,
      // tag chips/editor, rename input). Archived rooms aren't openable.
      onClick={(e) => {
        if (room.archived || renameEditing) return;
        if ((e.target as HTMLElement).closest("button, a, input")) return;
        openRoom();
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.03)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "transparent";
      }}
    >
      {/* Name — ~35%, clickable to open or inline edit */}
      <div style={{ flex: "0 0 35%", minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
        {renameEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleTitleKeyDown}
            onBlur={cancelRename}
            // biome-ignore lint/a11y/noAutofocus: intentional UX — user just clicked Rename
            autoFocus
            style={inlineInputStyle}
          />
        ) : room.archived ? (
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: tokens.font.base,
              fontWeight: 600,
              color: tokens.color.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {room.id}
          </span>
        ) : (
          <button
            type="button"
            onClick={openRoom}
            title="Open room"
            style={{
              fontFamily: tokens.font.mono,
              fontSize: tokens.font.base,
              fontWeight: 600,
              color: tokens.color.text,
              background: "transparent",
              border: "none",
              padding: "2px 4px",
              borderRadius: tokens.radius.sm,
              cursor: "pointer",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textAlign: "left",
              maxWidth: "100%",
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.color = tokens.color.accent;
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.color = tokens.color.text;
            }}
          >
            {room.id}
          </button>
        )}
        {isLinked && (
          <span
            style={{
              fontFamily: tokens.font.sans,
              fontSize: tokens.font.sm,
              color: tokens.color.text,
              background: tokens.color.badgeDev,
              borderRadius: tokens.radius.sm,
              padding: "1px 6px",
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            linked
          </span>
        )}
        {room.archived && (
          <span
            style={{
              fontFamily: tokens.font.sans,
              fontSize: tokens.font.sm,
              color: tokens.color.textMuted,
              background: tokens.color.border,
              borderRadius: tokens.radius.sm,
              padding: "1px 6px",
              flexShrink: 0,
            }}
          >
            archived
          </span>
        )}
      </div>

      {/* Element count */}
      <span
        style={{
          flex: "0 0 70px",
          fontSize: tokens.font.sm,
          color: tokens.color.textMuted,
          whiteSpace: "nowrap",
        }}
      >
        {room.elementCount} el
      </span>

      {/* Last touched */}
      <span
        title={room.lastTouched}
        style={{
          flex: "0 0 80px",
          fontSize: tokens.font.sm,
          color: tokens.color.textMuted,
          whiteSpace: "nowrap",
        }}
      >
        {humanize(room.lastTouched)}
      </span>

      {/* Project name */}
      <span
        style={{
          flex: "1 1 0",
          minWidth: 0,
          fontSize: tokens.font.sm,
          color: tokens.color.textMuted,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {room.projectName ?? ""}
      </span>

      {/* Tags + editor affordance */}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          maxWidth: 220,
        }}
      >
        <RoomTagsRow
          space={space}
          roomId={room.id}
          tags={room.tags ?? []}
          archived={room.archived}
          onTagClick={onTagClick}
          onTagsChanged={onTagsChanged}
        />
      </div>

      {/* Actions */}
      <div style={{ flex: "0 0 auto", display: "flex", gap: 6 }}>
        {room.archived ? (
          <>
            <button type="button" onClick={handleRestore} style={actionBtnStyle}>
              Restore
            </button>
            <button
              type="button"
              onClick={handleDeletePermanently}
              style={{
                ...actionBtnStyle,
                color: tokens.color.errorBg,
                borderColor: tokens.color.errorBg,
              }}
            >
              Delete
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={handleArchive} style={actionBtnStyle}>
              Archive
            </button>
            <button type="button" onClick={handleExport} style={actionBtnStyle}>
              Export
            </button>
            <button type="button" onClick={startRename} style={actionBtnStyle}>
              Rename
            </button>
            <button
              type="button"
              onClick={() => void handleDuplicate()}
              style={actionBtnStyle}
            >
              Duplicate
            </button>
          </>
        )}
      </div>
    </div>
  );
}
