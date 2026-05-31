import { tokens } from "../design-tokens";
import { LEGACY_SPACE_ID } from "../transport/api";
import { spaceUrl } from "../spaces/url-parser";

const linkStyle: React.CSSProperties = {
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
 * Navigates to the gallery of the room's space: `/?space=<id>` (or legacy
 * `/?view=gallery` for the synthetic LEGACY_SPACE_ID).
 */
export function GalleryLink({ space }: { space: string }) {
  const href = space === LEGACY_SPACE_ID ? "/?view=gallery" : spaceUrl(space);
  return (
    <a
      href={href}
      style={linkStyle}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = tokens.color.hoverOverlay;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = tokens.color.bgOverlay;
      }}
    >
      ← Gallery
    </a>
  );
}
