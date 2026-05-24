// DRW-088: tidy-layout helper + hotkey factory.
//
// tidyLayout — вызывает POST /api/agent/layout-selection для subset shapes.
// makeTidyHotkeyHandler — фабрика KeyboardEvent-хэндлера для ⌘⇧L / Ctrl+Shift+L.

export type TidyLayoutResult =
  | { kind: "noop"; reason: string }
  | { kind: "ok"; count: number; affected: string[]; version?: number }
  | { kind: "error"; message: string };

/**
 * Call backend layout-selection endpoint for the given shape ids.
 *
 * Returns noop immediately only for empty ids (no round-trip needed).
 * Single-id selection is forwarded to the backend — backend handles
 * container expansion (DRW-149: auto-layout in frame).
 *
 * DRW-116 Task 15: accepts `space` so multi-space gallery can address the
 * correct per-space bundle. Legacy callers pass `LEGACY_SPACE_ID` (the
 * backend ignores it when the space middleware is off).
 */
export async function tidyLayout(
  ids: string[],
  space: string,
  room: string,
): Promise<TidyLayoutResult> {
  if (ids.length === 0) {
    return {
      kind: "noop",
      reason: "no shapes selected — select shapes first",
    };
  }

  try {
    const res = await fetch(
      `/api/agent/layout-selection?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      },
    );

    const json = (await res.json()) as {
      ok?: boolean;
      count?: number;
      affected?: string[];
      version?: number;
      hint?: string;
      error?: string;
    };

    if (json.ok) {
      return {
        kind: "ok",
        count: json.count ?? 0,
        affected: json.affected ?? [],
        version: json.version,
      };
    }

    return { kind: "error", message: json.error ?? "layout-selection failed" };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Factory for ⌘⇧L / Ctrl+Shift+L keyboard handler.
 *
 * @param getSelectedIds  — returns current selected shape ids (from editor)
 * @param onTidy          — called with ids when hotkey fires; caller initiates layout
 *
 * Usage:
 *   const handler = makeTidyHotkeyHandler(
 *     () => editor.getSelectedShapeIds() as unknown as string[],
 *     (ids) => void tidyLayout(ids, space, room),
 *   );
 *   window.addEventListener("keydown", handler);
 */
export function makeTidyHotkeyHandler(
  getSelectedIds: () => string[],
  onTidy: (ids: string[]) => void,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    // ⌘⇧L on Mac, Ctrl+Shift+L on Linux/Windows
    const isModifier = e.metaKey || e.ctrlKey;
    if (!isModifier || !e.shiftKey || e.key.toLowerCase() !== "l") return;
    e.preventDefault();
    const ids = getSelectedIds();
    onTidy(ids);
  };
}
