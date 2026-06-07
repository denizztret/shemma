/**
 * DRW-134 Task 2.7: Frontend overlay-sync listener.
 *
 * Subscribes to tldraw store changes with `{ source: "user", scope: "document" }`
 * filter. When user drags/colors/renames a shape that is a child of a schema-frame
 * (i.e. has `meta.didrawSchemaParent` set), computes the overlay delta and POSTs
 * to `POST /api/schema/{frameId}/overlay`.
 *
 * Anti-loop guarantee: backend updates are broadcast via WS with source "remote".
 * The listener ignores remote changes (filter source:"user"), so backend → WS →
 * store sync never re-triggers overlay POST.
 *
 * Debounce: drag events fire rapidly; changes per (frameId, nodeId) pair are
 * coalesced with configurable tail debounce (default 300ms) and flushed once on
 * the trailing edge.
 */

import type { Editor, TLRecord, TLShape } from "tldraw";
import type { OverlayEntry } from "@shemma/domain";
import { rolePreset } from "@shemma/domain";
import { LEGACY_SPACE_ID } from "../transport/api";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Resolved meta fields for a schema-child shape. */
type SchemaChildMeta = {
  didrawId: string;
  didrawLabel: string;
  didrawSchemaParent: string; // frame tldraw shape id
  role?: string;
};

/** Per-(frameId, nodeId) pending overlay delta, accumulated during drag. */
type PendingEntry = {
  frameId: string;
  nodeId: string;
  overlay: OverlayEntry;
  timer: ReturnType<typeof setTimeout>;
};

// ---------------------------------------------------------------------------
// Pure helper: extract SchemaChildMeta from a shape record
// ---------------------------------------------------------------------------

/**
 * Returns meta if shape is a schema-child (has `didrawSchemaParent` set),
 * otherwise returns undefined.
 */
export function extractSchemaChildMeta(
  shape: TLShape,
): SchemaChildMeta | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: tldraw meta is untyped
  const m = (shape as any).meta as Record<string, unknown> | undefined;
  if (!m) return undefined;
  const parent = m.didrawSchemaParent;
  if (typeof parent !== "string" || !parent) return undefined;
  const nodeId = m.didrawId;
  if (typeof nodeId !== "string" || !nodeId) return undefined;
  const label = typeof m.didrawLabel === "string" ? m.didrawLabel : "";
  const role = typeof m.role === "string" ? m.role : undefined;
  return { didrawId: nodeId, didrawLabel: label, didrawSchemaParent: parent, role };
}

// ---------------------------------------------------------------------------
// Pure helper: compute overlay delta between previous and next shape state
// ---------------------------------------------------------------------------

/**
 * Computes the partial OverlayEntry for changes that differ from the schema
 * default. Returns `null` if nothing relevant changed.
 *
 * Detects:
 *   - position (x/y) change vs previous state
 *   - color change vs role-preset default color
 *   - label change vs meta.didrawLabel (the stored label in RAW)
 */
export function computeOverlayDelta(
  prev: TLShape,
  next: TLShape,
  childMeta: SchemaChildMeta,
): OverlayEntry | null {
  const delta: OverlayEntry = {};

  // Position: any change in x/y vs previous state is an overlay.
  if (next.x !== prev.x || next.y !== prev.y) {
    delta.position = { x: next.x, y: next.y };
  }

  // Color: compare against role-preset default. If shape has no role or
  // color differs from preset default, treat as user override.
  // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props are untyped
  const nextProps = (next as any).props as Record<string, unknown> | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props are untyped
  const prevProps = (prev as any).props as Record<string, unknown> | undefined;
  const nextColor = typeof nextProps?.color === "string" ? nextProps.color : undefined;
  const prevColor = typeof prevProps?.color === "string" ? prevProps.color : undefined;
  if (nextColor !== prevColor) {
    // Only record color overlay if it differs from role-preset default.
    const presetColor = childMeta.role
      ? // biome-ignore lint/suspicious/noExplicitAny: rolePreset accepts Role string
        rolePreset(childMeta.role as any)?.style?.color
      : undefined;
    if (nextColor !== presetColor) {
      delta.color = nextColor;
    }
  }

  // Label: compare against meta.didrawLabel (the canonical label in RAW).
  // richText change is detected by comparing rendered plaintext approximation.
  // We use a simple heuristic: if props.richText changed (by reference inequality
  // on the sub-object) AND we can extract a text representation, treat it as label change.
  const nextRt = nextProps?.richText;
  const prevRt = prevProps?.richText;
  if (nextRt !== prevRt && nextRt !== undefined) {
    // Extract plaintext best-effort: richText ProseMirror doc → walk `text` nodes.
    const renderedLabel = extractPlaintextFromRichText(nextRt);
    if (renderedLabel !== null && renderedLabel !== childMeta.didrawLabel) {
      delta.label = renderedLabel;
    }
  }

  const hasChanges = delta.position !== undefined || delta.color !== undefined || delta.label !== undefined;
  if (!hasChanges) return null;

  // DRW-214: «двигал» ≠ «красил» — флаг владения СТИЛЕМ ставится только при
  // style-полях в дельте. Position-only drag его не взводит, иначе style
  // propagation (respectUserOwned) молча перестаёт применять board-дефолты
  // к любому когда-либо двинутому узлу.
  if (delta.color !== undefined || delta.label !== undefined) {
    delta.styleOwnedBy = "user";
  }
  return delta;
}

// ---------------------------------------------------------------------------
// Pure helper: extract plaintext from richText ProseMirror-style doc
// ---------------------------------------------------------------------------

