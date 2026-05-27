// apps/frontend/src/shapes/style-apply.ts
//
// Frontend writer mirroring backend /api/agent/style-apply. Performs optimistic
// editor.updateShape() on selected shapes + descendants (using the same
// applicability matrix as backend), затем POST'ит на endpoint. Frontend
// SelectionPanel pass'ит respectUserOwned: false (explicit user UI action).

import type { Editor, TLShapeId } from "tldraw";
import type { StyleDefaults } from "@shemma/domain";
import { postStyleApply } from "../settings/api";

const APPLY_DASH = new Set(["geo", "arrow", "schema-container"]);
const APPLY_FONT = new Set(["geo", "note", "text", "arrow"]);
const APPLY_SIZE = new Set(["geo", "note", "text", "arrow"]);
const STICKY_PARENT = new Set(["frame", "schema-container"]);
const PRESERVED_DASH = new Set(["dashed", "dotted"]);

function applyPropsToShape(
  editor: Editor,
  id: TLShapeId,
  styles: StyleDefaults,
): boolean {
  const shape = editor.getShape(id);
  if (!shape) return false;
  const props = (shape.props ?? {}) as Record<string, unknown>;
  const nextProps: Record<string, unknown> = { ...props };
  let changed = false;

  const canSetDash =
    styles.dash !== undefined &&
    APPLY_DASH.has(shape.type) &&
    !PRESERVED_DASH.has(props.dash as string) &&
    nextProps.dash !== styles.dash;
  if (canSetDash) {
    nextProps.dash = styles.dash;
    changed = true;
  }
  if (styles.font !== undefined && APPLY_FONT.has(shape.type) && nextProps.font !== styles.font) {
    nextProps.font = styles.font;
    changed = true;
  }
  if (styles.size !== undefined && APPLY_SIZE.has(shape.type) && nextProps.size !== styles.size) {
    nextProps.size = styles.size;
    changed = true;
  }
  if (!changed) return false;
  // biome-ignore lint/suspicious/noExplicitAny: tldraw props untyped per-shape
  editor.updateShape({ id, type: shape.type, props: nextProps } as any);
  return true;
}

function applyStickyMeta(
  editor: Editor,
  id: TLShapeId,
  styles: StyleDefaults,
): boolean {
  const shape = editor.getShape(id);
  if (!shape || !STICKY_PARENT.has(shape.type)) return false;
  const meta = (shape.meta ?? {}) as Record<string, unknown>;
  const prev = (meta.didrawStyleDefaults ?? {}) as StyleDefaults;
  const next: StyleDefaults = { ...prev };
  let changed = false;
  for (const key of ["dash", "font", "size"] as const) {
    const v = styles[key];
    if (v !== undefined && next[key] !== v) {
      next[key] = v as never;
      changed = true;
    }
  }
  if (!changed) return false;
  // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
  editor.updateShape({
    id,
    type: shape.type,
    meta: { ...meta, didrawStyleDefaults: next },
  } as any);
  return true;
}

export function collectDescendantIds(editor: Editor, rootIds: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...rootIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const kids = editor.getSortedChildIdsForParent(id as TLShapeId);
    for (const k of kids) if (!out.has(k)) stack.push(k);
  }
  return out;
}

export async function applyStyleToSelection(
  editor: Editor,
  selectedIds: string[],
  styles: StyleDefaults,
): Promise<void> {
  if (selectedIds.length === 0 || Object.keys(styles).length === 0) return;

  const targets = collectDescendantIds(editor, selectedIds);

  editor.run(() => {
    for (const id of selectedIds) {
      applyStickyMeta(editor, id as TLShapeId, styles);
    }
    for (const id of targets) {
      applyPropsToShape(editor, id as TLShapeId, styles);
    }
  });

  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const space = url.searchParams.get("space") ?? "default";
  const room = url.searchParams.get("room") ?? "default";

  try {
    await postStyleApply(space, room, {
      selectedIds,
      styles,
      respectUserOwned: false,
    });
  } catch {
    // Optimistic update already applied; non-fatal.
  }
}
