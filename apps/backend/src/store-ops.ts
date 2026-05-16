// apps/backend/src/store-ops.ts
//
// Pure store operations над TLStoreSnapshot:
//   - applyStoreChanges: returns new snapshot, не мутирует input.
//   - rebuildDidrawIndex: Map<didrawName, recordId> по meta.didrawName.
//   - findShapeByDidrawName: O(1) lookup через index.
//   - cascadeDeleteShape: strict cascade — bindings/arrows/frame children.
//
// Backend работает с TLRecord как с opaque JSON: только id/typeName/parentId/meta
// читаются, остальное переносится без интерпретации.

import type { StoreChangeBatch, TLRecord, TLStoreSnapshot } from "./store-types";

export function applyStoreChanges(s: TLStoreSnapshot, batch: StoreChangeBatch): TLStoreSnapshot {
  // Sanity: id не может быть одновременно added и removed в одном батче.
  for (const id in batch.added) {
    if (id in batch.removed) throw new Error(`conflicting batch: id "${id}" both added and removed`);
  }
  const out: Record<string, TLRecord> = { ...s.store };
  for (const id in batch.added) out[id] = batch.added[id];
  for (const id in batch.updated) out[id] = batch.updated[id][1];
  for (const id in batch.removed) delete out[id];
  return { schema: s.schema, store: out };
}

export function rebuildDidrawIndex(s: TLStoreSnapshot): Map<string, string> {
  const m = new Map<string, string>();
  for (const id in s.store) {
    const r = s.store[id];
    if (r.typeName !== "shape") continue;
    const name = r.meta?.didrawName;
    if (typeof name === "string") m.set(name, id);
  }
  return m;
}

export function findShapeByDidrawName(
  s: TLStoreSnapshot,
  index: Map<string, string>,
  name: string,
): TLRecord | undefined {
  const id = index.get(name);
  return id ? s.store[id] : undefined;
}

export function cascadeDeleteShape(
  s: TLStoreSnapshot,
  shapeId: string,
): StoreChangeBatch {
  const removed: Record<string, TLRecord> = {};
  const updated: Record<string, [TLRecord, TLRecord]> = {};
  const target = s.store[shapeId];
  if (!target) return { added: {}, updated, removed };
  removed[shapeId] = target;

  // 1. Bindings, ссылающиеся на target (toId === shapeId), — удалить.
  //    Если binding принадлежит arrow, и у arrow остаётся <2 bindings —
  //    удалить arrow целиком (висячая стрелка) + её оставшиеся bindings.
  const arrowsTouched = new Set<string>();
  for (const id in s.store) {
    const r = s.store[id];
    if (r.typeName !== "binding") continue;
    const bAny = r as unknown as { toId?: unknown; fromId?: unknown };
    if (bAny.toId === shapeId) {
      removed[id] = r;
      if (typeof bAny.fromId === "string") arrowsTouched.add(bAny.fromId);
    }
  }
  for (const arrowId of arrowsTouched) {
    // Считаем bindings на этой стрелке, оставшиеся после удалений выше.
    const remaining = Object.values(s.store).filter(
      (r) => r.typeName === "binding" && (r as unknown as { fromId?: unknown }).fromId === arrowId && !(r.id in removed),
    );
    if (remaining.length < 2 && s.store[arrowId] && !(arrowId in removed)) {
      removed[arrowId] = s.store[arrowId];
      // Плюс оставшиеся bindings этой стрелки тоже под нож.
      for (const r of remaining) removed[r.id] = r;
    }
  }

  // 2. Если target — frame, освободить children: parentId → "page:page".
  //    Children сами НЕ удаляются (cascade-delete только bindings/arrows).
  if (target.typeName === "shape" && (target as { type?: string }).type === "frame") {
    for (const id in s.store) {
      const r = s.store[id];
      if (r.parentId === shapeId && !(id in removed)) {
        updated[id] = [r, { ...r, parentId: "page:page" }];
      }
    }
  }

  return { added: {}, updated, removed };
}
