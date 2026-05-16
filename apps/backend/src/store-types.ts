// apps/backend/src/store-types.ts
// Phase 3.0: tldraw records хранятся opaque. Backend не импортирует @tldraw/*,
// только JSON-структуры. Все TLRecord-поля кроме id/typeName/parentId/props/meta
// для нас — black box (frontend сам валидирует через schema).

export type TLRecordId = string; // "shape:abc", "binding:abc", "page:abc", "document:document"

export type TLRecord = {
  id: TLRecordId;
  typeName: string; // "shape" | "binding" | "page" | "document" | "asset" | "pointer" | ...
  // Дополнительные поля зависят от typeName. Для shape:
  //   type, x, y, rotation, isLocked, opacity, parentId, index, props, meta.
  // Backend читает только поля, явно перечисленные в этом типе; всё остальное
  // переносится при serialize → JSON без интерпретации.
  type?: string;            // shape type: "geo" | "arrow" | "note" | "text" | "draw" | "frame" | ...
  x?: number;
  y?: number;
  parentId?: TLRecordId;    // shape:* или page:*
  props?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  [extra: string]: unknown; // позволяем хранить опции tldraw, которые не интерпретируем
};

export type TLSchemaDef = {
  // tldraw schema descriptor — backend хранит как есть, не парсит.
  // Используется frontend'ом при loadSnapshot() для миграций tldraw-side.
  schemaVersion: number;
  storeVersion: number;
  recordVersions: Record<string, { version: number; subTypeVersions?: Record<string, number> }>;
};

export type TLStoreSnapshot = {
  schema: TLSchemaDef;
  store: Record<TLRecordId, TLRecord>;
};

export type StoreChangeBatch = {
  added: Record<TLRecordId, TLRecord>;
  updated: Record<TLRecordId, [TLRecord, TLRecord]>; // [old, new]
  removed: Record<TLRecordId, TLRecord>;
};

export type StoreOpLogEntry = {
  ops: StoreChangeBatch;
  source: "ai" | "user";
  version: number;
  at: number;
  clientOpId?: string;
};

// Helpers (type-only, no runtime) для часто используемых проверок.
export function isShapeRecord(r: TLRecord): boolean {
  return r.typeName === "shape";
}

export function isBindingRecord(r: TLRecord): boolean {
  return r.typeName === "binding";
}

export function emptyStoreChangeBatch(): StoreChangeBatch {
  return { added: {}, updated: {}, removed: {} };
}
