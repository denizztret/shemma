import { beforeEach, describe, expect, test } from "bun:test";
import { Rooms, makeRoomState } from "../src/rooms";

describe("Rooms", () => {
  let rooms: Rooms;
  beforeEach(() => {
    rooms = new Rooms({ load: async () => null, save: async () => {} });
  });

  test("get returns fresh empty room", async () => {
    const r = await rooms.get("a");
    expect(r.canvas.nodes).toEqual([]);
    expect(r.version).toBe(0);
  });

  test("different ids isolated", async () => {
    const a = await rooms.get("a");
    const b = await rooms.get("b");
    a.canvas.nodes.push({ id: "x", kind: "rect", x: 0, y: 0 });
    expect(b.canvas.nodes).toEqual([]);
  });

  test("same id returns same instance", async () => {
    const r1 = await rooms.get("a");
    const r2 = await rooms.get("a");
    expect(r1).toBe(r2);
  });

  test("loads from store if available", async () => {
    const preset = makeRoomState();
    preset.canvas.nodes.push({ id: "pre", kind: "rect", x: 0, y: 0 });
    const rooms = new Rooms({
      load: async (id) => (id === "x" ? preset : null),
      save: async () => {},
    });
    const r = await rooms.get("x");
    expect(r.canvas.nodes[0].id).toBe("pre");
  });

  test("get retries after store.load throws (no permanent loading lock)", async () => {
    let attempts = 0;
    const rooms = new Rooms({
      load: async () => {
        attempts++;
        if (attempts === 1) throw new Error("simulated IO failure");
        return null;
      },
      save: async () => {},
    });
    await expect(rooms.get("a")).rejects.toThrow("simulated IO failure");
    // First load failed; second attempt must NOT see the cached rejection.
    const r = await rooms.get("a");
    expect(attempts).toBe(2);
    expect(r.canvas.nodes).toEqual([]);
  });

  test("evictIdle saves dirty rooms and removes", async () => {
    let saved = 0;
    const rooms = new Rooms({
      load: async () => null,
      save: async () => {
        saved++;
      },
    });
    const r = await rooms.get("a");
    r.dirty = true;
    r.lastTouched = Date.now() - 10_000;
    const n = await rooms.evictIdle(5_000);
    expect(n).toBe(1);
    expect(saved).toBe(1);
    expect(rooms.has("a")).toBe(false);
  });
});
