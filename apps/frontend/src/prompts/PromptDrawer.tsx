import { useEffect, useState } from "react";
import { tokens } from "../design-tokens";
import { deletePrompt, fetchPrompts, purgePrompts } from "../transport/prompts";

type PromptItem = {
  id: string;
  text: string;
  status: "pending" | "resolved" | "dismissed";
  selection: string[];
  response?: string;
};

export function PromptDrawer({
  space,
  room,
  tick,
}: {
  space: string;
  room: string;
  tick: number;
}) {
  const [items, setItems] = useState<PromptItem[]>([]);
  const [open, setOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is a prop, used as refresh signal
  useEffect(() => {
    fetchPrompts(space, room, "all").then((r) =>
      setItems((r.prompts as PromptItem[]) ?? []),
    );
  }, [tick, space, room]);
  const pending = items.filter((p) => p.status === "pending").length;
  const oldCount = items.length - pending;

  const onDelete = async (id: string) => {
    setItems((xs) => xs.filter((p) => p.id !== id));
    await deletePrompt(space, room, id);
  };
  const onPurge = async () => {
    if (oldCount === 0) return;
    if (!confirm(`Удалить ${oldCount} старых prompt(s)?`)) return;
    setItems((xs) => xs.filter((p) => p.status === "pending"));
    await purgePrompts(space, room);
  };

  return (
    <div
      style={{
        position: "absolute",
        // DRW-191: переехали с bottom-left (`left:8; top:30%`) на top
        // сразу после chrome menu zone (Menu/Page/Undo/Redo/Delete/Copy/More).
        // zIndex > 300 (SharePanel zone), иначе перекрывается Gallery.
        // DRW-206: left 320 → 356 — кнопка настроек ⚙ встала перед 💬.
        // DRW-217: 356 → 392 — между ⚙ и 💬 добавилась кнопка темы 🌓.
        top: 4,
        left: 392,
        zIndex: 301,
        pointerEvents: "auto",
        fontFamily: tokens.font.sans,
        fontSize: tokens.font.sm,
      }}
    >
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            background: tokens.color.bgOverlay,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            padding: "4px 8px",
            cursor: "pointer",
            fontSize: tokens.font.sm,
          }}
        >
          💬 {pending}
        </button>
      )}
      {open && (
        <div
          style={{
            width: 280,
            maxHeight: "50vh",
            overflow: "auto",
            background: tokens.color.bgOverlay,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            padding: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
              gap: 6,
            }}
          >
            <span style={{ fontWeight: "bold" }}>Prompts ({items.length})</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {oldCount > 0 && (
                <button
                  type="button"
                  onClick={onPurge}
                  title={`Удалить ${oldCount} старых (resolved + dismissed)`}
                  style={{
                    border: `1px solid ${tokens.color.border}`,
                    background: "white",
                    borderRadius: tokens.radius.sm,
                    padding: "2px 6px",
                    cursor: "pointer",
                    fontSize: tokens.font.sm,
                    color: tokens.color.textMuted,
                  }}
                >
                  🗑 {oldCount}
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: tokens.font.base,
                }}
              >
                ×
              </button>
            </div>
          </div>
          {items.length === 0 && (
            <div style={{ color: tokens.color.textMuted }}>(empty)</div>
          )}
          {items.map((p) => (
            <div
              key={p.id}
              style={{
                marginBottom: 8,
                opacity: p.status !== "pending" ? 0.5 : 1,
                position: "relative",
                paddingRight: 18,
              }}
            >
              <button
                type="button"
                onClick={() => onDelete(p.id)}
                title="Удалить prompt"
                style={{
                  position: "absolute",
                  top: 0,
                  right: 0,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  color: tokens.color.textMuted,
                  fontSize: tokens.font.base,
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                ×
              </button>
              <div
                style={{
                  color: tokens.color.textMuted,
                  fontSize: tokens.font.sm,
                }}
              >
                <b>{p.status}</b> · {p.selection.join(", ") || "(no selection)"}
              </div>
              <div>{p.text}</div>
              {p.response && (
                <div
                  style={{
                    marginTop: 4,
                    paddingLeft: 8,
                    borderLeft: `2px solid ${tokens.color.accent}`,
                    color: tokens.color.text,
                  }}
                >
                  {p.response}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
