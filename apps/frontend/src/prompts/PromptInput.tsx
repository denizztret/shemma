import { useState } from "react";
import type { Editor } from "tldraw";
import { tokens } from "../design-tokens";
import { postPrompt } from "../transport/prompts";

export function PromptInput({
  editor,
  selection,
  cameraTick: _cameraTick,
}: {
  editor: Editor | null;
  selection: string[];
  /** Bumped on every viewport change so anchor re-computes on pan/zoom. */
  cameraTick: number;
}) {
  const [text, setText] = useState("");
  if (!editor || selection.length === 0) return null;

  const bounds = editor.getSelectionPageBounds();
  if (!bounds) return null;
  const anchorPage = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h + 8 };
  const screen = editor.pageToScreen(anchorPage);

  const send = async () => {
    if (!text.trim()) return;
    await postPrompt(selection, text);
    setText("");
  };

  return (
    <div
      style={{
        position: "absolute",
        left: screen.x,
        top: screen.y,
        transform: "translate(-50%, 0)",
        zIndex: tokens.z.overlay,
        background: tokens.color.bgOverlay,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        padding: 6,
        display: "flex",
        gap: 6,
        fontFamily: tokens.font.sans,
        fontSize: tokens.font.base,
        pointerEvents: "auto",
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Ask AI about ${selection.length} selected…`}
        style={{
          minWidth: 280,
          padding: "4px 6px",
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          fontSize: tokens.font.base,
          fontFamily: tokens.font.sans,
          outline: "none",
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void send();
        }}
      />
      <button
        type="button"
        onClick={() => void send()}
        style={{
          padding: "4px 10px",
          fontSize: tokens.font.sm,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          background: "white",
          cursor: "pointer",
        }}
      >
        Send
      </button>
    </div>
  );
}
