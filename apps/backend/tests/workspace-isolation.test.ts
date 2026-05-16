import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp } from "../src/index";

// Spec §4.2 (workspace isolation): a backend's visibility of rooms is bounded
// by the directory passed via `storageDir`. Two daemons pointed at the same
// directory share rooms; pointed at different directories they cannot see
// each other's data. Verifies the FilePersistence(dir) wiring through makeApp.

describe("workspace isolation", () => {
  let dir1: string;
  let dir2: string;

  beforeEach(() => {
    dir1 = mkdtempSync(join(tmpdir(), "didraw-iso-1-"));
    dir2 = mkdtempSync(join(tmpdir(), "didraw-iso-2-"));
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
    r1.canvas.nodes.push({
      id: "shape:e_a",
      kind: "rect",
      x: 0,
      y: 0,
      label: "a",
    });
    r1.dirty = true;
    r1.version = 1;
    a.persistence?.scheduleSave("shared", r1);
    await a.rooms.flushIfDirty("shared");

    // b force-reads from disk (in case it had a cached empty state)
    await b.rooms.evict("shared");
    const r2 = await b.rooms.get("shared");

    expect(r2.canvas.nodes).toHaveLength(1);
    expect(r2.canvas.nodes[0]?.id).toBe("shape:e_a");
  });

  test("two daemons with DIFFERENT storageDir are isolated", async () => {
    const a = makeApp({ storageDir: dir1 });
    const b = makeApp({ storageDir: dir2 });

    const r1 = await a.rooms.get("isolated");
    r1.canvas.nodes.push({
      id: "shape:e_x",
      kind: "rect",
      x: 0,
      y: 0,
      label: "x",
    });
    r1.dirty = true;
    r1.version = 1;
    a.persistence?.scheduleSave("isolated", r1);
    await a.rooms.flushIfDirty("isolated");

    // b reads the room from its own (empty) directory — must NOT see a's data.
    const r2 = await b.rooms.get("isolated");

    expect(r2.canvas.nodes).toHaveLength(0);
  });
});
