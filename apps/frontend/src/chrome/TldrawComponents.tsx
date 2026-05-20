import {
  DefaultContextMenu,
  DefaultContextMenuContent,
  DefaultToolbar,
  DefaultToolbarContent,
  type TLComponents,
  useEditor,
  useValue,
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
 * - `ContextMenu` (DRW-088) extends default context menu with "Tidy" item
 *   when 2+ shapes are selected. Hotkey ⌘⇧L остаётся primary trigger;
 *   пункт меню — discoverability для пользователей.
 */
export function buildTldrawComponents(
  room: string,
  opts: {
    onMermaidImport?: () => void;
    /** DRW-088: called with selected shape ids when user chooses "Tidy" */
    onTidySelection?: (ids: string[]) => void;
    /** DRW-103: called with selected shape ids when user chooses "Export to Miro" */
    onExportSelection?: (ids: string[]) => void;
  } = {},
): TLComponents {
  const { onMermaidImport, onTidySelection, onExportSelection } = opts;

  // DRW-088 AC#1: ContextMenu wrapper — extends DefaultContextMenu with "Tidy"
  // group when 2+ shapes are selected. We wrap DefaultContextMenu with custom
  // children content (DefaultContextMenu accepts children to override its inner
  // content while keeping the Radix context-menu shell + canvas rendering).
  function TidyContextMenu() {
    const editor = useEditor();
    const selectedCount = useValue(
      "selectedCount",
      () => editor.getSelectedShapeIds().length,
      [editor],
    );

    return (
      <DefaultContextMenu>
        <DefaultContextMenuContent />
        {selectedCount >= 2 && onTidySelection && (
          // DRW-088: "Tidy" item using plain tlui CSS classes.
          // Avoids TldrawUiMenuGroup/TldrawUiMenuItem which have bigint in return
          // type union (TypeScript ReactNode incompatibility in strict mode).
          <div className="tlui-menu__group">
            <button
              type="button"
              className="tlui-button tlui-button__menu"
              onPointerDown={(e) => {
                // Prevent context menu close from stealing the click before onPointerUp fires
                e.stopPropagation();
              }}
              onClick={() => {
                const ids = editor.getSelectedShapeIds() as unknown as string[];
                onTidySelection(ids);
              }}
            >
              <span className="tlui-button__label">Tidy selection</span>
              <kbd className="tlui-kbd">⌘⇧L</kbd>
            </button>
          </div>
        )}
        {selectedCount >= 1 && onExportSelection && (
          // DRW-103: "Export to Miro" item — visible when 1+ shapes selected.
          <div className="tlui-menu__group">
            <button
              type="button"
              className="tlui-button tlui-button__menu"
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
              onClick={() => {
                const ids = editor.getSelectedShapeIds() as unknown as string[];
                onExportSelection(ids);
              }}
            >
              <span className="tlui-button__label">Export to Miro</span>
              <kbd className="tlui-kbd">⌘⇧E</kbd>
            </button>
          </div>
        )}
      </DefaultContextMenu>
    );
  }

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
    // DRW-088/DRW-103: custom context menu — "Tidy" (2+ shapes) + "Export to Miro" (1+ shapes).
    // TidyContextMenu wraps DefaultContextMenu with custom children content.
    ContextMenu: (onTidySelection || onExportSelection) ? TidyContextMenu : undefined,
  };
}
