/**
 * DRW-134 Task 3.2 — Cmd+Shift+K semantic picker: pure logic layer.
 *
 * Testable without DOM / tldraw editor instance.
 * React component in role-picker.tsx consumes these utilities.
 */

import type { Role, ConnectionKind } from "@shemma/domain";
import { getActiveBinding } from "../settings/shortcuts/config";
import { matchShortcut } from "../settings/shortcuts/match";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PickerMode = "role" | "connectionKind" | "mixed" | "none";

export interface MetaPatch {
  /** tldraw shape id (e.g. "shape:abc123") */
  id: string;
  /** meta fields to merge into shape.meta */
  meta: Record<string, unknown>;
}

export interface SelectionInfo {
  /** Whether there are any selected shapes at all. */
  hasSelection: boolean;
  /**
   * Which picker section(s) to show.
   * - "role" — all shapes are non-arrow; show role list.
   * - "connectionKind" — all shapes are arrows; show kind list.
   * - "mixed" — mix of arrows and non-arrows; show both sections.
   * - "none" — no selection.
   */
  mode: PickerMode;
  shapeIds: string[];
  arrowIds: string[];
}

// ---------------------------------------------------------------------------
// Selection classifier
// ---------------------------------------------------------------------------

/**
 * Classify the current tldraw selection into picker mode.
 *
 * `isArrow(id)` — injected predicate so this function has no tldraw import.
 * In App.tsx it is implemented as:
 *   `(id) => editor.getShape(id as TLShapeId)?.type === "arrow"`
 */
export function classifySelection(
  selectedIds: readonly string[],
  isArrow: (id: string) => boolean,
): SelectionInfo {
  if (selectedIds.length === 0) {
    return { hasSelection: false, mode: "none", shapeIds: [], arrowIds: [] };
  }

  const shapeIds: string[] = [];
  const arrowIds: string[] = [];

  for (const id of selectedIds) {
    if (isArrow(id)) {
      arrowIds.push(id);
    } else {
      shapeIds.push(id);
    }
  }

  let mode: PickerMode;
  if (shapeIds.length > 0 && arrowIds.length > 0) {
    mode = "mixed";
  } else if (arrowIds.length > 0) {
    mode = "connectionKind";
  } else {
    mode = "role";
  }

  return { hasSelection: true, mode, shapeIds, arrowIds };
}

// ---------------------------------------------------------------------------
// Patch builder
// ---------------------------------------------------------------------------

/**
 * Build shape meta patches for a role pick.
 * Returns an array of {id, meta} objects; callers apply via editor.updateShapes.
 */
export function buildRolePatches(shapeIds: string[], role: Role): MetaPatch[] {
  return shapeIds.map((id) => ({
    id,
    meta: { didrawRole: role },
  }));
}

/**
 * Build shape meta patches for a connection-kind pick.
 */
export function buildKindPatches(arrowIds: string[], kind: ConnectionKind): MetaPatch[] {
  return arrowIds.map((id) => ({
    id,
    meta: { didrawConnectionKind: kind },
  }));
}

/**
 * Build all meta patches for a picker choice.
 * `choice.type === "role"` → patches shapeIds.
 * `choice.type === "kind"` → patches arrowIds.
 */
export function applyPickerChoice(
  info: SelectionInfo,
  choice: { type: "role"; value: Role } | { type: "kind"; value: ConnectionKind },
): MetaPatch[] {
  if (choice.type === "role") {
    return buildRolePatches(info.shapeIds, choice.value);
  }
  return buildKindPatches(info.arrowIds, choice.value);
}

// ---------------------------------------------------------------------------
// Current-role / current-kind derivation (DRW-136 #2 follow-up)
// ---------------------------------------------------------------------------

/**
 * Derive the "current" role from a list of shape metas.
 *
 * Used by the picker UI to highlight the role already assigned to the selection
 * (so re-opening the picker shows what's currently set instead of always
 * focusing Actor by default).
 *
 * Rule:
 *   - empty list → undefined
 *   - all metas share the same `didrawRole` string → that role
 *   - any meta missing role, or roles differ → undefined (mixed / unset)
 *
 * Pure: takes plain meta objects so the helper has no tldraw import.
 */
export function deriveCurrentRole(
  shapeMetas: Array<Record<string, unknown> | undefined>,
): Role | undefined {
  if (shapeMetas.length === 0) return undefined;
  let single: string | undefined;
  for (const meta of shapeMetas) {
    const r = meta?.didrawRole;
    if (typeof r !== "string") return undefined;
    if (single === undefined) single = r;
    else if (single !== r) return undefined;
  }
  return single as Role | undefined;
}

/**
 * Derive the "current" connectionKind from a list of arrow metas. Same rules
 * as `deriveCurrentRole` but reads `didrawConnectionKind`.
 */
export function deriveCurrentKind(
  arrowMetas: Array<Record<string, unknown> | undefined>,
): ConnectionKind | undefined {
  if (arrowMetas.length === 0) return undefined;
  let single: string | undefined;
  for (const meta of arrowMetas) {
    const k = meta?.didrawConnectionKind;
    if (typeof k !== "string") return undefined;
    if (single === undefined) single = k;
    else if (single !== k) return undefined;
  }
  return single as ConnectionKind | undefined;
}

// ---------------------------------------------------------------------------
// Keyboard handler factory (mirrors makeExportHotkeyHandler pattern)
// ---------------------------------------------------------------------------

/**
 * Factory for the Cmd+Shift+K / Ctrl+Shift+K picker hotkey handler.
 *
 * Returns a KeyboardEvent handler suitable for window.addEventListener("keydown", ...).
 * When the shortcut fires, it calls `onOpen()` if the selection is non-empty,
 * or `onEmpty()` if nothing is selected.
 */
export function makeRolePickerHandler(
  getInfo: () => SelectionInfo,
  onOpen: () => void,
  onEmpty?: () => void,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    // Shortcut registry: read the active binding at event time.
    if (!matchShortcut(getActiveBinding("role-picker"), e)) return;
    e.preventDefault();
    const info = getInfo();
    if (!info.hasSelection) {
      onEmpty?.();
      return;
    }
    onOpen();
  };
}
