import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp } from "../src/index";
import type { RoomState } from "../src/types";

// Spec §4.2 (workspace isolation): a backend's visibility of rooms is bounded
// by the directory passed via `storageDir`. Two daemons pointed at the same
// directory share rooms; pointed at different directories they cannot see
// each other's data. Verifies the FilePersistence(dir) wiring through makeApp.

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

function shapesOf(s: RoomState): unknown[] {
  return Object.values(s.store.store).filter((r) => r.typeName === "shape");
}

describe("workspace isolation", () => {
  let dir1: string;
  let dir2: string;

  beforeEach(() => {
    dir1 = mkdtempSync(join(tmpdir(), "shemma-iso-1-"));
    dir2 = mkdtempSync(join(tmpdir(), "shemma-iso-2-"));
  });

  afterEach(() => {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });

  test("two daemons with SAME storageDir see same rooms", async () => {
    const a = makeApp({ storageDir: dir1 });
    const b = makeApp({ storageDir: dir1 });

    // a writes
    const r1 = await a.rooms.get("shared");
    seedShape(r1, "shape:e_a", "a");
    r1.dirty = true;
    r1.version = 1;
    a.persistence?.scheduleSave("shared", r1);
    await a.rooms.flushIfDirty("shared");

    // b force-reads from disk (in case it had a cached empty state)
    await b.rooms.evict("shared");
    const r2 = await b.rooms.get("shared");

    expect(shapesOf(r2)).toHaveLength(1);
    expect(r2.didrawIndex.get("a")).toBe("shape:e_a");
  });

  test("two daemons with DIFFERENT storageDir are isolated", async () => {
    const a = makeApp({ storageDir: dir1 });
    const b = makeApp({ storageDir: dir2 });

    const r1 = await a.rooms.get("isolated");
    seedShape(r1, "shape:e_x", "x");
    r1.dirty = true;
    r1.version = 1;
    a.persistence?.scheduleSave("isolated", r1);
    await a.rooms.flushIfDirty("isolated");

    // b reads the room from its own (empty) directory — must NOT see a's data.
    const r2 = await b.rooms.get("isolated");

    expect(shapesOf(r2)).toHaveLength(0);
  });
});
