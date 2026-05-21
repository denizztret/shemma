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

// DRW-116 Task 10a: FilePersistence is single-file now. We mint one per (dir, id)
// at the start of each test so the API contract (id-keyed methods) keeps working
// while the underlying instance is bound to a specific file.
let dir: string;

function buildRooms(id: string): { persistence: FilePersistence; rooms: Rooms } {
  const persistence = new FilePersistence(join(dir, `${id}.json`));
  const rooms = new Rooms({
    load: (rid) => persistence.load(rid),
    save: (rid, s) => persistence.save(rid, s),
  });
  rooms.setPersistence(persistence);
  return { persistence, rooms };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shemma-flush-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Rooms.flushIfDirty", () => {
  test("flushes pending autosave synchronously", async () => {
    const { persistence, rooms } = buildRooms("a");
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
    const { rooms } = buildRooms("b");
    await rooms.get("b");
    await rooms.flushIfDirty("b");
    expect(existsSync(join(dir, "b.json"))).toBe(false);
  });
});

describe("Rooms.evict", () => {
  test("removes from in-memory map", async () => {
    const { rooms } = buildRooms("c");
    await rooms.get("c");
    expect(rooms.has("c")).toBe(true);
    await rooms.evict("c");
    expect(rooms.has("c")).toBe(false);
  });

  test("evict flushes pending first (no data loss)", async () => {
    const { persistence, rooms } = buildRooms("d");
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
