import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePersistence } from "../src/persistence";
import { Rooms } from "../src/rooms";
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
let persistence: FilePersistence;
let rooms: Rooms;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shemma-flush-"));
  persistence = new FilePersistence(dir);
  rooms = new Rooms({
    load: (id) => persistence.load(id),
    save: (id, s) => persistence.save(id, s),
  });
  rooms.setPersistence(persistence);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Rooms.flushIfDirty", () => {
  test("flushes pending autosave synchronously", async () => {
    const r = await rooms.get("a");
    seedShape(r, "shape:n1", "n1");
    r.dirty = true;
    r.version = 1;
    persistence.scheduleSave("a", r);

    await rooms.flushIfDirty("a");

    expect(existsSync(join(dir, "a.json"))).toBe(true);
    const { readFileSync } = await import("node:fs");
    const env = JSON.parse(readFileSync(join(dir, "a.json"), "utf8"));
    expect(env.version).toBe(1);
    expect(env.elementCount).toBe(1);
  });

  test("idempotent: flushIfDirty on clean room is no-op", async () => {
    await rooms.get("b");
    await rooms.flushIfDirty("b");
    expect(existsSync(join(dir, "b.json"))).toBe(false);
  });
});

describe("Rooms.evict", () => {
  test("removes from in-memory map", async () => {
    await rooms.get("c");
    expect(rooms.has("c")).toBe(true);
    await rooms.evict("c");
    expect(rooms.has("c")).toBe(false);
  });

  test("evict flushes pending first (no data loss)", async () => {
    const r = await rooms.get("d");
    seedShape(r, "shape:n1", "n1");
    r.dirty = true;
    r.version = 5;
    persistence.scheduleSave("d", r);

    await rooms.evict("d");

    expect(rooms.has("d")).toBe(false);
    const { readFileSync } = await import("node:fs");
    const env = JSON.parse(readFileSync(join(dir, "d.json"), "utf8"));
    expect(env.version).toBe(5);
  });
});
