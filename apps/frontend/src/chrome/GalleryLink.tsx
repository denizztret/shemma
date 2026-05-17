import { tokens } from "../design-tokens";

/**
 * "← Gallery" link rendered inside the tldraw SharePanel (top-right).
 * Navigates back to the Rooms Gallery (/?view=gallery).
 * Positioned next to RoomBadge inside TldrawComponents.buildTldrawComponents.
 */
export function GalleryLink() {
  return (
    <a
      href="/?view=gallery"
      style={{
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
      }}
    >
      ← Gallery
    </a>
  );
}
