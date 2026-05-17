import {
  DefaultToolbar,
  DefaultToolbarContent,
  type TLComponents,
} from "tldraw";
import { tokens } from "../design-tokens";
import { GalleryLink } from "./GalleryLink";
import { RoomBadge } from "./RoomBadge";

/**
 * Build the `components` prop for `<Tldraw />`.
 *
 * - `SharePanel` injects our chrome (Gallery link + Room badge).
 * - `Toolbar` wraps the default tldraw toolbar and appends a "Mermaid"
 *   button that invokes the provided callback (used by App.tsx to open the
 *   MermaidImportModal). Hotkey ⌘M остаётся primary trigger; кнопка —
 *   discoverability.
 */
export function buildTldrawComponents(
  room: string,
  opts: { onMermaidImport?: () => void } = {},
): TLComponents {
  const { onMermaidImport } = opts;
  return {
    SharePanel: () => (
      // tlui-layout has pointer-events:none; restore it here so the link is clickable.
      // className mirrors tldraw's own .tlui-share-zone for correct layout/z-index.
      <div
        className="tlui-share-zone"
        style={{ pointerEvents: "all", zIndex: 300 }}
      >
        <GalleryLink />
        <RoomBadge room={room} />
      </div>
    ),
    Toolbar: () => (
      <DefaultToolbar>
        <DefaultToolbarContent />
        {onMermaidImport ? (
          <button
            type="button"
            onClick={onMermaidImport}
            title="Import Mermaid (⌘M)"
            aria-label="Import Mermaid"
            // Inline-styled mini-button: визуально похож на tldraw tool item,
            // но не пытается mimic'ать full TLUiToolItem (тот требует tool
            // registration + icon asset). Минимальный wrap — достаточно для
            // discoverability hotkey'я.
            style={{
              marginLeft: 4,
              padding: "0 10px",
              height: 32,
              minWidth: 36,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: tokens.font.mono,
              fontSize: tokens.font.base,
              fontWeight: 600,
              color: tokens.color.text,
              background: "transparent",
              border: "none",
              borderRadius: tokens.radius.sm,
              cursor: "pointer",
            }}
          >
            M
          </button>
        ) : null}
      </DefaultToolbar>
    ),
  };
}
