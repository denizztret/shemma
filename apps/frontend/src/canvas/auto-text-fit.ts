// apps/frontend/src/canvas/auto-text-fit.ts
//
// DRW-228: event-driven auto text-fit. A text shape is fitted (DRW-219
// pickOptimalWidth) ONCE — when it is added or its text is edited — not before
// every layout. This sizes nodes right at the moment their content is set, so
// by the time a layout runs they already carry correct dimensions, and a
// user's manual resize is never undone by a later layout pass.
//
// `shouldAutoFit` is the pure decision used by the store listener for each
// added/changed shape; the runtime wiring (`registerAutoTextFit`) lives below.

import {
  type Editor,
  type TLRecord,
  type TLShape,
  type TLShapeId,
  react,
} from "tldraw";
import {
  TEXT_FIT_TYPES,
  applyTextFitToShape,
  shapeHasText,
} from "./apply-text-fit";
import { extractPlaintextFromRichText } from "./schema-overlay-sync";

/** Shape types that carry an explicit size + growY and benefit from fitting.
 *  `text` shapes auto-size themselves (autoSize) and are excluded — matches
 *  DRW-219 `TEXT_FIT_TYPES`. */
const FITTABLE_TYPES: ReadonlySet<string> = new Set(["geo", "note"]);

export type AutoFitInput = {
  /** tldraw shape type. */
  type: string;
  /** Shape currently has non-empty text. */
  hasText: boolean;
  /** `meta.didrawSizePinned === true` — user owns the size (explicit ⌘⇧F or
   *  manual resize); never auto-fit over it. */
  sizePinned: boolean;
  /** The text was just added or changed (vs. a move/resize/style-only change).
   *  Fitting only on text change keeps this from re-firing on every edit and
   *  from looping on its own size write. */
  textChanged: boolean;
};

/** Decide whether a just-added/changed shape should be auto-fitted. */
export function shouldAutoFit(input: AutoFitInput): boolean {
  return (
    FITTABLE_TYPES.has(input.type) &&
    input.hasText &&
    !input.sizePinned &&
    input.textChanged
  );
}

/** Plaintext of a shape changed between two versions. Empty string and null
 *  are treated as equivalent ("no text") so a non-text update never looks like
 *  a text change. */
export function textChanged(prev: string | null, next: string | null): boolean {
  return (prev ?? "") !== (next ?? "");
}

// === Runtime wiring (live-verified) ===

function isSizePinned(shape: TLShape): boolean {
  return (
    (shape.meta as { didrawSizePinned?: unknown } | undefined)
      ?.didrawSizePinned === true
  );
}

function plaintextOf(shape: TLShape): string | null {
  return extractPlaintextFromRichText(
    (shape.props as { richText?: unknown }).richText,
  );
}

/**
 * DRW-228: event-driven auto text-fit. Fits a geo/note exactly once — when it
 * is added with text, or when its text is edited — so by the time a layout
 * runs the node already carries correct dimensions. A user's manual resize
 * (meta.didrawSizePinned) is never overwritten.
 *
 * Two triggers:
 *  1. store.listen({source:'all'}) — catches both user edits AND AI/remote
 *     adds (mergeRemoteChanges marks AI diffs source='remote'). A change to a
 *     shape that is currently being edited is DEFERRED (we don't re-fit on
 *     every keystroke) and recorded for the editing-end pass.
 *  2. react(getEditingShapeId) — when editing ends on a shape whose text
 *     changed during the session, fit it once.
 *
 * No feedback loop: the fit writes w/h/growY/meta but NOT richText, so the
 * re-entrant listener call sees textChanged=false and bails.
 *
 * Returns a disposer.
 */
export function registerAutoTextFit(editor: Editor): () => void {
  // Shapes whose text changed while being edited — fitted on editing-end.
  const pendingEditing = new Set<TLShapeId>();

  const fitOne = (shape: TLShape): void => {
    if (
      !shouldAutoFit({
        type: shape.type,
        hasText: shapeHasText(shape),
        sizePinned: isSizePinned(shape),
        // Only ever called for an added/text-changed shape.
        textChanged: true,
      })
    ) {
      return;
    }
    editor.run(() => {
      editor.markHistoryStoppingPoint("auto-fit-text");
      applyTextFitToShape(editor, shape);
    });
  };

  const unlisten = editor.store.listen(
    (entry) => {
      const editingId = editor.getEditingShapeId();
      const { added, updated } = entry.changes;

      for (const record of Object.values(added)) {
        if (record.typeName !== "shape") continue;
        const shape = record as TLRecord as TLShape;
        if (!TEXT_FIT_TYPES.has(shape.type)) continue;
        if (!shapeHasText(shape)) continue;
        if (editingId === shape.id) {
          pendingEditing.add(shape.id);
          continue;
        }
        fitOne(shape);
      }

      for (const [prevRecord, nextRecord] of Object.values(updated)) {
        if (nextRecord.typeName !== "shape") continue;
        const next = nextRecord as TLRecord as TLShape;
        if (!TEXT_FIT_TYPES.has(next.type)) continue;
        const prev = prevRecord as TLRecord as TLShape;
        if (!textChanged(plaintextOf(prev), plaintextOf(next))) continue;
        if (editingId === next.id) {
          pendingEditing.add(next.id);
          continue;
        }
        fitOne(next);
      }
    },
    { source: "all", scope: "document" },
  );

  // editing-end: fit shapes whose text changed during an editing session.
  let prevEditingId: TLShapeId | null = null;
  const disposeReact = react("auto-fit-text-editing-end", () => {
    const editingId = editor.getEditingShapeId();
    if (editingId === prevEditingId) return;
    const finished = prevEditingId;
    prevEditingId = editingId;
    if (finished && finished !== editingId && pendingEditing.has(finished)) {
      pendingEditing.delete(finished);
      const shape = editor.getShape(finished);
      if (shape) fitOne(shape);
    }
  });

  return () => {
    unlisten();
    disposeReact();
  };
}
