// DRW-088: tidy-layout helper + hotkey factory.
//
// tidyLayout — вызывает POST /api/agent/layout-selection для subset shapes.
// makeTidyHotkeyHandler — фабрика KeyboardEvent-хэндлера для ⌘⇧L / Ctrl+Shift+L.

import type { Editor, TLShapeId } from "tldraw";
import { getActiveBinding } from "../settings/shortcuts/config";
import { matchShortcut } from "../settings/shortcuts/match";

export type TidyLayoutResult =
  | { kind: "noop"; reason: string }
  | { kind: "ok"; count: number; affected: string[]; version?: number }
  | { kind: "error"; message: string };

export type LayoutScope = "self" | "auto";

/**
 * Frame-container heuristic: determines layout scope based on selection shape.
 *
 * | Selection                 | Scope    |
 * |---------------------------|----------|
 * | Single leaf               | "auto"   |
 * | Single container OR frame | "self"   |
 * | Multi (anything)          | "auto"   |
 *
 * Корневой fix для бага "parent frame схлопывается при Tidy одного контейнера":
 * frontend не передавал scope → backend defaults к "auto" → frame becomes anchor
 * → Pass B resize. Heuristic возвращает "self" для single container/frame чтобы
 * backend пропускал Pass B и parent frame оставался intact.
 *
 * Spec: 2026-05-27-frame-container-direction-layout-design.md §5.2.
 */
export function scopeFor(ids: string[], editor: Editor): LayoutScope {
  if (ids.length !== 1) return "auto";
  const s = editor.getShape(ids[0] as TLShapeId);
  if (!s) return "auto";
  return s.type === "frame" || s.type === "schema-container" ? "self" : "auto";
}

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
 *
 * Frame-container fix (spec 5.2): `scope` parameter. Default "auto" preserves
 * existing behavior (multi-selection, leafs). Callers should pass `scopeFor(ids,
 * editor)` to apply the heuristic.
 */
export async function tidyLayout(
  ids: string[],
  space: string,
  room: string,
  scope: LayoutScope = "auto",
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
        body: JSON.stringify({ ids, scope }),
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
 * @param editor          — required для scopeFor heuristic (single container/frame → "self")
 * @param onTidy          — called with (ids, scope) when hotkey fires
 *
 * Usage:
 *   const handler = makeTidyHotkeyHandler(
 *     () => editor.getSelectedShapeIds() as unknown as string[],
 *     editor,
 *     (ids, scope) => void tidyLayout(ids, space, room, scope),
 *   );
 *   window.addEventListener("keydown", handler);
 */
export function makeTidyHotkeyHandler(
  getSelectedIds: () => string[],
  editor: Editor,
  onTidy: (ids: string[], scope: LayoutScope) => void,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    // Shortcut registry: read the active binding at event time so user remaps
    // take effect without re-registering the listener.
    if (!matchShortcut(getActiveBinding("tidy-layout"), e)) return;
    e.preventDefault();
    const ids = getSelectedIds();
    const scope = scopeFor(ids, editor);
    onTidy(ids, scope);
  };
}

/**
 * makeForceReLayoutHotkeyHandler — ⌘⌥⇧L / Ctrl+Alt+Shift+L. POST the same
 * /api/agent/layout-selection endpoint with `forceUnpin: true` so the layout
 * pass ignores meta.pinned / meta.didrawSizePinned for this one call (the
 * flags themselves stay on the shapes).
 *
 * Frame-container fix (spec 5.2): передаёт scope из scopeFor(ids, editor).
 */
export function makeForceReLayoutHotkeyHandler(
  getSelectedIds: () => string[],
  editor: Editor,
  onForce: (ids: string[], scope: LayoutScope) => void,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    // Shortcut registry: read the active binding at event time.
    if (!matchShortcut(getActiveBinding("force-relayout"), e)) return;
    e.preventDefault();
    e.stopPropagation();
    const ids = getSelectedIds();
    const scope = scopeFor(ids, editor);
    onForce(ids, scope);
  };
}
