// Backfill required props on records persisted before they became mandatory.
// `arrow.props.kind` ("arc" | "elbow") was added by tldraw 5.x after we shipped
// 0.4.x rooms; loadSnapshot fails validation on legacy arrows missing it.
// Adds a default "arc" when absent; idempotent for already-fixed records.
// This is independent legacy data backfill — the placeholder schema upgrade
// itself happens server-side via POST /api/state/seed-schema (DRW-047).
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
      let newProps: Record<string, unknown> | undefined;
      if (props.kind === undefined) {
        newProps = { ...(newProps ?? props), kind: "arc" };
      }
      if (props.elbowMidPoint === undefined) {
        newProps = { ...(newProps ?? props), elbowMidPoint: 0.5 };
      }
      if (newProps !== undefined) {
        out[id] = { ...r, props: newProps };
        continue;
      }
    }
    out[id] = r as unknown;
  }
  return out;
}
