import { useRef, useState } from "react";
import { tokens } from "../design-tokens";
import type { RoomTag } from "../transport/api";
import { humanize } from "./humanize";
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
  flex: 1,
  minWidth: 0,
  outline: "none",
  width: "100%",
};

export const actionBtnStyle: React.CSSProperties = {
  fontFamily: tokens.font.sans,
  fontSize: tokens.font.sm,
  color: tokens.color.textMuted,
  background: tokens.color.bgOverlay,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  padding: "3px 8px",
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

export type RoomCardData = {
  id: string;
  version: number;
  elementCount: number;
  lastTouched: string;
  linkedSession?: string;
  projectDir?: string;
  projectName?: string;
  archived?: boolean;
  tags?: RoomTag[];
};

export function RoomCard({
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
    undoState,
    renameEditing,
    renameValue,
    setRenameValue,
    openRoom,
    startRename,
    cancelRename,
    handleTitleKeyDown,
    handleDuplicate,
    handleArchive,
    handleUndo,
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

  const thumbnailSrc = `/api/rooms/${encodeURIComponent(room.id)}/thumbnail?space=${encodeURIComponent(space)}&v=${room.version}${room.archived ? "&archived=true" : ""}`;

  return (
    <div
      style={{
        background: tokens.color.bgOverlay,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.lg,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        position: "relative",
      }}
    >
      {/* Header: room id (clickable to open, or inline edit) + linked badge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
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
              wordBreak: "break-all",
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
              wordBreak: "break-all",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = "rgba(0,0,0,0.06)";
              el.style.color = tokens.color.accent;
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = "transparent";
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
            }}
          >
            archived
          </span>
        )}
      </div>

      {/* Thumbnail — clickable to open (non-archived) */}
      <ThumbnailArea
        src={thumbnailSrc}
        elementCount={room.elementCount}
        roomId={room.id}
        onClick={room.archived ? undefined : openRoom}
      />


      {/* Metadata */}
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          fontFamily: tokens.font.sans,
          fontSize: tokens.font.sm,
          color: tokens.color.textMuted,
        }}
      >
        <span title={room.lastTouched}>{humanize(room.lastTouched)}</span>
        {room.projectName && <span>{room.projectName}</span>}
      </div>

      {/* Tags */}
      <RoomTagsRow
        space={space}
        roomId={room.id}
        tags={room.tags ?? []}
        archived={room.archived}
        onTagClick={onTagClick}
        onTagsChanged={onTagsChanged}
      />

      {/* Undo toast */}
      {undoState && (
        <div
          style={{
            background: tokens.color.warnBg,
            border: `1px solid ${tokens.color.warnBorder}`,
            borderRadius: tokens.radius.sm,
            padding: "6px 10px",
            fontFamily: tokens.font.sans,
            fontSize: tokens.font.sm,
            color: tokens.color.warnText,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>Moved to archive</span>
          <button
            type="button"
            onClick={handleUndo}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: tokens.color.accent,
              fontWeight: 600,
              fontFamily: tokens.font.sans,
              fontSize: tokens.font.sm,
              padding: "0 4px",
            }}
          >
            Undo (5s)
          </button>
        </div>
      )}

      {/* Action row */}
      <div style={{ display: "flex", gap: 6, flexWrap: "nowrap", overflowX: "auto" }}>
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
              Delete permanently
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

function ThumbnailArea({
  src,
  elementCount,
  roomId,
  onClick,
}: {
  src: string;
  elementCount: number;
  roomId: string;
  onClick?: () => void;
}) {
  const [failed, setFailed] = useState(false);

  const fallback = (
    <div
      style={{
        background: "rgba(0,0,0,0.04)",
        borderRadius: tokens.radius.sm,
        padding: "12px 8px",
        textAlign: "center",
        fontFamily: tokens.font.mono,
        fontSize: tokens.font.sm,
        color: tokens.color.textMuted,
        minHeight: 48,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: onClick ? "pointer" : "default",
        width: "100%",
      }}
      onClick={onClick}
      // biome-ignore lint/a11y/useKeyWithClickEvents: decorative fallback area
      role={onClick ? "button" : undefined}
    >
      📐 {elementCount} element{elementCount !== 1 ? "s" : ""}
    </div>
  );

  if (failed) return fallback;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: thumbnail image is a visual shortcut
    <img
      src={src}
      loading="lazy"
      alt={`preview of ${roomId}`}
      onError={() => setFailed(true)}
      onClick={onClick}
      style={{
        width: "100%",
        height: 160,
        objectFit: "contain",
        background: "#f5f5f5",
        borderRadius: tokens.radius.sm,
        display: "block",
        cursor: onClick ? "pointer" : "default",
      }}
    />
  );
}
