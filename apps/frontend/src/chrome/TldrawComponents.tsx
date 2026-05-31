import { useEffect, useState } from "react";
import {
  DefaultContextMenu,
  DefaultContextMenuContent,
  DefaultToolbar,
  DefaultToolbarContent,
  type TLComponents,
  TldrawUiMenuToolItem,
  useEditor,
  useToasts,
  useValue,
} from "tldraw";
import { SettingsPopover } from "../settings/SettingsPopover";
import { getActiveBinding } from "../settings/shortcuts/config";
import { formatBinding } from "../settings/shortcuts/match";
import type { SchemaContainerDirection } from "../shapes/schema-container/SchemaContainerShape";
import { GalleryLink } from "./GalleryLink";
import { RoomBadge } from "./RoomBadge";

/**
 * Renders a 🔒 badge at the top-right corner of every locked frame
 * (`meta.didrawLocked`) so the lock state is visible on the canvas, not just in
 * the panel. Screen-space overlay; recomputes on camera / shape changes.
 */
function LockBadges() {
  const editor = useEditor();
  const badges = useValue(
    "lockBadges",
    () => {
      const out: Array<{ id: string; x: number; y: number }> = [];
      for (const s of editor.getCurrentPageShapes()) {
        if (s.type !== "frame" || s.meta?.didrawLocked !== true) continue;
        const b = editor.getShapePageBounds(s.id);
        if (!b) continue;
        const tr = editor.pageToScreen({ x: b.x + b.w, y: b.y });
        out.push({ id: s.id, x: tr.x, y: tr.y });
      }
      return out;
    },
    [editor],
  );
  return (
    <>
      {badges.map((b) => (
        <div
          key={b.id}
          title="Фрейм заблокирован — авто-раскладка его не трогает"
          style={{
            position: "absolute",
            left: b.x - 30,
            top: b.y + 6,
            pointerEvents: "none",
            fontSize: 18,
            lineHeight: 1,
            userSelect: "none",
          }}
        >
          🔒
        </div>
      ))}
    </>
  );
}

export type ToastSeverity = "info" | "success" | "warning" | "error";
/** Shared sink for showing tldraw toasts from outside the UI context. */
export type ToastSink = {
  current: ((msg: string, severity?: ToastSeverity) => void) | null;
};

/**
 * DL: мост к tldraw-тостам. Рендерится внутри Tldraw UI-контекста (где доступен
 * `useToasts`), кладёт вызывалку в общий `sink`, чтобы места ВНЕ контекста
 * (hydrate-ретрай deep-link, ⌘⌥C-обработчик в App) могли показать тост.
 * Сам ничего не рисует.
 */
function ToastBridge({ sink }: { sink: ToastSink }) {
  const { addToast } = useToasts();
  useEffect(() => {
    sink.current = (msg: string, severity: ToastSeverity = "info") => {
      addToast({ title: msg, severity });
    };
    return () => {
      sink.current = null;
    };
  }, [addToast, sink]);
  return null;
}

/**
 * Build the `components` prop for `<Tldraw />`.
 *
 * - `SharePanel` injects our chrome (Gallery link + Room badge).
 * - `Toolbar` — pass-through to default tldraw toolbar. DRW-186 Task 6:
 *   inline "M" Mermaid button удалён; Mermaid + SchemaContainer теперь
 *   зарегистрированы как нативные tool item'ы через `TLUiOverrides.tools`
 *   (см. `apps/frontend/src/ui-overrides.ts`) и автоматически попадают в
 *   overflow popover.
 * - `ContextMenu` extends default context menu with "Tidy" + "Export to Miro"
 *   items when selection is non-empty. Hotkeys remain primary triggers.
 */
export function buildTldrawComponents(
  space: string,
  room: string,
  opts: {
    onTidySelection?: (ids: string[]) => void;
    onExportSelection?: (ids: string[]) => void;
    onSetContainerDirection?: (direction: SchemaContainerDirection) => void;
    onCopyObjectLink?: (ids: string[]) => void;
    toastSink?: ToastSink;
  } = {},
): TLComponents {
  const {
    onTidySelection,
    onExportSelection,
    onSetContainerDirection,
    onCopyObjectLink,
    toastSink,
  } = opts;

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
        editor.getSelectedShapes().some((s) => s.type === "schema-container"),
      [editor],
    );

    return (
      <DefaultContextMenu>
        <DefaultContextMenuContent />
        {selectedCount >= 1 && onCopyObjectLink && (
          <div className="tlui-menu__group">
            <button
              type="button"
              className="tlui-button tlui-button__menu"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                const ids = editor.getSelectedShapeIds() as unknown as string[];
                onCopyObjectLink(ids);
                // Plain buttons don't auto-close the Radix context menu; Escape
                // is consumed by Radix (closes the menu, selection preserved).
                document.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    key: "Escape",
                    code: "Escape",
                    bubbles: true,
                  }),
                );
              }}
            >
              <span className="tlui-button__label">Copy link</span>
              <kbd className="tlui-kbd">
                {formatBinding(getActiveBinding("copy-link"))}
              </kbd>
            </button>
          </div>
        )}
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
              <kbd className="tlui-kbd">
                {formatBinding(getActiveBinding("tidy-layout"))}
              </kbd>
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
              <kbd className="tlui-kbd">
                {formatBinding(getActiveBinding("export-miro"))}
              </kbd>
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
              <span
                style={{ marginLeft: "auto", opacity: 0.6, fontSize: "0.75em" }}
              >
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
        <RoomBadge room={room} space={space} />
      </div>
    ),
    Toolbar: () => (
      <DefaultToolbar>
        <DefaultToolbarContent />
        {/* DRW-186: custom tools зарегистрированы через TLUiOverrides.tools
         * (см. apps/frontend/src/ui-overrides.ts). Render-side нужен явный
         * TldrawUiMenuToolItem — DefaultToolbarContent рендерит fixed list
         * нативных tools и кастомные ID не подхватывает автоматически.
         * OverflowingToolbar сам переместит их в "More" popover при нехватке места. */}
        <TldrawUiMenuToolItem toolId="schema-container" />
        <TldrawUiMenuToolItem toolId="mermaid-import" />
      </DefaultToolbar>
    ),
    InFrontOfTheCanvas: () => (
      <>
        <LockBadges />
        {toastSink && <ToastBridge sink={toastSink} />}
        <SettingsPopover space={space} room={room} />
      </>
    ),
    ContextMenu:
      onTidySelection ||
      onExportSelection ||
      onSetContainerDirection ||
      onCopyObjectLink
        ? TidyContextMenu
        : undefined,
  };
}
