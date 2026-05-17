// Mirrors apps/backend/src/ws-protocol.ts:isPlaceholderSchema. Backend stores
// `migrate-v2.defaultSchema()` (V1 stub: `{ schemaVersion: 1, ... }`) for fresh
// rooms until the first connected client uploads its real V2 schema through
// WS hello (DRW-040). Frontend uses this check to decide whether the incoming
// /api/state snapshot can be loaded directly or needs a one-shot schema swap
// to avoid tldraw's migrator crashing on the legacy stub.
export function isPlaceholderSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return true;
  const s = schema as Record<string, unknown>;
  return s["schemaVersion"] !== 2 || s["sequences"] === undefined;
}
