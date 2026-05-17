import { useEffect, useRef, useState } from "react";
import { tokens } from "../design-tokens";

/**
 * Full-overlay modal for pasting Mermaid source and importing it as tldraw
 * shapes. Submission is delegated via onSubmit; on success modal closes,
 * on failure error message is shown inline and modal stays open so the user
 * can correct the source.
 *
 * Hotkeys внутри:
 *   - Esc          → Cancel
 *   - Cmd/Ctrl+Enter → Render
 *
 * stopPropagation на key events чтобы tldraw editor не получал глобальные
 * shortcuts (delete и т.п.) во время typing.
 */
export function MermaidImportModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  /** Returns { ok, error } — на ошибке modal остаётся открытым. */
  onSubmit: (source: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus textarea when modal opens; reset state when it closes.
  useEffect(() => {
    if (visible) {
      // setTimeout helps when modal opens via hotkey — focus после layout.
      const t = setTimeout(() => textareaRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    // Closed → reset for next open.
    setText("");
    setError(null);
    setLoading(false);
    return;
  }, [visible]);

  if (!visible) return null;

  const cancel = () => {
    if (loading) return;
    onClose();
  };

  const submit = async () => {
    if (loading) return;
    const source = text.trim();
    if (!source) {
      setError("Empty input");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await onSubmit(source);
      if (res.ok) {
        onClose();
      } else {
        setError(res.error ?? "Import failed");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click closes; Esc inside textarea handles keyboard
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is purely visual click-target; primary interaction via textarea + buttons
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Import Mermaid diagram"
      onClick={(e) => {
        // Click on backdrop (not inner card) → cancel.
        if (e.target === e.currentTarget) cancel();
      }}
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        zIndex: tokens.z.modal,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          background: tokens.color.bgOverlay,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: 16,
          minWidth: 480,
          maxWidth: "80vw",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          fontFamily: tokens.font.sans,
          fontSize: tokens.font.base,
          color: tokens.color.text,
          boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
        }}
      >
        <div style={{ fontWeight: 600 }}>Import Mermaid</div>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste Mermaid here…"
          disabled={loading}
          rows={10}
          style={{
            minWidth: 400,
            minHeight: 200,
            padding: 8,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            fontFamily: tokens.font.mono,
            fontSize: tokens.font.base,
            resize: "vertical",
            outline: "none",
          }}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter → submit
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
            // Stop propagation: prevents tldraw editor shortcuts (delete и т.п.)
            // во время typing внутри modal. Esc обрабатываем выше — глобальный
            // window listener не сработает.
            e.stopPropagation();
          }}
        />
        {error ? (
          <div
            role="alert"
            style={{
              color: tokens.color.errorBg,
              fontSize: tokens.font.sm,
              whiteSpace: "pre-wrap",
            }}
          >
            {error}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={cancel}
            disabled={loading}
            style={{
              padding: "6px 14px",
              fontSize: tokens.font.base,
              fontFamily: tokens.font.sans,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              background: "white",
              cursor: loading ? "default" : "pointer",
              opacity: loading ? 0.5 : 1,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={loading}
            style={{
              padding: "6px 14px",
              fontSize: tokens.font.base,
              fontFamily: tokens.font.sans,
              border: `1px solid ${tokens.color.accent}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.accent,
              color: "white",
              cursor: loading ? "default" : "pointer",
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? "Rendering…" : "Render"}
          </button>
        </div>
      </div>
    </div>
  );
}
