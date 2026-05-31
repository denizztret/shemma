import { useEffect, useRef, useState } from "react";
import { tokens } from "../design-tokens";
import { type RoomTag, type RoomTagColor, setRoomTags } from "../transport/api";
import { TagChip } from "./TagChip";
import { TAG_COLOR_ORDER, TAG_COLORS } from "./tag-colors";
import { validateNewTagName } from "./tag-filter";

/**
 * Lightweight inline popover (NOT a full-screen modal) to edit a room's tags.
 * Anchored relative to the trigger. Dismissible via click-outside / Esc.
 * On Apply → setRoomTags(roomId, nextTags, space); on success → onApplied(tags).
 */
export function TagEditor({
  space,
  roomId,
  initialTags,
  onApplied,
  onClose,
}: {
  space: string;
  roomId: string;
  initialTags: RoomTag[];
  onApplied: (tags: RoomTag[]) => void;
  onClose: () => void;
}) {
  const [tags, setTags] = useState<RoomTag[]>(initialTags);
  const [name, setName] = useState("");
  const [color, setColor] = useState<RoomTagColor>("blue");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const validationError = validateNewTagName(name, tags);
  const canAdd = validationError === null;

  function addTag() {
    if (!canAdd) return;
    setTags((prev) => [...prev, { name: name.trim(), color }]);
    setName("");
    setError(null);
  }

  function removeTag(idx: number) {
    setTags((prev) => prev.filter((_, i) => i !== idx));
  }

  async function apply() {
    setSaving(true);
    setError(null);
    const res = await setRoomTags(roomId, tags, space);
    setSaving(false);
    if (res.ok) {
      onApplied(res.tags);
      onClose();
    } else {
      setError(res.error);
    }
  }

  return (
    <div
      ref={rootRef}
      // RoomListRow wraps the whole row in an onClick that opens the room; the
      // editor lives inside that subtree. Without this guard, clicks on the
      // popover's non-button chrome bubble up and navigate away mid-edit.
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        marginTop: 4,
        zIndex: tokens.z.modal,
        width: 260,
        background: tokens.color.bg,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontFamily: tokens.font.sans,
        textAlign: "left",
      }}
    >
      {/* Current tags */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, minHeight: 22 }}>
        {tags.length === 0 ? (
          <span style={{ fontSize: tokens.font.sm, color: tokens.color.textMuted }}>
            No tags yet
          </span>
        ) : (
          tags.map((t, i) => (
            <TagChip
              key={`${t.name}-${i}`}
              tag={t}
              onRemove={() => removeTag(i)}
            />
          ))
        )}
      </div>

      {/* New tag name */}
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") addTag();
        }}
        placeholder="New tag name"
        maxLength={24}
        // biome-ignore lint/a11y/noAutofocus: popover just opened by user intent
        autoFocus
        style={{
          fontFamily: tokens.font.sans,
          fontSize: tokens.font.base,
          color: tokens.color.text,
          background: tokens.color.bg,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          padding: "4px 8px",
          outline: "none",
        }}
      />

      {/* Colour swatches */}
      <div style={{ display: "flex", gap: 6 }}>
        {TAG_COLOR_ORDER.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => setColor(c)}
            aria-pressed={color === c}
            style={{
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: TAG_COLORS[c].bg,
              border:
                color === c
                  ? `2px solid ${tokens.color.text}`
                  : "2px solid transparent",
              cursor: "pointer",
              padding: 0,
            }}
          />
        ))}
      </div>

      {/* Add */}
      <button
        type="button"
        onClick={addTag}
        disabled={!canAdd}
        style={{
          fontFamily: tokens.font.sans,
          fontSize: tokens.font.sm,
          color: canAdd ? tokens.color.accent : tokens.color.textMuted,
          background: "transparent",
          border: `1px solid ${canAdd ? tokens.color.accent : tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          padding: "4px 8px",
          cursor: canAdd ? "pointer" : "not-allowed",
          alignSelf: "flex-start",
        }}
      >
        + Add tag
      </button>

      {/* Validation / server error */}
      {(name.trim() !== "" && validationError) || error ? (
        <div
          style={{
            fontSize: tokens.font.sm,
            color: tokens.color.errorBg,
          }}
        >
          {error ?? validationError}
        </div>
      ) : null}

      {/* Apply / Cancel */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onClose}
          style={{
            fontFamily: tokens.font.sans,
            fontSize: tokens.font.sm,
            color: tokens.color.textMuted,
            background: "transparent",
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={saving}
          style={{
            fontFamily: tokens.font.sans,
            fontSize: tokens.font.sm,
            color: "#ffffff", // on-accent text
            background: tokens.color.accent,
            border: "none",
            borderRadius: tokens.radius.sm,
            padding: "4px 10px",
            cursor: saving ? "default" : "pointer",
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? "Saving…" : "Apply"}
        </button>
      </div>
    </div>
  );
}
