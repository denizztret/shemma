import type {
  Editor,
  TLGeoShape,
  TLNoteShape,
  TLTextShape,
} from "tldraw";

/**
 * DRW-171 / DRW-077: Re-trigger ShapeUtil.onBeforeUpdate for shapes whose
 * bounds depend on text content. tldraw runs autosize logic (growY for
 * geo/note, autoSize-driven width for text) only when shapes pass through
 * editor.createShapes / updateShapes — store.put (snapshot load, WS
 * mergeRemoteChanges) bypasses those hooks, so text added that way arrives
 * with stale w/h. A no-op updateShape with the same props forces the util
 * to remeasure and correct the bounds.
 *
 * Whitelist: tldraw default shapes with text-driven autosize. Custom shapes
 * (e.g. schema-container) manage their own sizing in their ShapeUtil.
 */
export function triggerAutoSize(editor: Editor, ids?: Set<string>): void {
  const shapes = editor
    .getCurrentPageShapes()
    .filter(
      (s): s is TLGeoShape | TLNoteShape | TLTextShape =>
        (s.type === "geo" || s.type === "note" || s.type === "text") &&
        (ids === undefined || ids.has(s.id)),
    );
  if (shapes.length === 0) return;
  editor.run(() => {
    for (const s of shapes) {
      if (s.type === "geo") {
        editor.updateShape<TLGeoShape>({
          id: s.id,
          type: "geo",
          props: s.props,
        });
      } else if (s.type === "note") {
        editor.updateShape<TLNoteShape>({
          id: s.id,
          type: "note",
          props: s.props,
        });
      } else {
        editor.updateShape<TLTextShape>({
          id: s.id,
          type: "text",
          props: s.props,
        });
      }
    }
  });
}
