import { useState } from "react";
import { tokens } from "../design-tokens";
import {
  archiveRoom,
  deleteRoom,
  exportRoom,
  restoreRoom,
} from "../transport/api";
import { pushError } from "../state/error-bus";
import { humanize } from "./humanize";

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
}: {
  room: RoomCardData;
  sessionId: string | null;
  onArchived: (id: string) => void;
  onRestored: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [undoState, setUndoState] = useState<UndoState | null>(null);

  const isLinked =
    room.linkedSession !== undefined &&
    sessionId !== null &&
    room.linkedSession === sessionId;

  async function handleArchive() {
    // Optimistic: notify parent to remove from active list immediately
    onArchived(room.id);

    try {
      await archiveRoom(room.id);
    } catch (e) {
      // Revert optimistic update
      onRestored(room.id);
      pushError(`Failed to archive "${room.id}": ${(e as Error).message}`);
      return;
    }

    // 5-second undo window
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
      // Revert: add back
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
      {/* Header: room id + linked badge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
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

      {/* Thumbnail placeholder — TODO DRW-030: replace with actual canvas preview */}
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
        }}
      >
        📐 {room.elementCount} element{room.elementCount !== 1 ? "s" : ""}
      </div>

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
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {!room.archived && (
          <a
            href={`/?room=${encodeURIComponent(room.id)}`}
            style={{
              fontFamily: tokens.font.sans,
              fontSize: tokens.font.sm,
              color: "#fff",
              background: tokens.color.accent,
              border: "none",
              borderRadius: tokens.radius.sm,
              padding: "4px 12px",
              cursor: "pointer",
              textDecoration: "none",
              fontWeight: 600,
              display: "inline-block",
            }}
          >
            Open
          </a>
        )}

        {!room.archived && (
          <button
            type="button"
            onClick={handleArchive}
            style={actionBtnStyle}
          >
            Archive
          </button>
        )}

        {room.archived && (
          <button
            type="button"
            onClick={handleRestore}
            style={actionBtnStyle}
          >
            Restore
          </button>
        )}

        {!room.archived && (
          <button
            type="button"
            onClick={handleExport}
            style={actionBtnStyle}
          >
            Export
          </button>
        )}

        {room.archived && (
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
        )}
      </div>
    </div>
  );
}

const actionBtnStyle: React.CSSProperties = {
  fontFamily: tokens.font.sans,
  fontSize: tokens.font.sm,
  color: tokens.color.textMuted,
  background: tokens.color.bgOverlay,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  padding: "4px 10px",
  cursor: "pointer",
};
