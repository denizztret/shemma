/** Factory for the ⌘⇧E / Ctrl+Shift+E export hotkey handler. */
export function makeExportHotkeyHandler(
  getSelectedIds: () => string[],
  onExport: (ids: string[]) => void,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    const isModifier = e.metaKey || e.ctrlKey;
    if (!isModifier || !e.shiftKey || e.key.toLowerCase() !== "e") return;
    e.preventDefault();
    onExport(getSelectedIds());
  };
}
