// apps/frontend/src/canvas/export-hotkey.ts
//
// DRW-103: ⌘⇧E / Ctrl+Shift+E — Export selection to Miro.
// Pattern mirrors makeTidyHotkeyHandler (DRW-088).

/**
 * Factory for ⌘⇧E / Ctrl+Shift+E keyboard handler.
 *
 * @param getSelectedIds  — returns current selected shape ids (from editor)
 * @param onExport        — called with ids when hotkey fires; caller opens the export modal
 *
 * Usage:
 *   const handler = makeExportHotkeyHandler(
 *     () => editor.getSelectedShapeIds() as unknown as string[],
 *     (ids) => { if (ids.length > 0) setExportOpen(true); },
 *   );
 *   window.addEventListener("keydown", handler);
 */
export function makeExportHotkeyHandler(
  getSelectedIds: () => string[],
  onExport: (ids: string[]) => void,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    // ⌘⇧E on Mac, Ctrl+Shift+E on Linux/Windows
    const isModifier = e.metaKey || e.ctrlKey;
    if (!isModifier || !e.shiftKey || e.key.toLowerCase() !== "e") return;
    e.preventDefault();
    onExport(getSelectedIds());
  };
}
