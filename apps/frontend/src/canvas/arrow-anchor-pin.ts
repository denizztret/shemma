// apps/frontend/src/canvas/arrow-anchor-pin.ts
//
// DRW-190: auto-set binding.props.isExact = true after manual arrow endpoint
// drag (`select.dragging_handle` state). Backend computeAnchors skips bindings
// с isExact=true (см. apps/backend/src/domain/anchors.ts:195) — это natively
// supported tldraw "lock to exact point" контракт. Mirror DRW-185 pattern, но
// для arrow bindings вместо shape meta.pinned.

import { react, type Editor, type TLShape } from "tldraw";

type VecLike = { x: number; y: number };

export type BindingSnapshot = {
  bindingId: string;
  arrowId: string;
  terminal: "start" | "end";
  toId: string;
  normalizedAnchor: VecLike;
  isExact: boolean;
};

export type BindingCurrent = {
  toId: string;
  normalizedAnchor: VecLike;
  isExact: boolean;
};

export type Snapshot = Map<string, BindingSnapshot>;

// === Pure helpers (testable независимо) ===

const ANCHOR_THRESHOLD = 0.001;

export function shouldPinBinding(before: BindingSnapshot, after: BindingCurrent): boolean {
  if (after.isExact === true) return false;
  if (before.toId !== after.toId) return true;
  const dx = after.normalizedAnchor.x - before.normalizedAnchor.x;
  const dy = after.normalizedAnchor.y - before.normalizedAnchor.y;
  return Math.abs(dx) + Math.abs(dy) >= ANCHOR_THRESHOLD;
}

export function computeBindingPinUpdates(
  snapshot: Snapshot,
  getCurrentBinding: (bindingId: string) => BindingCurrent | undefined,
): string[] {
  const ids: string[] = [];
  for (const [id, before] of snapshot) {
    const after = getCurrentBinding(id);
    if (!after) continue;
    if (shouldPinBinding(before, after)) ids.push(id);
  }
  return ids;
}

// === Wiring (live-verified) ===

type ArrowBindingRec = {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  props: {
    terminal: "start" | "end";
    normalizedAnchor: VecLike;
    isExact?: boolean;
    isPrecise?: boolean;
  };
};

function readBindingsForArrow(editor: Editor, arrow: TLShape): ArrowBindingRec[] {
  // biome-ignore lint/suspicious/noExplicitAny: tldraw binding API is loosely typed
  const bindings = (editor as any).getBindingsFromShape(arrow, "arrow") as ArrowBindingRec[];
  return bindings ?? [];
}

function captureArrowBindings(editor: Editor): Snapshot {
  const snapshot: Snapshot = new Map();
  for (const shape of editor.getSelectedShapes()) {
    if (shape.type !== "arrow") continue;
    for (const b of readBindingsForArrow(editor, shape)) {
      if (b.props?.terminal !== "start" && b.props?.terminal !== "end") continue;
      const anchor = b.props.normalizedAnchor ?? { x: 0.5, y: 0.5 };
      snapshot.set(b.id, {
        bindingId: b.id,
        arrowId: shape.id,
        terminal: b.props.terminal,
        toId: b.toId,
        normalizedAnchor: { x: anchor.x, y: anchor.y },
        isExact: b.props.isExact === true,
      });
    }
  }
  return snapshot;
}

function pathToKind(path: string): "dragging_handle" | null {
  if (path === "select.dragging_handle") return "dragging_handle";
  return null;
}

export function registerArrowAnchorPin(editor: Editor): () => void {
  let snapshot: Snapshot | null = null;
  let prevPath = "";

  const dispose = react("arrow-anchor-pin", () => {
    const path = editor.getPath();
    if (path === prevPath) return;
    const entering = pathToKind(path);
    const leaving = pathToKind(prevPath);
    prevPath = path;

    if (entering && snapshot === null) {
      snapshot = captureArrowBindings(editor);
      return;
    }

    if (leaving && !entering && snapshot !== null) {
      const closing = snapshot;
      snapshot = null;
      const updateIds = computeBindingPinUpdates(closing, (id) => {
        // biome-ignore lint/suspicious/noExplicitAny: tldraw binding lookup loosely typed
        const b = (editor as any).getBinding(id) as ArrowBindingRec | undefined;
        if (!b) return undefined;
        const anchor = b.props?.normalizedAnchor ?? { x: 0.5, y: 0.5 };
        return {
          toId: b.toId,
          normalizedAnchor: { x: anchor.x, y: anchor.y },
          isExact: b.props?.isExact === true,
        };
      });
      if (updateIds.length === 0) return;

      editor.markHistoryStoppingPoint("arrow-anchor-pin");
      editor.run(() => {
        const updates = updateIds
          .map((id) => {
            // biome-ignore lint/suspicious/noExplicitAny: see above
            const b = (editor as any).getBinding(id) as ArrowBindingRec | undefined;
            if (!b) return null;
            return {
              id: b.id,
              type: b.type,
              props: { ...b.props, isExact: true },
            };
          })
          .filter((u): u is { id: string; type: string; props: object } => u !== null);
        if (updates.length === 0) return;
        // biome-ignore lint/suspicious/noExplicitAny: tldraw updateBindings accepts partial bindings
        (editor as any).updateBindings(updates);
      });
    }
  });

  return dispose;
}
