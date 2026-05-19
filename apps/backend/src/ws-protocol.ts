import type { StoreChangeBatch, TLRecord } from "./store-types";
import type { RoomState, WsClientMessage, WsMessage } from "./types";

// Validate that a parsed JSON value matches StoreChangeBatch shape minimally:
// added/updated/removed are plain objects (record-by-id). Values themselves
// stay opaque — server treats records as JSON black-boxes (frontend owns the
// tldraw schema). Returns null on shape mismatch.
function parseStoreChangeBatch(value: unknown): StoreChangeBatch | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { added?: unknown; updated?: unknown; removed?: unknown };
  const a = v.added;
  const u = v.updated;
  const r = v.removed;
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  if (!u || typeof u !== "object" || Array.isArray(u)) return null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  // Updated values must each be a 2-tuple [old, new]. Other entries are
  // accepted opaquely (the server already treats TLRecord as JSON).
  for (const id in u as Record<string, unknown>) {
    const pair = (u as Record<string, unknown>)[id];
    if (!Array.isArray(pair) || pair.length !== 2) return null;
  }
  return {
    added: a as Record<string, TLRecord>,
    updated: u as Record<string, [TLRecord, TLRecord]>,
    removed: r as Record<string, TLRecord>,
  };
}

// Parse client → server WS frame. Returns null on malformed input so callers
// can silently ignore (server must never crash on garbage).
export function parseClientMessage(
  raw: string | Buffer | ArrayBuffer | Uint8Array,
): WsClientMessage | null {
  let text: string;
  try {
    if (typeof raw === "string") text = raw;
    else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
    else text = new TextDecoder().decode(raw as Uint8Array);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as {
    kind?: unknown;
    lastVersion?: unknown;
    changes?: unknown;
    clientOpId?: unknown;
    schema?: unknown;
    requestId?: unknown;
    ok?: unknown;
    shape_ids?: unknown;
    didraw_names?: unknown;
    root_ids?: unknown;
    error?: unknown;
  };
  if (
    obj.kind === "hello" &&
    typeof obj.lastVersion === "number" &&
    Number.isFinite(obj.lastVersion)
  ) {
    // schema is optional; carry it opaquely — backend never imports @tldraw/*.
    const schema =
      obj.schema !== null &&
      obj.schema !== undefined &&
      typeof obj.schema === "object"
        ? obj.schema
        : undefined;
    return { kind: "hello", lastVersion: obj.lastVersion, schema };
  }
  if (obj.kind === "user-change") {
    const changes = parseStoreChangeBatch(obj.changes);
    if (!changes) return null;
    const clientOpId =
      typeof obj.clientOpId === "string" ? obj.clientOpId : undefined;
    return { kind: "user-change", changes, clientOpId };
  }
  if (obj.kind === "board-focus") {
    const o = obj as { kind?: unknown; room?: unknown; focused?: unknown };
    if (typeof o.room !== "string" || o.room === "") return null;
    if (typeof o.focused !== "boolean") return null;
    return { kind: "board-focus", room: o.room, focused: o.focused };
  }
  if (obj.kind === "import-mermaid-result") {
    if (typeof obj.requestId !== "string" || obj.requestId === "") return null;
    if (typeof obj.ok !== "boolean") return null;
    const shape_ids = Array.isArray(obj.shape_ids) ? (obj.shape_ids as string[]) : undefined;
    const didraw_names = Array.isArray(obj.didraw_names) ? (obj.didraw_names as string[]) : undefined;
    const root_ids = Array.isArray(obj.root_ids) ? (obj.root_ids as string[]) : undefined;
    const error = typeof obj.error === "string" ? obj.error : undefined;
    return { kind: "import-mermaid-result", requestId: obj.requestId, ok: obj.ok, shape_ids, didraw_names, root_ids, error } as WsClientMessage;
  }
  return null;
}

// Returns true if the stored schema is the V1 placeholder produced by
// defaultSchema() — meaning no real client schema has been persisted yet.
// Detection rule: if schemaVersion !== 2 or sequences field is absent, it is
// a placeholder. Backend never imports @tldraw; this check is purely structural.
export function isPlaceholderSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return true;
  const s = schema as Record<string, unknown>;
  return s["schemaVersion"] !== 2 || s["sequences"] === undefined;
}

export type HandleHelloResult = {
  reply: WsMessage;
  /** true when the room's schema was replaced with the client's V2 schema. */
  schemaUpgraded: boolean;
};

// Decide response to a client `hello`. Mutates `room.store.schema` if the
// room holds a V1 placeholder and the client supplies a V2 schema. No I/O —
// callers must schedule persistence themselves when schemaUpgraded is true.
//   last >= r.version          → up-to-date → sync-ack
//   opLog covers [last+1..]    → replay delta
//   gap exceeds opLog window   → truncated (client must full-fetch)
export function handleHello(
  room: RoomState,
  lastVersion: number,
  clientSchema?: unknown,
): HandleHelloResult {
  // Schema upgrade: replace placeholder V1 stub with client's V2 schema.
  let schemaUpgraded = false;
  if (
    clientSchema !== undefined &&
    clientSchema !== null &&
    isPlaceholderSchema(room.store.schema) &&
    !isPlaceholderSchema(clientSchema)
  ) {
    room.store = { ...room.store, schema: clientSchema as any };
    schemaUpgraded = true;
  }

  const last = Number.isFinite(lastVersion) ? lastVersion : 0;
  let reply: WsMessage;
  if (last >= room.version) {
    reply = { kind: "sync-ack", version: room.version };
  } else {
    // Oldest version still retained in the rolling window. When opLog is empty
    // the only safe `minLogVer` is `version + 1` (nothing replayable), which
    // forces `truncated` for any client that is behind.
    const minLogVer = room.opLog[0]?.version ?? room.version + 1;
    if (last + 1 >= minLogVer) {
      const changes = room.opLog
        .filter((e) => e.version > last)
        .map((e) => e.ops);
      reply = { kind: "replay", changes, version: room.version };
    } else {
      reply = { kind: "truncated", version: room.version };
    }
  }

  return { reply, schemaUpgraded };
}