/**
 * Walk a ProseMirror-like richText doc and concatenate text node content.
 * Returns null if the structure is unexpected (not a PM doc).
 *
 * tldraw 5.x stores richText as a ProseMirror document with `{type:"doc", content:[...]}`
 * where leaf nodes have `{type:"text", text:"..."}`.
 */
export function extractPlaintextFromRichText(richText: unknown): string | null {
  if (typeof richText !== "object" || richText === null) return null;
  const doc = richText as { type?: string; content?: unknown[]; text?: string };
  if (doc.type === "text" && typeof doc.text === "string") return doc.text;
  if (!Array.isArray(doc.content)) return null;
  const parts: string[] = [];
  for (const node of doc.content) {
    const sub = extractPlaintextFromRichText(node);
    if (sub !== null) parts.push(sub);
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// HTTP helper: POST /api/schema/{frameId}/overlay
// ---------------------------------------------------------------------------

/**
 * Compute the query string for overlay endpoint from window.location or opts.
 */
function buildOverlayUrl(frameId: string, space: string, room: string): string {
  const qs = new URLSearchParams({ space, room }).toString();
  return `/api/schema/${encodeURIComponent(frameId)}/overlay?${qs}`;
}

/**
 * POST overlay to backend. Returns quietly on network errors (best-effort).
 */
async function postOverlayHttp(
  frameId: string,
  nodeId: string,
  overlay: OverlayEntry,
  space: string,
  room: string,
): Promise<void> {
  try {
    const url = buildOverlayUrl(frameId, space, room);
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId, overlay }),
    });
  } catch {
    // Best-effort: network failure doesn't propagate to user.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type OverlayPostFn = (
  frameId: string,
  nodeId: string,
  overlay: OverlayEntry,
) => Promise<void>;

export type SchemaOverlaySyncOpts = {
  /** Injectable postOverlay fn (used in tests to avoid real HTTP). */
  postOverlay?: OverlayPostFn;
  /** Debounce tail delay in ms. Default 300. */
  debounceMs?: number;
  /** space id for HTTP requests. Default from window.location or LEGACY_SPACE_ID. */
  space?: string;
  /** room id for HTTP requests. Default from window.location. */
  room?: string;
};

/**
 * DRW-134 Task 2.7: Install overlay-sync listener on the given editor.
 *
 * Subscribes to `editor.store.listen({ source: "user", scope: "document" })`.
 * For each updated shape that has `meta.didrawSchemaParent` set (schema-child),
 * computes overlay delta and POSTs to backend with per-(frameId, nodeId) debounce.
 *
 * Returns a disposer function — call it to unsubscribe and cancel pending timers.
 *
 * @example
 * ```ts
 * const dispose = installSchemaOverlaySync(editor, { debounceMs: 300 });
 * // later:
 * dispose();
 * ```
 */
export function installSchemaOverlaySync(
  editor: Editor,
  opts: SchemaOverlaySyncOpts = {},
): () => void {
  const debounceMs = opts.debounceMs ?? 300;

  // Resolve space/room for HTTP calls (default from location if available).
  const space =
    opts.space ??
    (typeof location !== "undefined"
      ? (new URLSearchParams(location.search).get("space") ?? LEGACY_SPACE_ID)
      : LEGACY_SPACE_ID);
  const room =
    opts.room ??
    (typeof location !== "undefined"
      ? (new URLSearchParams(location.search).get("room") ?? "default")
      : "default");

  // Injectable postOverlay allows test isolation.
  const postOverlay: OverlayPostFn =
    opts.postOverlay ??
    ((frameId, nodeId, overlay) => postOverlayHttp(frameId, nodeId, overlay, space, room));

  // Per-(frameId, nodeId) debounce map. Key: `${frameId}::${nodeId}`.
  const pending = new Map<string, PendingEntry>();

  /**
   * Schedule (or reschedule) a debounced POST for a given (frameId, nodeId).
   * Merges overlay fields into pending entry (later values win per field).
   */
  function schedule(frameId: string, nodeId: string, overlay: OverlayEntry): void {
    const key = `${frameId}::${nodeId}`;
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      // Merge: later write wins per field.
      Object.assign(existing.overlay, overlay);
      existing.timer = setTimeout(() => flush(key), debounceMs);
    } else {
      const entry: PendingEntry = {
        frameId,
        nodeId,
        overlay: { ...overlay },
        timer: setTimeout(() => flush(key), debounceMs),
      };
      pending.set(key, entry);
    }
  }

  function flush(key: string): void {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    // Fire and forget — best-effort.
    void postOverlay(entry.frameId, entry.nodeId, entry.overlay);
  }

  // Subscribe to user-originated document changes only.
  const unsubscribe = editor.store.listen(
    (historyEntry) => {
      const { updated } = historyEntry.changes;
      for (const [prevRecord, nextRecord] of Object.values(updated)) {
        // Only care about shapes.
        if (nextRecord.typeName !== "shape") continue;

        const prev = prevRecord as TLRecord as TLShape;
        const next = nextRecord as TLRecord as TLShape;

        const childMeta = extractSchemaChildMeta(next);
        if (!childMeta) continue; // not a schema-child

        const delta = computeOverlayDelta(prev, next, childMeta);
        if (!delta) continue; // no relevant change

        schedule(childMeta.didrawSchemaParent, childMeta.didrawId, delta);
      }
    },
    { source: "user", scope: "document" },
  );

  // Disposer: unsubscribe from store + cancel all pending timers.
  return () => {
    unsubscribe();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
    }
    pending.clear();
  };
}
