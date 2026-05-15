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
});
