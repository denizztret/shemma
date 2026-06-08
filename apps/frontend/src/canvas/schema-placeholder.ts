import { coerceColor, isValidColor } from "@shemma/domain";

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
      if (Object.prototype.hasOwnProperty.call(newProps ?? props, "text")) {
        const { text: _text, ...rest } = newProps ?? props;
        newProps = rest;
      }
      if (newProps !== undefined) {
        out[id] = { ...r, props: newProps };
        continue;
      }
    } else if (
      r &&
      typeof r === "object" &&
      r.typeName === "binding" &&
      r.type === "arrow"
    ) {
      const props = (r.props as Record<string, unknown> | undefined) ?? {};
      if (props.snap === undefined) {
        out[id] = { ...r, props: { ...props, snap: "none" } };
        continue;
      }
    } else if (
      r &&
      typeof r === "object" &&
      r.typeName === "shape" &&
      r.type === "frame"
    ) {
      // tldraw 5.x added required props.color to TLFrameShape (migration
      // AddColorProp, default "black"). Frames persisted before this become
      // invalid on loadSnapshot — backfill default to match migration.
      const props = (r.props as Record<string, unknown> | undefined) ?? {};
      if (props.color === undefined) {
        out[id] = { ...r, props: { ...props, color: "black" } };
        continue;
      }
    } else if (
      r &&
      typeof r === "object" &&
      r.typeName === "shape" &&
      r.type === "note"
    ) {
      // tldraw 5.x added required props to TLNoteShape that older `shemma_note`
      // payloads omit. Defaults mirror tldraw's own migrations:
      //   AddLabelColor    → labelColor: "black"
      //   AddFirstEditedBy → textFirstEditedBy: null (T.string.nullable())
      const props = (r.props as Record<string, unknown> | undefined) ?? {};
      let newProps: Record<string, unknown> | undefined;
      if (props.labelColor === undefined) {
        newProps = { ...(newProps ?? props), labelColor: "black" };
      }
      if (props.textFirstEditedBy === undefined) {
        newProps = { ...(newProps ?? props), textFirstEditedBy: null };
      }
      if (newProps !== undefined) {
        out[id] = { ...r, props: newProps };
        continue;
      }
    }
    out[id] = r as unknown;
  }
  // DRW-231: coerce any invalid (e.g. raw-hex) props.color / props.labelColor on
  // shapes to the nearest tldraw palette name. A single non-palette color value
  // makes strict loadSnapshot throw a ValidationError that aborts the *entire*
  // snapshot load — blanking the board. Runs after type-specific backfills so the
  // frame/note color defaults above are seen as valid here.
  for (const id in out) {
    const r = out[id] as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || r.typeName !== "shape") continue;
    const props = r.props as Record<string, unknown> | undefined;
    if (!props) continue;
    let newProps: Record<string, unknown> | undefined;
    if (typeof props.color === "string" && !isValidColor(props.color)) {
      newProps = { ...(newProps ?? props), color: coerceColor(props.color) };
    }
    if (
      typeof props.labelColor === "string" &&
      !isValidColor(props.labelColor)
    ) {
      newProps = {
        ...(newProps ?? props),
        labelColor: coerceColor(props.labelColor),
      };
    }
    if (newProps !== undefined) out[id] = { ...r, props: newProps };
  }
  return out;
}
