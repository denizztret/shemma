import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePersistence } from "../src/persistence";
import { makeRoomState } from "../src/rooms";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "didraw-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("FilePersistence", () => {
  test("load missing returns null", async () => {
    expect(await new FilePersistence(dir).load("none")).toBeNull();
  });

  test("save + load round-trip", async () => {
    const p = new FilePersistence(dir);
    const s = makeRoomState();
    s.canvas.nodes.push({ id: "n1", kind: "rect", x: 5, y: 10 });
    s.version = 3;
    await p.save("t", s);
    const loaded = await p.load("t");
    expect(loaded?.canvas.nodes[0].id).toBe("n1");
    expect(loaded?.version).toBe(3);

    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(`${dir}/t.json`, "utf8");
    const env = JSON.parse(raw);
    expect(env.schemaVersion).toBe(1);
    expect(env.roomId).toBe("t");
    expect(env.elementCount).toBe(1);
  });

  test("opLog and dirty NOT persisted", async () => {
    const p = new FilePersistence(dir);
    const s = makeRoomState();
    s.opLog.push({ ops: [], source: "user", version: 1, at: 0 });
    s.dirty = true;
    await p.save("o", s);
    const l = await p.load("o");
    expect(l?.opLog).toEqual([]);
    expect(l?.dirty).toBe(false);
  });

  test("scheduleSave debounces", async () => {
    const p = new FilePersistence(dir);
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
    const p = new FilePersistence(dir);
    const s = makeRoomState();
    s.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
    p.scheduleSave("urgent", s);
    // sub-debounce — yet flushAll должен записать
    await p.flushAll();
    const loaded = await p.load("urgent");
    expect(loaded?.canvas.nodes[0].id).toBe("n1");
  });

  test("flushIfDirty writes pending state synchronously, clears timer", async () => {
    const p = new FilePersistence(dir);
    const s = makeRoomState();
    s.canvas.nodes.push({ id: "x", kind: "rect", x: 0, y: 0 });
    s.version = 1;

    p.scheduleSave("r", s);
    // before flush — pending exists; file may not yet be on disk
    await p.flushIfDirty("r");

    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(`${dir}/r.json`, "utf8");
    const env = JSON.parse(raw);
    expect(env.version).toBe(1);
    expect(env.canvas.nodes[0].id).toBe("x");
  });

  test("flushIfDirty is idempotent — safe to call without pending", async () => {
    const p = new FilePersistence(dir);
    await p.flushIfDirty("nonexistent");
    // No exception, no file created
    const { existsSync } = await import("node:fs");
    expect(existsSync(`${dir}/nonexistent.json`)).toBe(false);
  });
});
