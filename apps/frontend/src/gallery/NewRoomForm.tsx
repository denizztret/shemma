import { useState } from "react";
import { tokens } from "../design-tokens";
import { roomHref } from "../transport/api";
import { validateRoomId } from "./validate";

export function NewRoomForm({ space }: { space: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleOpen() {
    setOpen(true);
    setError(null);
  }

  function handleCancel() {
    setOpen(false);
    setValue("");
    setError(null);
  }

  function handleCreate() {
    const trimmed = value.trim();
    if (!validateRoomId(trimmed)) {
      setError(
        "Room ID must be 1–64 characters: letters, numbers, _ or -",
      );
      return;
    }
    location.assign(roomHref(space, trimmed));
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleCreate();
    else if (e.key === "Escape") handleCancel();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        style={{
          fontFamily: tokens.font.sans,
          fontSize: tokens.font.base,
          color: "#fff",
          background: tokens.color.accent,
          border: "none",
          borderRadius: tokens.radius.md,
          padding: "8px 18px",
          cursor: "pointer",
          fontWeight: 600,
        }}
      >
        + New room
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          // biome-ignore lint/a11y/noAutofocus: intentional UX - user clicked New room
          autoFocus
          type="text"
          placeholder="room-id"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={handleKeyDown}
          style={{
            fontFamily: tokens.font.mono,
            fontSize: tokens.font.base,
            padding: "6px 10px",
            border: `1px solid ${error ? tokens.color.warnBorder : tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            background: tokens.color.bg,
            color: tokens.color.text,
            width: 220,
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={handleCreate}
          style={{
            fontFamily: tokens.font.sans,
            fontSize: tokens.font.base,
            color: "#fff",
            background: tokens.color.accent,
            border: "none",
            borderRadius: tokens.radius.md,
            padding: "6px 14px",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Create
        </button>
        <button
          type="button"
          onClick={handleCancel}
          style={{
            fontFamily: tokens.font.sans,
            fontSize: tokens.font.base,
            color: tokens.color.textMuted,
            background: tokens.color.bgOverlay,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            padding: "6px 12px",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
      {error && (
        <span
          style={{
            fontFamily: tokens.font.sans,
            fontSize: tokens.font.sm,
            color: tokens.color.warnText,
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
