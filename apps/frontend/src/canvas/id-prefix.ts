import type { Editor, TLShapeId } from "tldraw";

// Phase 3.0: tldraw store — primary persistence. Backend хранит TLStoreSnapshot
// и rebuild'ит didrawIndex (meta.didrawName → record.id) при каждой apply.
// Frontend больше не маппит canvasId ↔ TLShapeId; всё что нужно — найти shape по
// человекочитаемому имени (для domain commands / prompt selection).

/** Найти tldraw shape id по `meta.didrawName`. O(n) over allRecords — приемлемо
 * для редких lookup'ов (domain APIs, debug). Heavy paths должны проходить
 * через backend didrawIndex, не через клиент. */
export function findShapeIdByDidrawName(
  editor: Editor,
  name: string,
): TLShapeId | null {
  for (const r of editor.store.allRecords()) {
    if (
      r.typeName === "shape" &&
      (r.meta as { didrawName?: string } | undefined)?.didrawName === name
    ) {
      return r.id as TLShapeId;
    }
  }
  return null;
}

/** Прочитать `meta.didrawName` со shape'а — undefined если user-drawn без имени. */
// TODO: rename to `shemmaName` with backfill after 1.0 — currently kept as
// `didrawName` because existing room JSON envelopes use this persistence key;
// renaming without backfill would silently break loaded rooms.
export function getDidrawName(shape: {
  meta?: { didrawName?: string };
}): string | undefined {
  return shape.meta?.didrawName;
}
