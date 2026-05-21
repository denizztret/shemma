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
      {
        space: "__legacy__",
        room: "room-a",
        clientCount: 1,
        lastFocusedAt: 1_700_000_000_000,
      },
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

  it("removes entry immediately on disconnect", () => {
    t.onFocus("room-a", "client-1");
    t.onDisconnect("client-1");
    expect(t.list()).toEqual([]);
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

  it("same room id in two spaces lives in separate buckets", () => {
    // DRW-116 Task 11: composite-key ensures two clients focused on the same
    // roomId across different spaces don't collapse into one entry.
    t.onFocus("shared", "client-1", "space-a");
    now += 500;
    t.onFocus("shared", "client-2", "space-b");
    const entries = t.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => `${e.space}:${e.room}`)).toEqual([
      "space-b:shared",
      "space-a:shared",
    ]);
  });

  it("list({ space }) filters to a single space", () => {
    t.onFocus("room-a", "client-1", "space-a");
    t.onFocus("room-b", "client-2", "space-b");
    const onlyA = t.list({ space: "space-a" });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]?.room).toBe("room-a");
    expect(onlyA[0]?.space).toBe("space-a");
  });

  it("client switching across spaces blurs the previous bucket", () => {
    t.onFocus("room-a", "client-1", "space-a");
    expect(t.list({ space: "space-a" })).toHaveLength(1);
    t.onFocus("room-a", "client-1", "space-b");
    // Same client moved to space-b — space-a bucket should be empty again.
    expect(t.list({ space: "space-a" })).toEqual([]);
    expect(t.list({ space: "space-b" })).toHaveLength(1);
  });
});
