import { useState } from "react";
import {
  archiveRoom,
  deleteRoom,
  duplicateRoomAuto,
  exportRoom,
  renameRoom,
  restoreRoom,
  roomHref,
} from "../transport/api";
import { pushError } from "../state/error-bus";

export type RoomActionsTarget = {
  id: string;
  archived?: boolean;
};

type UndoState = {
  roomId: string;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Shared per-room action handlers + open/rename state used by both RoomCard
 * (grid) and RoomListRow (list). Keeps the two presentations DRY — the only
 * difference between them is layout, not behaviour.
 */
export function useRoomActions({
  space,
  room,
  onArchived,
  onRestored,
  onDeleted,
  onRefresh,
}: {
  space: string;
  room: RoomActionsTarget;
  onArchived: (id: string) => void;
  onRestored: (id: string) => void;
  onDeleted: (id: string) => void;
  onRefresh?: () => void;
}) {
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  const [renameEditing, setRenameEditing] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  function openRoom() {
    location.assign(roomHref(space, room.id));
  }

  function startRename() {
    setRenameValue(room.id);
    setRenameEditing(true);
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
    const res = await renameRoom(space, room.id, to);
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

  async function handleDuplicate() {
    const res = await duplicateRoomAuto(space, room.id);
    if (!res.ok) {
      pushError(`Duplicate failed: ${res.error ?? "unknown error"}`);
      return;
    }
    onRefresh?.();
  }

  async function handleArchive() {
    onArchived(room.id);
    try {
      await archiveRoom(space, room.id);
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
      await restoreRoom(space, room.id);
      onRestored(room.id);
    } catch (e) {
      pushError(`Failed to undo archive "${room.id}": ${(e as Error).message}`);
    }
  }

  async function handleRestore() {
    try {
      await restoreRoom(space, room.id);
      onRestored(room.id);
    } catch (e) {
      pushError(`Failed to restore "${room.id}": ${(e as Error).message}`);
    }
  }

  async function handleDeletePermanently() {
    if (!window.confirm(`Permanently delete "${room.id}"? This cannot be undone.`))
      return;
    onDeleted(room.id);
    try {
      await deleteRoom(space, room.id, { mode: "hard", force: true });
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
      await exportRoom(space, room.id, dest);
    } catch (e) {
      pushError(`Export failed: ${(e as Error).message}`);
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") void submitRename();
    else if (e.key === "Escape") cancelRename();
  }

  return {
    undoState,
    renameEditing,
    renameValue,
    setRenameValue,
    openRoom,
    startRename,
    cancelRename,
    submitRename,
    handleTitleKeyDown,
    handleDuplicate,
    handleArchive,
    handleUndo,
    handleRestore,
    handleDeletePermanently,
    handleExport,
  };
}
