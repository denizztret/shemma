import type { Editor, TLShape, TLShapeId } from "tldraw";

/** Walk up the parent chain until a frame shape is found. */
export function ancestorFrame(editor: Editor, id: TLShapeId): TLShapeId | null {
  let cur: TLShape | undefined = editor.getShape(id);
  while (cur) {
    if (cur.type === "frame") return cur.id;
    const parent = cur.parentId;
    cur = parent.startsWith("shape:")
      ? editor.getShape(parent as TLShapeId)
      : undefined;
  }
  return null;
}

/**
 * The frame that owns the current selection (a selected frame itself, or the
 * ancestor frame of a selected container/leaf). Null when the selection sits
 * outside any frame — the caller then considers frameless board layout.
 */
export function selectionFrame(
  editor: Editor,
  ids: TLShapeId[],
): TLShapeId | null {
  for (const id of ids) {
    const f = ancestorFrame(editor, id);
    if (f) return f;
  }
  return null;
}

/**
 * Fallback frame when the selection points at no frame and isn't a layoutable
 * loose selection: the frame under the viewport centre, else the only frame.
 * (Drives "⌘⇧L with nothing selected lays out the obvious frame".)
 */
export function fallbackFrame(editor: Editor): TLShapeId | null {
  const frames = editor
    .getCurrentPageShapes()
    .filter((s) => s.type === "frame");
  const first = frames[0];
  if (!first) return null;
  if (frames.length === 1) return first.id;
  const c = editor.getViewportPageBounds().center;
  const hit = frames.find((f) => {
    const b = editor.getShapePageBounds(f.id);
    return (
      !!b && c.x >= b.x && c.x <= b.x + b.w && c.y >= b.y && c.y <= b.y + b.h
    );
  });
  return (hit ?? first).id;
}

/**
 * Scope = subject (DRW-233 / DRW-218 AC#7): что выделено, то и раскладывается.
 *   - ровно один schema-container → его содержимое (даже page-level);
 *   - иначе фрейм выделения → весь фрейм;
 *   - иначе ≥2 page-level узлов → frameless loose;
 *   - иначе fallback-фрейм (viewport/единственный);
 *   - иначе none.
 */
export type LayoutScope =
  | { kind: "frame"; frameId: TLShapeId }
  | { kind: "container"; containerId: TLShapeId }
  | { kind: "loose"; ids: TLShapeId[] }
  | { kind: "none"; reason: string };

export function resolveLayoutScope(
  editor: Editor,
  ids: TLShapeId[],
): LayoutScope {
  if (ids.length === 1) {
    const firstId = ids[0];
    const s = firstId !== undefined ? editor.getShape(firstId) : undefined;
    if (s?.type === "schema-container") {
      return { kind: "container", containerId: s.id };
    }
  }
  const frameId = selectionFrame(editor, ids);
  if (frameId) return { kind: "frame", frameId };
  const loose = ids
    .map((id) => editor.getShape(id))
    .filter(
      (s): s is TLShape =>
        !!s &&
        (s.type === "geo" || s.type === "schema-container") &&
        s.parentId.startsWith("page:"),
    );
  if (loose.length >= 2) return { kind: "loose", ids: loose.map((s) => s.id) };
  const fb = fallbackFrame(editor);
  if (fb) return { kind: "frame", frameId: fb };
  return {
    kind: "none",
    reason:
      "no schema frame found — select ≥2 connected nodes on the board, or draw a frame",
  };
}
