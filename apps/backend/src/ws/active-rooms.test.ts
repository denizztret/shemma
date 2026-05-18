import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ActiveRoomsTracker } from "./active-rooms";

describe("ActiveRoomsTracker", () => {
  let t: ActiveRoomsTracker;
  let now: number;

  beforeEach(() => {
    now = 1_700_000_000_000;
    t = new ActiveRoomsTracker({ idleTimeoutMs: 30_000, now: () => now });
  });

  afterEach(() => t.stop());

  it("adds room when client focuses", () => {
    t.onFocus("room-a", "client-1");
    expect(t.list()).toEqual([
      { room: "room-a", clientCount: 1, lastFocusedAt: 1_700_000_000_000 },
    ]);
  });

  it("counts multiple clients on same room", () => {
    t.onFocus("room-a", "client-1");
    now += 1000;
    t.onFocus("room-a", "client-2");
    expect(t.list()[0].clientCount).toBe(2);
    expect(t.list()[0].lastFocusedAt).toBe(1_700_000_001_000);
  });

  it("removes client on blur; entry stays if other clients remain", () => {
    t.onFocus("room-a", "client-1");
    t.onFocus("room-a", "client-2");
    t.onBlur("room-a", "client-1");
    expect(t.list()[0].clientCount).toBe(1);
  });

  it("removes entry immediately when last client blurs", () => {
    t.onFocus("room-a", "client-1");
    t.onBlur("room-a", "client-1");
    expect(t.list()).toEqual([]);
  });

  it("removes entry after idle timeout when client disconnects without blur", () => {
    t.onFocus("room-a", "client-1");
    t.onDisconnect("client-1");
    expect(t.list()).toEqual([]); // disconnect counts as immediate blur
  });

  it("sorts list by lastFocusedAt desc", () => {
    t.onFocus("room-a", "client-1");
    now += 1000;
    t.onFocus("room-b", "client-2");
    expect(t.list().map((r) => r.room)).toEqual(["room-b", "room-a"]);
  });

  it("room switch: blur old, focus new", () => {
    t.onFocus("room-a", "client-1");
    t.onBlur("room-a", "client-1");
    now += 500;
    t.onFocus("room-b", "client-1");
    expect(t.list().map((r) => r.room)).toEqual(["room-b"]);
  });
});
