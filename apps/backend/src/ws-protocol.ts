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
  };
  if (
    obj.kind === "hello" &&
    typeof obj.lastVersion === "number" &&
    Number.isFinite(obj.lastVersion)
  ) {
    return { kind: "hello", lastVersion: obj.lastVersion };
  }
  if (obj.kind === "user-change") {
    const changes = parseStoreChangeBatch(obj.changes);
    if (!changes) return null;
    const clientOpId =
      typeof obj.clientOpId === "string" ? obj.clientOpId : undefined;
    return { kind: "user-change", changes, clientOpId };
  }
  return null;
}

// Decide response to a client `hello`. Pure: no I/O, no side effects.
//   last >= r.version          → up-to-date → sync-ack
//   opLog covers [last+1..]    → replay delta
//   gap exceeds opLog window   → truncated (client must full-fetch)
export function handleHello(room: RoomState, lastVersion: number): WsMessage {
  const last = Number.isFinite(lastVersion) ? lastVersion : 0;
  if (last >= room.version) {
    return { kind: "sync-ack", version: room.version };
  }
  // Oldest version still retained in the rolling window. When opLog is empty
  // the only safe `minLogVer` is `version + 1` (nothing replayable), which
  // forces `truncated` for any client that is behind.
  const minLogVer = room.opLog[0]?.version ?? room.version + 1;
  if (last + 1 >= minLogVer) {
    const changes = room.opLog.filter((e) => e.version > last).map((e) => e.ops);
    return { kind: "replay", changes, version: room.version };
  }
  return { kind: "truncated", version: room.version };
}
