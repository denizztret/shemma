import { useState } from "react";
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
import type { SchemaContainerDirection } from "../shapes/schema-container/SchemaContainerShape";
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
 * - `ContextMenu` extends default context menu with "Tidy" + "Export to Miro"
 *   items when selection is non-empty. Hotkeys remain primary triggers.
 */
export function buildTldrawComponents(
  space: string,
  room: string,
  opts: {
    onMermaidImport?: () => void;
    onTidySelection?: (ids: string[]) => void;
    onExportSelection?: (ids: string[]) => void;
    onSetContainerDirection?: (direction: SchemaContainerDirection) => void;
  } = {},
): TLComponents {
  const { onMermaidImport, onTidySelection, onExportSelection, onSetContainerDirection } = opts;

  // We wrap DefaultContextMenu and append items as children — DefaultContextMenu
  // overrides its inner content while keeping the Radix shell + canvas rendering.
  function TidyContextMenu() {
    const editor = useEditor();
    const [directionSubmenuOpen, setDirectionSubmenuOpen] = useState(false);
    const selectedCount = useValue(
      "selectedCount",
      () => editor.getSelectedShapeIds().length,
      [editor],
    );
    const hasContainer = useValue(
      "hasContainer",
      () =>
        editor
          .getSelectedShapes()
          .some((s) => s.type === "schema-container"),
      [editor],
    );

    return (
      <DefaultContextMenu>
        <DefaultContextMenuContent />
        {selectedCount >= 2 && onTidySelection && (
          // Plain tlui CSS classes — avoids TldrawUiMenuGroup/TldrawUiMenuItem
          // which have bigint in return type union (ReactNode incompatibility in strict mode).
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
        {/* DRW-166: Direction submenu — visible only when a schema-container is selected */}
        {hasContainer && onSetContainerDirection && (
          <div className="tlui-menu__group">
            {/* Submenu trigger */}
            <button
              type="button"
              className="tlui-button tlui-button__menu tlui-menu__submenu__trigger"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setDirectionSubmenuOpen((v) => !v)}
            >
              <span className="tlui-button__label">Direction</span>
              <span style={{ marginLeft: "auto", opacity: 0.6, fontSize: "0.75em" }}>
                {directionSubmenuOpen ? "▼" : "▶"}
              </span>
            </button>
            {/* Inline submenu items — rendered in-place when open */}
            {directionSubmenuOpen && (
              <div
                style={{ paddingLeft: 12 }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {(
                  [
                    ["TB", "Top → Bottom"],
                    ["LR", "Left → Right"],
                    ["BT", "Bottom → Top"],
                    ["RL", "Right → Left"],
                    ["custom", "Custom (manual)"],
                  ] as [SchemaContainerDirection, string][]
                ).map(([dir, label]) => (
                  <button
                    key={dir}
                    type="button"
                    className="tlui-button tlui-button__menu"
                    onClick={() => {
                      onSetContainerDirection(dir);
                      setDirectionSubmenuOpen(false);
                    }}
                  >
                    <span className="tlui-button__label">{label}</span>
                  </button>
                ))}
              </div>
            )}
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
        style={{
          pointerEvents: "all",
          zIndex: 300,
          display: "inline-flex",
          gap: 6,
        }}
      >
        <GalleryLink space={space} />
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
    ContextMenu: (onTidySelection || onExportSelection || onSetContainerDirection) ? TidyContextMenu : undefined,
  };
}
