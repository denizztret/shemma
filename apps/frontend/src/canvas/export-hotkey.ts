import { getActiveBinding } from "../settings/shortcuts/config";
import { matchShortcut } from "../settings/shortcuts/match";

/** Factory for the export hotkey handler (default ⌘⇧E / Ctrl+Shift+E). */
export function makeExportHotkeyHandler(
  getSelectedIds: () => string[],
  onExport: (ids: string[]) => void,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    // Shortcut registry: read the active binding at event time.
    if (!matchShortcut(getActiveBinding("export-miro"), e)) return;
    e.preventDefault();
    onExport(getSelectedIds());
  };
}
