import type { Editor, TLRecord, TLShape, TLShapeId } from "tldraw";
import type { SchemaContainerProps, SchemaContainerShape } from "./SchemaContainerShape";

// DRW-178: suppression flag for auto-flip. DRW-149 applies WS-driven layout
// batches through editor.run() (so Cmd+Z can undo them), which makes those
// shape moves appear as source:"user" to the auto-flip listener — and they
// would incorrectly mark the parent container's direction as "custom".
// The WS handler wraps layoutAction apply in withAutoFlipSuppressed() so the
// listener bails for the duration of that synchronous run.
let autoFlipSuppressed = 0;

/**
 * Run `fn` with auto-flip suppression active. Reentrant via depth counter.
 *
 * The decrement is deferred to a macrotask because tldraw's store.listen
 * callbacks fire ASYNCHRONOUSLY (empirically observed ~30ms after
 * editor.run() completes — likely on a frame schedule). A synchronous
 * decrement clears the flag before the listener checks it; a setTimeout(0)
 * also runs before the listener. 250ms is a generous safety margin that
 * also outlasts the 50ms WS-outgoing debounce, so any user drag the user
 * initiates within that window is still treated as manual.
 */
const SUPPRESS_RESET_MS = 250;

export function withAutoFlipSuppressed<T>(fn: () => T): T {
  autoFlipSuppressed += 1;
  try {
    return fn();
  } finally {
    setTimeout(() => {
      autoFlipSuppressed -= 1;
    }, SUPPRESS_RESET_MS);
  }
}

/** True while at least one withAutoFlipSuppressed scope is active. */
export function isAutoFlipSuppressed(): boolean {
  return autoFlipSuppressed > 0;
}

/**
 * DRW-150: Pure handler — inspects a prev/next shape pair from a store
 * historyEntry and returns a schema-container update to flip direction to
 * 'custom', or null if no flip is needed.
 *
 * Extracted as a pure function for unit-testability without a full Editor
 * instance.
 */
export function computeAutoFlip(
  prev: TLShape,
  next: TLShape,
  getShape: (id: string) => TLShape | undefined,
): { id: TLShapeId; type: "schema-container"; props: SchemaContainerProps } | null {
  // Skip arrows and schema-container itself
  if (next.type === "arrow") return null;
  if (next.type === "schema-container") return null;

  // Only react to position changes
  const positionChanged = prev.x !== next.x || prev.y !== next.y;
  if (!positionChanged) return null;

  // Parent must remain the same (not a reparent event)
  if (next.parentId !== prev.parentId) return null;
  if (!next.parentId?.startsWith("shape:")) return null;

  const parent = getShape(next.parentId);
  if (parent?.type !== "schema-container") return null;

  const props = parent.props as SchemaContainerProps;
  if (props.direction === "custom") return null;

  return {
    id: parent.id,
    type: "schema-container",
    props: { ...props, direction: "custom" },
  };
}

/**
 * DRW-150: When user manually drags a child shape inside a schema-container,
 * auto-flip the parent's direction to "custom" — preserving user's manual
 * positioning on the next autolayout pass.
 *
 * Only user-source changes trigger flip. Remote/programmatic updates (AI,
 * WS sync, mergeRemoteChanges) are ignored because store.listen is called
 * with { source: "user" }.
 *
 * Returns a disposer function — call it to unsubscribe.
 */
export function registerAutoFlipDirection(editor: Editor): () => void {
  return editor.store.listen(
    (historyEntry) => {
      // DRW-178: bail when WS-driven layoutAction is being applied — those
      // shape moves are NOT user-driven manual repositioning even though
      // tldraw stamps them as source:"user" (DRW-149 used editor.run for undo).
      if (isAutoFlipSuppressed()) return;
      const { updated } = historyEntry.changes;
      for (const [prevRecord, nextRecord] of Object.values(updated)) {
        if (nextRecord.typeName !== "shape") continue;

        const prev = prevRecord as TLRecord as TLShape;
        const next = nextRecord as TLRecord as TLShape;

        const update = computeAutoFlip(prev, next, (id) =>
          editor.getShape(id as import("tldraw").TLShapeId) as TLShape | undefined,
        );
        if (!update) continue;

        editor.updateShape<SchemaContainerShape>(update);
      }
    },
    { source: "user", scope: "document" },
  );
}
