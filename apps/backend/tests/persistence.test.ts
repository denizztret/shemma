import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePersistence } from "../src/persistence";
import { makeRoomState } from "../src/rooms";
import type { RoomState } from "../src/types";

function seedShape(s: RoomState, id: string, name: string) {
  s.store.store[id] = {
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
  s.didrawIndex.set(name, id);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shemma-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// DRW-116 Task 10a: FilePersistence now takes a full filePath (one instance ==
// one room file). Tests below build the path explicitly via `join(dir, "<id>.json")`.
describe("FilePersistence", () => {
  test("load missing returns null", async () => {
    expect(
      await new FilePersistence(join(dir, "none.json")).load("none"),
    ).toBeNull();
  });

  test("save + load round-trip", async () => {
    const p = new FilePersistence(join(dir, "t.json"));
    const s = makeRoomState();
    seedShape(s, "shape:n1", "n1");
    s.version = 3;
    await p.save("t", s);
    const loaded = await p.load("t");
    expect(loaded?.store.store["shape:n1"]).toBeDefined();
    expect(loaded?.version).toBe(3);
    expect(loaded?.didrawIndex.get("n1")).toBe("shape:n1");

    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(`${dir}/t.json`, "utf8");
    const env = JSON.parse(raw);
    expect(env.schemaVersion).toBe(3);
    expect(env.roomId).toBe("t");
    expect(env.elementCount).toBe(1);
  });

  test("opLog persisted, dirty NOT persisted", async () => {
    const p = new FilePersistence(join(dir, "o.json"));
    const s = makeRoomState();
    s.opLog.push({
      ops: { added: {}, updated: {}, removed: {} },
      source: "user",
      version: 1,
      at: 0,
    });
    s.dirty = true;
    await p.save("o", s);
    const l = await p.load("o");
    expect(l?.opLog).toHaveLength(1);
    expect(l?.opLog[0]?.version).toBe(1);
    expect(l?.opLog[0]?.source).toBe("user");
    expect(l?.dirty).toBe(false);
  });

  test("scheduleSave debounces", async () => {
    const p = new FilePersistence(join(dir, "d.json"));
    let writes = 0;
    const orig = p.save.bind(p);
    p.save = async (id, s) => {
      writes++;
      return orig(id, s);
    };
    p.scheduleSave("d", makeRoomState());
    p.scheduleSave("d", makeRoomState());
    await new Promise((r) => setTimeout(r, 50));
    expect(writes).toBe(0);
    await new Promise((r) => setTimeout(r, 320));
    expect(writes).toBe(1);
  });

  test("flushAll writes pending immediately", async () => {
    const p = new FilePersistence(join(dir, "urgent.json"));
    const s = makeRoomState();
    seedShape(s, "shape:n1", "n1");
    p.scheduleSave("urgent", s);
    // sub-debounce — yet flushAll должен записать
    await p.flushAll();
    const loaded = await p.load("urgent");
    expect(loaded?.store.store["shape:n1"]).toBeDefined();
  });

  test("flushIfDirty writes pending state synchronously, clears timer", async () => {
    const p = new FilePersistence(join(dir, "r.json"));
    const s = makeRoomState();
    seedShape(s, "shape:x", "x");
    s.version = 1;

    p.scheduleSave("r", s);
    // before flush — pending exists; file may not yet be on disk
    await p.flushIfDirty("r");

    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(`${dir}/r.json`, "utf8");
    const env = JSON.parse(raw);
    expect(env.version).toBe(1);
    expect(env.store.store["shape:x"]).toBeDefined();
  });

  test("flushIfDirty is idempotent — safe to call without pending", async () => {
    const p = new FilePersistence(join(dir, "nonexistent.json"));
    await p.flushIfDirty("nonexistent");
    // No exception, no file created
    const { existsSync } = await import("node:fs");
    expect(existsSync(`${dir}/nonexistent.json`)).toBe(false);
  });
});
