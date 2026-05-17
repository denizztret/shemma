import { describe, expect, it } from "bun:test";
import { handleHello, parseClientMessage } from "../src/ws-protocol";
import type { RoomState } from "../src/types";

function roomWithLog(version: number, logVersions: number[]): RoomState {
  return {
    store: { schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} }, store: {} },
    opLog: logVersions.map((v) => ({ ops: { added: {}, updated: {}, removed: {} }, source: "ai", version: v, at: 0 })),
    prompts: [], version, dirty: false, lastTouched: 0, didrawIndex: new Map(),
  };
}

describe("parseClientMessage", () => {
  it("parses hello", () => {
    expect(parseClientMessage('{"kind":"hello","lastVersion":3}')).toEqual({ kind: "hello", lastVersion: 3 });
  });
  it("rejects garbage", () => {
    expect(parseClientMessage("not-json")).toBeNull();
    expect(parseClientMessage('{"kind":"other"}')).toBeNull();
  });
});

describe("handleHello", () => {
  it("up-to-date → sync-ack", () => {
    const r = roomWithLog(5, [3, 4, 5]);
    expect(handleHello(r, 5)).toEqual({ kind: "sync-ack", version: 5 });
  });
  it("delta within window → replay with changes", () => {
    const r = roomWithLog(5, [3, 4, 5]);
    const m = handleHello(r, 3);
    expect(m.kind).toBe("replay");
    if (m.kind === "replay") {
      expect(m.changes.length).toBe(2); // versions 4, 5
      expect(m.version).toBe(5);
    }
  });
  it("gap beyond window → truncated", () => {
    const r = roomWithLog(10, [8, 9, 10]);
    expect(handleHello(r, 2)).toEqual({ kind: "truncated", version: 10 });
  });
  it("empty opLog with version 0 → sync-ack at 0", () => {
    const r = roomWithLog(0, []);
    expect(handleHello(r, 0)).toEqual({ kind: "sync-ack", version: 0 });
  });
});
