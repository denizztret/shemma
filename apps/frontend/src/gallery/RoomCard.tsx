import { useRef, useState } from "react";
import { tokens } from "../design-tokens";
import {
  archiveRoom,
  deleteRoom,
  duplicateRoomAuto,
  exportRoom,
  renameRoom,
  restoreRoom,
} from "../transport/api";
import { pushError } from "../state/error-bus";
import { humanize } from "./humanize";

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

const actionBtnStyle: React.CSSProperties = {
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
};

type UndoState = {
  roomId: string;
  timer: ReturnType<typeof setTimeout>;
};

export function RoomCard({
  room,
  sessionId,
  onArchived,
  onRestored,
  onDeleted,
  onRefresh,
}: {
  room: RoomCardData;
  sessionId: string | null;
  onArchived: (id: string) => void;
  onRestored: (id: string) => void;
  onDeleted: (id: string) => void;
  onRefresh?: () => void;
}) {
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  const [renameEditing, setRenameEditing] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const isLinked =
    room.linkedSession !== undefined &&
    sessionId !== null &&
    room.linkedSession === sessionId;

  function openRoom() {
    location.assign(`/?room=${encodeURIComponent(room.id)}`);
  }

  function startRename() {
    setRenameValue(room.id);
    setRenameEditing(true);
    // Focus happens via the input's autoFocus
  }

  function cancelRename() {
    setRenameEditing(false);
    setRenameValue("");
  }

  async function submitRename() {
    const to = renameValue.trim();
    if (!to || to === room.id) {
      cancelRename();
      return;
    }
    const res = await renameRoom(room.id, to);
    if (!res.ok) {
      pushError(
        res.error === "room-exists"
          ? `Cannot rename: room "${res.existingId}" already exists`
          : `Rename failed: ${res.error ?? "unknown error"}`,
      );
      return;
    }
    setRenameEditing(false);
    setRenameValue("");
    onRefresh?.();
  }

  function handleTitleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") void submitRename();
    else if (e.key === "Escape") cancelRename();
  }

  async function handleDuplicate() {
    const res = await duplicateRoomAuto(room.id);
    if (!res.ok) {
      pushError(`Duplicate failed: ${res.error ?? "unknown error"}`);
      return;
    }
    onRefresh?.();
  }

  async function handleArchive() {
    onArchived(room.id);
    try {
      await archiveRoom(room.id);
    } catch (e) {
      onRestored(room.id);
      pushError(`Failed to archive "${room.id}": ${(e as Error).message}`);
      return;
    }
    const timer = setTimeout(() => {
      setUndoState(null);
    }, 5000);
    setUndoState({ roomId: room.id, timer });
  }

  async function handleUndo() {
    if (!undoState) return;
    clearTimeout(undoState.timer);
    setUndoState(null);
    try {
      await restoreRoom(room.id);
      onRestored(room.id);
    } catch (e) {
      pushError(`Failed to undo archive "${room.id}": ${(e as Error).message}`);
    }
  }

  async function handleRestore() {
    try {
      await restoreRoom(room.id);
      onRestored(room.id);
    } catch (e) {
      pushError(`Failed to restore "${room.id}": ${(e as Error).message}`);
    }
  }

  async function handleDeletePermanently() {
    if (
      !window.confirm(
        `Permanently delete "${room.id}"? This cannot be undone.`,
      )
    )
      return;
    onDeleted(room.id);
    try {
      await deleteRoom(room.id, { mode: "hard", force: true });
    } catch (e) {
      onRestored(room.id);
      pushError(
        `Failed to permanently delete "${room.id}": ${(e as Error).message}`,
      );
    }
  }

  async function handleExport() {
    const dest = window.prompt(
      `Export "${room.id}" to file path:`,
      `/tmp/${room.id}.json`,
    );
    if (!dest) return;
    try {
      await exportRoom(room.id, dest);
    } catch (e) {
      pushError(`Export failed: ${(e as Error).message}`);
    }
  }

  const thumbnailSrc = `/api/rooms/${encodeURIComponent(room.id)}/thumbnail?v=${room.version}${room.archived ? "&archived=true" : ""}`;

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
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
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
