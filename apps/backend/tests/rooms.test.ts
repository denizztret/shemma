import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePersistence } from "../src/persistence";
import { Rooms, makeRoomState } from "../src/rooms";
import { __resetConfigForTests } from "../src/config";

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

describe("Rooms — linkedSession", () => {
  test("linkedSession auto-set when CLAUDE_SESSION_ID === roomId", async () => {
    process.env.CLAUDE_SESSION_ID = "my-session";
    __resetConfigForTests();
    try {
      const r = new Rooms({ load: async () => null, save: async () => {} });
      const s = await r.get("my-session");
      expect(s.linkedSession).toBe("my-session");
      expect(s.dirty).toBe(true);
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      __resetConfigForTests();
    }
  });

  test("linkedSession NOT set when CLAUDE_SESSION_ID differs from roomId", async () => {
    process.env.CLAUDE_SESSION_ID = "other-session";
    __resetConfigForTests();
    try {
      const r = new Rooms({ load: async () => null, save: async () => {} });
      const s = await r.get("some-other-room");
      expect(s.linkedSession).toBeUndefined();
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      __resetConfigForTests();
    }
  });

  test("linkedSession NOT set when CLAUDE_SESSION_ID not present", async () => {
    delete process.env.CLAUDE_SESSION_ID;
    __resetConfigForTests();
    try {
      const r = new Rooms({ load: async () => null, save: async () => {} });
      const s = await r.get("any-room");
      expect(s.linkedSession).toBeUndefined();
    } finally {
      __resetConfigForTests();
    }
  });

  test("linkedSession not overwritten if already set in loaded state", async () => {
    process.env.CLAUDE_SESSION_ID = "loaded-session";
    __resetConfigForTests();
    try {
      const existing = makeRoomState();
      existing.linkedSession = "original-link";
      const r = new Rooms({ load: async () => existing, save: async () => {} });
      const s = await r.get("loaded-session");
      // Should preserve original, not overwrite with "loaded-session"
      expect(s.linkedSession).toBe("original-link");
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      __resetConfigForTests();
    }
  });

  test("linkedSession survives persistence roundtrip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shemma-linked-"));
    try {
      process.env.CLAUDE_SESSION_ID = "persist-session";
      __resetConfigForTests();

      const persistence = new FilePersistence(join(dir, "persist-session.json"));
      const r = new Rooms({
        load: (id) => persistence.load(id),
        save: (id, s) => persistence.save(id, s),
      });
      r.setPersistence(persistence);

      // Get creates room, sets linkedSession, marks dirty
      const s = await r.get("persist-session");
      expect(s.linkedSession).toBe("persist-session");

      // Flush to disk
      await persistence.flushIfDirty("persist-session");

      // Evict from memory
      await r.evict("persist-session");
      expect(r.has("persist-session")).toBe(false);

      // Reload from disk
      const s2 = await r.get("persist-session");
      expect(s2.linkedSession).toBe("persist-session");
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      __resetConfigForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
    const dir = mkdtempSync(join(tmpdir(), "shemma-evict-"));
    try {
      const persistence = new FilePersistence(join(dir, "a.json"));
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
    const dir = mkdtempSync(join(tmpdir(), "shemma-evict-cancel-"));
    try {
      const persistence = new FilePersistence(join(dir, "a.json"));
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
