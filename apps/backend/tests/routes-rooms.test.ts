import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp } from "../src/index";
import { serialize } from "../src/envelope";
import { makeRoomState } from "../src/rooms";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "didraw-rt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedRoom(id: string, mutate: (s: ReturnType<typeof makeRoomState>) => void) {
  const s = makeRoomState();
  mutate(s);
  writeFileSync(join(dir, `${id}.json`), serialize(id, s), "utf8");
}

describe("GET /api/rooms", () => {
  test("empty workspace → rooms: []", async () => {
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(new Request("http://localhost/api/rooms"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; rooms: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.rooms).toEqual([]);
  });

  test("lists existing files with envelope metadata", async () => {
    seedRoom("design-v1", (s) => {
      s.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
      s.version = 7;
    });
    seedRoom("default", (s) => {
      s.version = 0;
    });

    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(new Request("http://localhost/api/rooms"));
    const body = (await res.json()) as {
      ok: boolean;
      rooms: Array<{
        id: string;
        version: number;
        elementCount: number;
        lastTouched: string;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.rooms).toHaveLength(2);

    const v1 = body.rooms.find((r) => r.id === "design-v1");
    expect(v1?.version).toBe(7);
    expect(v1?.elementCount).toBe(1);

    const def = body.rooms.find((r) => r.id === "default");
    expect(def?.elementCount).toBe(0);
  });

  test("skips files in .archive/", async () => {
    seedRoom("active", () => {});
    mkdirSync(join(dir, ".archive"));
    seedRoom("archived", () => {});
    const { renameSync } = await import("node:fs");
    renameSync(join(dir, "archived.json"), join(dir, ".archive", "archived.json"));

    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(new Request("http://localhost/api/rooms"));
    const body = (await res.json()) as { rooms: Array<{ id: string }> };
    expect(body.rooms.map((r) => r.id)).toEqual(["active"]);
  });

  test("skips malformed files (logs but doesn't crash)", async () => {
    writeFileSync(join(dir, "broken.json"), "not json", "utf8");
    seedRoom("good", () => {});
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(new Request("http://localhost/api/rooms"));
    const body = (await res.json()) as { rooms: Array<{ id: string }> };
    expect(body.rooms.map((r) => r.id)).toEqual(["good"]);
  });
});
