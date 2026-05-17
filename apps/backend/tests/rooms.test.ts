import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePersistence } from "../src/persistence";
import { Rooms, makeRoomState } from "../src/rooms";

function seedShape(state: ReturnType<typeof makeRoomState>, id: string, name: string) {
  state.store.store[id] = {
    id,
    typeName: "shape",
    type: "geo",
    x: 0,
    y: 0,
    parentId: "page:page",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { w: 100, h: 60, geo: "rectangle" },
    meta: { didrawName: name },
  };
  state.didrawIndex.set(name, id);
}

describe("Rooms", () => {
  let rooms: Rooms;
  beforeEach(() => {
    rooms = new Rooms({ load: async () => null, save: async () => {} });
  });

  test("get returns fresh empty room", async () => {
    const r = await rooms.get("a");
    expect(r.store.store["document:document"]).toBeDefined();
    expect(r.store.store["page:page"]).toBeDefined();
    expect(r.version).toBe(0);
  });

  test("different ids isolated", async () => {
    const a = await rooms.get("a");
    const b = await rooms.get("b");
    seedShape(a, "shape:x", "x");
    const bShapes = Object.values(b.store.store).filter((r) => r.typeName === "shape");
    expect(bShapes.length).toBe(0);
  });

  test("same id returns same instance", async () => {
    const r1 = await rooms.get("a");
    const r2 = await rooms.get("a");
    expect(r1).toBe(r2);
  });

  test("loads from store if available", async () => {
    const preset = makeRoomState();
    seedShape(preset, "shape:pre", "pre");
    const r2 = new Rooms({
      load: async (id) => (id === "x" ? preset : null),
      save: async () => {},
    });
    const r = await r2.get("x");
    const shapes = Object.values(r.store.store).filter((rec) => rec.typeName === "shape");
    expect(shapes.length).toBe(1);
    expect(r.didrawIndex.get("pre")).toBe("shape:pre");
  });

  test("get retries after store.load throws (no permanent loading lock)", async () => {
    let attempts = 0;
    const r2 = new Rooms({
      load: async () => {
        attempts++;
        if (attempts === 1) throw new Error("simulated IO failure");
        return null;
      },
      save: async () => {},
    });
    await expect(r2.get("a")).rejects.toThrow("simulated IO failure");
    // First load failed; second attempt must NOT see the cached rejection.
    const r = await r2.get("a");
    expect(attempts).toBe(2);
    expect(r.store.store["document:document"]).toBeDefined();
  });

  test("evictIdle flushes pending debounce and removes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "didraw-evict-"));
    try {
      const persistence = new FilePersistence(dir);
      const r2 = new Rooms({
        load: (id) => persistence.load(id),
        save: (id, s) => persistence.save(id, s),
      });
      r2.setPersistence(persistence);

      const r = await r2.get("a");
      seedShape(r, "shape:n1", "n1");
      r.version = 1;
      r.dirty = true;
      r.lastTouched = Date.now() - 10_000;
      persistence.scheduleSave("a", r);

      const n = await r2.evictIdle(5_000);
      expect(n).toBe(1);
      expect(r2.has("a")).toBe(false);

      const { existsSync, readFileSync } = await import("node:fs");
      expect(existsSync(join(dir, "a.json"))).toBe(true);
      const env = JSON.parse(readFileSync(join(dir, "a.json"), "utf8"));
      expect(env.version).toBe(1);
      expect(env.elementCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("evictIdle cancels pending debounce (no double-write after flushAll)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "didraw-evict-cancel-"));
    try {
      const persistence = new FilePersistence(dir);
      const r2 = new Rooms({
        load: (id) => persistence.load(id),
        save: (id, s) => persistence.save(id, s),
      });
      r2.setPersistence(persistence);

      const r = await r2.get("a");
      seedShape(r, "shape:n1", "n1");
      r.version = 1;
      r.dirty = true;
      r.lastTouched = Date.now() - 10_000;
      persistence.scheduleSave("a", r);

      await r2.evictIdle(5_000);

      // Capture mtime, then flushAll — second write would bump mtime.
      const { statSync } = await import("node:fs");
      const path = join(dir, "a.json");
      const mtime1 = statSync(path).mtimeMs;
      await new Promise((res) => setTimeout(res, 10));
      await persistence.flushAll();
      const mtime2 = statSync(path).mtimeMs;
      expect(mtime2).toBe(mtime1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
