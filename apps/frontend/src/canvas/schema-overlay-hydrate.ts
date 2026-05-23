/**
 * DRW-135: Apply schema overlays to tldraw shapes after hydrate.
 *
 * Backend store содержит RAW positions из mermaid layout (initial). User-overlays
 * (drag/color/role/pinned) хранятся отдельно в `frame.meta.didrawOverlays`.
 * После hydrate (loadSnapshot from /api/state) shapes имеют RAW positions —
 * этот модуль проходит по всем schema-frame'ам с overlays и переписывает
 * x/y/color/role/pinned/styleOwnedBy для каждого nodeId с overlay-записью.
 *
 * MUST be called inside `editor.store.mergeRemoteChanges()` — иначе overlay-sync
 * listener (subscribes к source:"user") сразу отправит POST обратно на backend
 * (no-op в данных, но лишний network round-trip).
 */

import type { Editor, TLShape, TLShapeId } from "tldraw";
import type { OverlayEntry } from "@shemma/domain";

/**
 * Frame-shape с `meta.didrawSchemaFrame===true`. Hydrate проходит только по таким.
 */
type ShapeMeta = Record<string, unknown> & {
  didrawSchemaFrame?: unknown;
  didrawOverlays?: Record<string, OverlayEntry>;
  didrawSchemaParent?: unknown;
  didrawId?: unknown;
  role?: unknown;
  styleOwnedBy?: unknown;
  pinned?: unknown;
};

type ShapeProps = Record<string, unknown> & { color?: unknown };

function getMeta(shape: TLShape): ShapeMeta | undefined {
  return (shape as unknown as { meta?: ShapeMeta }).meta;
}

function getProps(shape: TLShape): ShapeProps | undefined {
  return (shape as unknown as { props?: ShapeProps }).props;
}

/**
 * Pure: собрать пары `{frameId, nodeId, overlay}` из всех schema-frame'ов на канвасе.
 * Игнорирует frames без `didrawSchemaFrame` discriminator и frames с пустым/невалидным
 * `didrawOverlays`.
 */
export function collectOverlayApplications(
  shapes: TLShape[],
): Array<{ frameId: string; nodeId: string; overlay: OverlayEntry }> {
  const out: Array<{ frameId: string; nodeId: string; overlay: OverlayEntry }> = [];
  for (const shape of shapes) {
    if (shape.type !== "frame") continue;
    const meta = getMeta(shape);
    if (!meta) continue;
    if (meta.didrawSchemaFrame !== true) continue;
    const overlays = meta.didrawOverlays;
    if (!overlays || typeof overlays !== "object") continue;
    const frameId = shape.id as unknown as string;
    for (const [nodeId, overlay] of Object.entries(overlays)) {
      if (!overlay || typeof overlay !== "object") continue;
      out.push({ frameId, nodeId, overlay });
    }
  }
  return out;
}

/**
 * Pure: найти shape-child с указанным didrawId в указанном frame.
 * Match по `meta.didrawSchemaParent === frameId && meta.didrawId === nodeId`.
 */
export function findChildByNodeId(
  shapes: TLShape[],
  frameId: string,
  nodeId: string,
): TLShape | undefined {
  for (const shape of shapes) {
    const meta = getMeta(shape);
    if (!meta) continue;
    if (meta.didrawSchemaParent !== frameId) continue;
    if (meta.didrawId !== nodeId) continue;
    return shape;
  }
  return undefined;
}

/**
 * Partial-shape update в формате tldraw `updateShapes`. Возвращается из
 * `computeShapeUpdateFromOverlay` когда есть реальные diff'ы.
 */
export type OverlayShapeUpdate = {
  id: TLShapeId;
  type: string;
  x?: number;
  y?: number;
  props?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

/**
 * Pure: вычислить partial update из overlay-записи. Сравнивает каждое поле
 * overlay с текущим состоянием shape; возвращает только изменённые поля.
 * Возвращает `null` если ничего не отличается (avoid noisy no-op writes).
 *
 * Поля overlay → shape mapping:
 *   - position.x/y         → shape.x / shape.y
 *   - color                → shape.props.color
 *   - role / pinned /      → shape.meta.role / .pinned / .styleOwnedBy
 *     styleOwnedBy
 *   - label                → НЕ применяется через update; label restore идёт
 *                            через meta.didrawLabel в RAW (mermaid output).
 *                            См. DRW-135 spec — label overlay deferred.
 */
export function computeShapeUpdateFromOverlay(
  shape: TLShape,
  overlay: OverlayEntry,
): OverlayShapeUpdate | null {
  const update: OverlayShapeUpdate = {
    id: shape.id as TLShapeId,
    type: shape.type,
  };
  let changed = false;

  if (overlay.position) {
    if (
      shape.x !== overlay.position.x ||
      shape.y !== overlay.position.y
    ) {
      update.x = overlay.position.x;
      update.y = overlay.position.y;
      changed = true;
    }
  }

  if (overlay.color !== undefined) {
    const props = getProps(shape);
    if (props?.color !== overlay.color) {
      update.props = { color: overlay.color };
      changed = true;
    }
  }

  const metaPatch: Record<string, unknown> = {};
  const meta = getMeta(shape);
  let metaChanged = false;

  if (overlay.role !== undefined && meta?.role !== overlay.role) {
    metaPatch.role = overlay.role;
    metaChanged = true;
  }
  if (
    overlay.styleOwnedBy !== undefined &&
    meta?.styleOwnedBy !== overlay.styleOwnedBy
  ) {
    metaPatch.styleOwnedBy = overlay.styleOwnedBy;
    metaChanged = true;
  }
  if (overlay.pinned !== undefined && meta?.pinned !== overlay.pinned) {
    metaPatch.pinned = overlay.pinned;
    metaChanged = true;
  }

  if (metaChanged) {
    update.meta = { ...(meta ?? {}), ...metaPatch };
    changed = true;
  }

  return changed ? update : null;
}

/**
 * Применить overlays ко всем schema-children на текущей странице editor'а.
 * Возвращает количество shape'ов, для которых был выполнен реальный update.
 *
 * **Caller MUST wrap call в `editor.store.mergeRemoteChanges(() => ...)`**
 * чтобы overlay-sync listener (source:"user") не сработал и не отправил
 * POST обратно. Hydrate должен быть "remote" по семантике.
 */
export function applyOverlaysToShapes(editor: Editor): number {
  const shapes = editor.getCurrentPageShapes();
  const applications = collectOverlayApplications(shapes);
  if (applications.length === 0) return 0;

  const updates: OverlayShapeUpdate[] = [];
  for (const { frameId, nodeId, overlay } of applications) {
    const shape = findChildByNodeId(shapes, frameId, nodeId);
    if (!shape) continue;
    const update = computeShapeUpdateFromOverlay(shape, overlay);
    if (!update) continue;
    updates.push(update);
  }

  if (updates.length === 0) return 0;
  // biome-ignore lint/suspicious/noExplicitAny: tldraw updateShapes accepts partial shapes
  editor.updateShapes(updates as any);
  return updates.length;
}
