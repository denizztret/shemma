import { tokens } from "../design-tokens";

const linkStyle: React.CSSProperties = {
  // Rendered inside tldraw SharePanel — no absolute positioning here.
  display: "inline-flex",
  alignItems: "center",
  padding: "4px 8px",
  fontFamily: tokens.font.mono,
  fontSize: tokens.font.sm,
  color: tokens.color.textMuted,
  background: tokens.color.bgOverlay,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  textDecoration: "none",
  whiteSpace: "nowrap",
  cursor: "pointer",
};

/**
 * "← Gallery" affordance rendered inside the tldraw SharePanel (top-right).
 *
 * Two modes:
 *   • When `onBack` is provided — render a `<button>` that fires the callback.
 *     Used by MultiColumnLayout (DRW-116 Task 18) to swap the column from
 *     `kind: "room"` back to `kind: "gallery"` without a full-page navigation.
 *   • When `onBack` is `undefined` — render a plain `<a href="/?view=gallery">`
 *     for legacy single-column / single-space flows (Task 14 routing path).
 *
 * Positioned next to RoomBadge inside TldrawComponents.buildTldrawComponents.
 */
export function GalleryLink({ onBack }: { onBack?: () => void } = {}) {
  if (onBack) {
    return (
      <button type="button" onClick={onBack} style={linkStyle}>
        ← Gallery
      </button>
    );
  }
  return (
    <a href="/?view=gallery" style={linkStyle}>
      ← Gallery
    </a>
  );
}
