import type { Editor, TLShape } from "tldraw";

/**
 * DRW-171 / DRW-077: Re-run ShapeUtil.onBeforeCreate for shapes that arrived
 * via store.put (snapshot load, WS mergeRemoteChanges).
 *
 * `GeoShapeUtil.onBeforeCreate` measures the label via `editor.textMeasure`
 * and produces `growY` / expanded `w` so text fits the box. tldraw runs it
 * only when shapes pass through `editor.createShape` — `store.put` bypasses
 * the hook, so shapes from backend (mermaid-import, AI domain actions)
 * arrive with raw `w/h` and clipped text.
 *
 * `onBeforeUpdate` cannot substitute: it early-returns when richText/font/
 * size are equal between prev and next (see tldraw GeoShapeUtil.mjs), so a
 * no-op `updateShape({...same props})` never re-measures. Calling
 * `util.onBeforeCreate(shape)` directly does the measure regardless of
 * diff, and we apply the returned props through `updateShape`.
 *
 * Whitelist: only tldraw default shapes that have a text-driven autosize
 * path in their `onBeforeCreate`. Custom shapes manage their own sizing.
 */
const AUTOSIZE_TYPES: ReadonlySet<string> = new Set(["geo", "note", "text"]);

export function triggerAutoSize(editor: Editor, ids?: Set<string>): void {
  const shapes = editor
    .getCurrentPageShapes()
    .filter(
      (s) =>
        AUTOSIZE_TYPES.has(s.type) &&
        (ids === undefined || ids.has(s.id)),
    );
  if (shapes.length === 0) return;
  editor.run(() => {
    for (const s of shapes) {
      const util = editor.getShapeUtil(s.type);
      // biome-ignore lint/suspicious/noExplicitAny: tldraw onBeforeCreate signature
      const next = (util as any).onBeforeCreate?.(s) as TLShape | undefined;
      if (next) {
        // biome-ignore lint/suspicious/noExplicitAny: TLShape union of props variants
        editor.updateShape({
          id: s.id,
          type: s.type,
          props: next.props,
        } as any);
      }
    }
  });
}
