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
 * Returns noop if fewer than 2 ids provided (consistent with AC#9/AC#10 —
 * backend will also return noop, but we short-circuit here to avoid the round-trip).
 */
export async function tidyLayout(
  ids: string[],
  room: string,
): Promise<TidyLayoutResult> {
  if (ids.length < 2) {
    return {
      kind: "noop",
      reason:
        ids.length === 0
          ? "no shapes selected — select shapes first"
          : "need 2+ shapes to tidy",
    };
  }

  try {
    const res = await fetch(
      `/api/agent/layout-selection?room=${encodeURIComponent(room)}`,
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
 *     (ids) => void tidyLayout(ids, room),
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
