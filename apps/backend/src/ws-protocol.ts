import type { RoomState, WsClientMessage, WsMessage } from "./types";

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
  const obj = parsed as { kind?: unknown; lastVersion?: unknown };
  if (
    obj.kind === "hello" &&
    typeof obj.lastVersion === "number" &&
    Number.isFinite(obj.lastVersion)
  ) {
    return { kind: "hello", lastVersion: obj.lastVersion };
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
    const ops = room.opLog.filter((e) => e.version > last);
    return { kind: "replay", ops, version: room.version };
  }
  return { kind: "truncated", version: room.version };
}
