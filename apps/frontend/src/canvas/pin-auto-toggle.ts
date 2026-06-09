// apps/frontend/src/canvas/pin-auto-toggle.ts
//
// DRW-185: auto-set meta.pinned + meta.didrawSizePinned after manual
// drag/resize end. Detection через tldraw state-machine listener
// (см. docs/decisions/0005-pin-auto-toggle-state-listener.md).
//
// Pure helpers (computePinUpdates, shouldPin) tested независимо в
// pin-auto-toggle.test.ts. Wiring (registerPinAutoToggle) validated через
// dev stand + chrome-devtools MCP.

import { react, type Editor, type JsonObject, type TLShape, type TLShapeId } from "tldraw";
import { growWrappersForShapes } from "./elk-layout";

export type BBox = { x: number; y: number; w: number; h: number };

export type Snapshot = Map<TLShapeId, BBox & { type: string }>;

type SessionKind = "translating" | "resizing";

type PinUpdate = {
  id: TLShapeId;
  type: string;
  meta: Record<string, unknown>;
};

// === Pure helpers (testable независимо) ===

const MOVE_THRESHOLD_PX = 1;
const RESIZE_THRESHOLD_PX = 1;

export function shouldPin(
  snap: BBox & { type: string },
  current: BBox,
): { moved: boolean; resized: boolean } {
  const dx = current.x - snap.x;
  const dy = current.y - snap.y;
  const dw = current.w - snap.w;
  const dh = current.h - snap.h;
  return {
    moved: Math.abs(dx) + Math.abs(dy) >= MOVE_THRESHOLD_PX,
    resized: Math.abs(dw) + Math.abs(dh) >= RESIZE_THRESHOLD_PX,
  };
}

export function computePinUpdates(
  snapshot: Snapshot,
  getCurrent: (id: TLShapeId) => (BBox & { type: string; meta: Record<string, unknown> }) | undefined,
  kind: SessionKind,
): PinUpdate[] {
  const updates: PinUpdate[] = [];
  for (const [id, snap] of snapshot) {
    const current = getCurrent(id);
    if (!current) continue;
    const { moved, resized } = shouldPin(snap, current);
    if (!moved && !resized) continue;
    const newMeta: Record<string, unknown> = { ...current.meta, pinned: true };
    if (kind === "resizing" && resized) {
      newMeta.didrawSizePinned = true;
      // DRW-232: a deliberate drag-resize is a user-owned size — overrides any
      // prior auto-fit origin so auto-text-fit never re-fits over it.
      newMeta.didrawSizeOrigin = "user";
    }
    updates.push({ id, type: current.type, meta: newMeta });
  }
  return updates;
}

/**
 * Получает bbox для shape из tldraw editor (учитывая props.w/h для geo/frame/note;
 * fallback на shape geometry bounds для shapes без явных props).
 */
function getShapeBBox(editor: Editor, shape: TLShape): BBox & { type: string } {
  const props = shape.props as Record<string, unknown>;
  const hasW = typeof props.w === "number";
  const hasH = typeof props.h === "number";
  const geometry = hasW && hasH ? null : editor.getShapeGeometry(shape).bounds;
  const w = hasW ? (props.w as number) : geometry!.w;
  const h = hasH ? (props.h as number) : geometry!.h;
  return { x: shape.x, y: shape.y, w, h, type: shape.type };
}

function captureSelectionSnapshot(editor: Editor): Snapshot {
  const snapshot: Snapshot = new Map();
  for (const shape of editor.getSelectedShapes()) {
    if (shape.type === "arrow") continue;
    snapshot.set(shape.id, getShapeBBox(editor, shape));
  }
  return snapshot;
}

// === Wiring (live-verified) ===

type SessionState = { kind: SessionKind; snapshot: Snapshot } | null;

function pathToKind(path: string): SessionKind | null {
  if (path === "select.translating") return "translating";
  if (path === "select.resizing") return "resizing";
  return null;
}

export function registerPinAutoToggle(editor: Editor): () => void {
  let session: SessionState = null;
  let prevPath = "";

  const dispose = react("pin-auto-toggle", () => {
    const path = editor.getPath();
    if (path === prevPath) return;
    const enteringKind = pathToKind(path);
    const leavingKind = pathToKind(prevPath);
    prevPath = path;

    if (enteringKind && session === null) {
      // OPEN
      session = {
        kind: enteringKind,
        snapshot: captureSelectionSnapshot(editor),
      };
      return;
    }

    if (leavingKind && !enteringKind && session !== null) {
      // CLOSE
      const closing = session;
      session = null;
      const updates = computePinUpdates(
        closing.snapshot,
        (id) => {
          const shape = editor.getShape(id);
          if (!shape) return undefined;
          const bbox = getShapeBBox(editor, shape);
          return { ...bbox, meta: (shape.meta ?? {}) as Record<string, unknown> };
        },
        closing.kind,
      );
      if (updates.length === 0) return;
      editor.markHistoryStoppingPoint("pin-auto-toggle");
      editor.run(() => {
        // biome-ignore lint/suspicious/noExplicitAny: tldraw updateShapes accepts partial shapes with string type
        editor.updateShapes(
          updates.map((u) => ({ id: u.id, type: u.type, meta: u.meta as Partial<JsonObject> })) as any,
        );
        // DRW-232 (AC #7): a manual drag-resize of a child grows its container/
        // frame envelope so the child stays inside — grow-only, no repack/shrink.
        // Fires at gesture-end (here), not per-frame, to match the pin discipline.
        // Translate-only sessions don't resize, so skip them.
        if (closing.kind === "resizing") {
          growWrappersForShapes(
            editor,
            updates.map((u) => u.id as string),
          );
        }
      });
    }
  });

  return dispose;
}
