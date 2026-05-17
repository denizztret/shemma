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

// Backfill required props on records persisted before they became mandatory.
// `arrow.props.kind` ("arc" | "elbow") was added by tldraw 5.x after we shipped
// 0.4.x rooms; loadSnapshot fails validation on legacy arrows missing it.
// Adds a default "arc" when absent; idempotent for already-fixed records.
export function backfillStoreRecords(
  store: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!store) return {};
  const out: Record<string, unknown> = {};
  for (const id in store) {
    const r = store[id] as Record<string, unknown> | null;
    if (
      r &&
      typeof r === "object" &&
      r.typeName === "shape" &&
      r.type === "arrow"
    ) {
      const props = (r.props as Record<string, unknown> | undefined) ?? {};
      if (props.kind === undefined) {
        out[id] = { ...r, props: { ...props, kind: "arc" } };
        continue;
      }
    }
    out[id] = r as unknown;
  }
  return out;
}
