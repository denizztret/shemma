import { tokens } from "../design-tokens";
import { pushError } from "../state/error-bus";
import { revealSpaceApi } from "../spaces/api";
import { tildify } from "../spaces/format";
import { LEGACY_SPACE_ID } from "../transport/api";

/**
 * Pill-button next to the gallery header brand that shows the current
 * space's path and, on click, asks the daemon to reveal that folder
 * in the OS file manager. Disabled for `LEGACY_SPACE_ID` (synthetic
 * "no real space" sentinel) — there's nothing meaningful to reveal.
 */
export function SpacePathButton({
  space,
  path,
  home,
}: {
  space: string;
  path: string;
  home: string;
}) {
  const isLegacy = space === LEGACY_SPACE_ID;
  const display = tildify(path, home);
  return (
    <button
      type="button"
      onClick={() => {
        if (isLegacy) return;
        void revealSpaceApi(space).catch((e) =>
          pushError(`Reveal failed: ${(e as Error).message}`),
        );
      }}
      disabled={isLegacy}
      title={isLegacy ? path : `Reveal in Finder: ${path}`}
      onMouseEnter={(e) => {
        if (!isLegacy)
          e.currentTarget.style.background = tokens.color.hoverOverlay;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = tokens.color.bgOverlay;
      }}
      style={{
        fontFamily: tokens.font.mono,
        fontSize: tokens.font.sm,
        color: tokens.color.textMuted,
        background: tokens.color.bgOverlay,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        padding: "4px 8px",
        wordBreak: "break-all",
        cursor: isLegacy ? "default" : "pointer",
        textAlign: "left",
      }}
    >
      {display}
    </button>
  );
}

