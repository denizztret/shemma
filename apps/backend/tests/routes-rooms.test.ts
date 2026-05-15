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

describe("POST /api/rooms/:id/archive", () => {
  test("moves file to .archive/ and evicts from memory", async () => {
    seedRoom("to-archive", (s) => {
      s.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
      s.version = 3;
    });
    const { app } = makeApp({ storageDir: dir });

    await app.fetch(new Request("http://localhost/api/state?room=to-archive"));

    const res = await app.fetch(
      new Request("http://localhost/api/rooms/to-archive/archive", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "to-archive.json"))).toBe(false);
    expect(existsSync(join(dir, ".archive", "to-archive.json"))).toBe(true);
  });

  test("404 if room file does not exist", async () => {
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/no-such/archive", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });

  test("422 on path-param injection attempts", async () => {
    const { app } = makeApp({ storageDir: dir });
    for (const badId of ["..%2Fetc", "name%20with%20space", "name!"]) {
      const res = await app.fetch(
        new Request(`http://localhost/api/rooms/${badId}/archive`, {
          method: "POST",
        }),
      );
      expect(res.status).toBe(422);
    }
  });

  test("flushes dirty state before archiving", async () => {
    const { app, rooms, persistence } = makeApp({ storageDir: dir });
    const r = await rooms.get("dirty-room");
    r.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
    r.version = 5;
    r.dirty = true;
    persistence!.scheduleSave("dirty-room", r);

    const res = await app.fetch(
      new Request("http://localhost/api/rooms/dirty-room/archive", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);

    const { readFileSync } = await import("node:fs");
    const env = JSON.parse(
      readFileSync(join(dir, ".archive", "dirty-room.json"), "utf8"),
    );
    expect(env.version).toBe(5);
    expect(env.elementCount).toBe(1);
  });
});

describe("POST /api/rooms/:id/restore", () => {
  test("moves file back from .archive/", async () => {
    seedRoom("to-archive", () => {});
    const { app } = makeApp({ storageDir: dir });

    await app.fetch(
      new Request("http://localhost/api/rooms/to-archive/archive", {
        method: "POST",
      }),
    );
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/to-archive/restore", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "to-archive.json"))).toBe(true);
    expect(existsSync(join(dir, ".archive", "to-archive.json"))).toBe(false);
  });

  test("404 if not archived", async () => {
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/none/restore", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });

  test("409 if active id already exists", async () => {
    seedRoom("conflict", () => {});
    const { app } = makeApp({ storageDir: dir });

    await app.fetch(
      new Request("http://localhost/api/rooms/conflict/archive", {
        method: "POST",
      }),
    );
    seedRoom("conflict", () => {});

    const res = await app.fetch(
      new Request("http://localhost/api/rooms/conflict/restore", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(409);
  });
});

describe("POST /api/rooms/:id/export", () => {
  test("writes envelope with exportedAt to target path", async () => {
    seedRoom("design", (s) => {
      s.canvas.nodes.push({ id: "n1", kind: "rect", x: 1, y: 2 });
      s.version = 4;
    });
    const { app } = makeApp({ storageDir: dir });
    const target = join(dir, "..", "design-export.json");

    const res = await app.fetch(
      new Request("http://localhost/api/rooms/design/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: target }),
      }),
    );
    expect(res.status).toBe(200);

    const { readFileSync } = await import("node:fs");
    const env = JSON.parse(readFileSync(target, "utf8"));
    expect(env.schemaVersion).toBe(1);
    expect(env.roomId).toBe("design");
    expect(env.version).toBe(4);
    expect(env.elementCount).toBe(1);
    expect(typeof env.exportedAt).toBe("string");
    expect(env.canvas.nodes[0].id).toBe("n1");

    rmSync(target, { force: true });
  });

  test("flushes dirty room before export", async () => {
    const { app, rooms, persistence } = makeApp({ storageDir: dir });
    const r = await rooms.get("dirty");
    r.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
    r.version = 99;
    r.dirty = true;
    persistence!.scheduleSave("dirty", r);

    const target = join(dir, "..", "dirty-export.json");
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/dirty/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: target }),
      }),
    );
    expect(res.status).toBe(200);

    const { readFileSync } = await import("node:fs");
    const env = JSON.parse(readFileSync(target, "utf8"));
    expect(env.version).toBe(99);

    rmSync(target, { force: true });
  });

  test("404 on non-existent room", async () => {
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/nope/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "/tmp/nope.json" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("400 if body missing `to`", async () => {
    seedRoom("r", () => {});
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/r/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
  });
});
