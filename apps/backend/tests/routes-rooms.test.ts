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

  test("restore evicts stale in-memory state from prior GETs", async () => {
    seedRoom("loaded", (s) => {
      s.canvas.nodes.push({ id: "preserved", kind: "rect", x: 0, y: 0 });
      s.version = 9;
    });
    const { app } = makeApp({ storageDir: dir });

    // Archive — file moves to .archive, memory cleared.
    await app.fetch(new Request("http://localhost/api/rooms/loaded/archive", {
      method: "POST",
    }));

    // GET while archived — loads empty state into memory map (file not found).
    const statePreRestore = await app.fetch(
      new Request("http://localhost/api/state?room=loaded"),
    );
    const body1 = (await statePreRestore.json()) as { canvas: { nodes: unknown[] } };
    expect(body1.canvas.nodes).toEqual([]);

    // Restore — file comes back to disk.
    const restRes = await app.fetch(
      new Request("http://localhost/api/rooms/loaded/restore", {
        method: "POST",
      }),
    );
    expect(restRes.status).toBe(200);

    // GET after restore — must see the original "preserved" node, NOT the
    // empty in-memory state loaded between archive and restore.
    const statePostRestore = await app.fetch(
      new Request("http://localhost/api/state?room=loaded"),
    );
    const body2 = (await statePostRestore.json()) as {
      canvas: { nodes: Array<{ id: string }> };
      version: number;
    };
    expect(body2.canvas.nodes[0]?.id).toBe("preserved");
    expect(body2.version).toBe(9);
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

describe("POST /api/rooms/import", () => {
  async function exportRoom(srcId: string, target: string) {
    const { app } = makeApp({ storageDir: dir });
    await app.fetch(
      new Request(`http://localhost/api/rooms/${srcId}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: target }),
      }),
    );
  }

  test("imports to specified id with byte-equivalent canvas", async () => {
    seedRoom("source", (s) => {
      s.canvas.nodes.push({ id: "n1", kind: "rect", x: 1, y: 2 });
      s.version = 7;
    });
    const exported = join(dir, "..", "imp-source.json");
    await exportRoom("source", exported);

    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: exported, as: "imported" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; roomId: string };
    expect(body.roomId).toBe("imported");

    const stateRes = await app.fetch(
      new Request("http://localhost/api/state?room=imported"),
    );
    const stateBody = (await stateRes.json()) as {
      canvas: { nodes: Array<{ id: string }> };
      version: number;
    };
    expect(stateBody.canvas.nodes[0].id).toBe("n1");
    expect(stateBody.version).toBe(7);

    rmSync(exported, { force: true });
  });

  test("409 on existing target without force", async () => {
    seedRoom("target", () => {});
    seedRoom("source", () => {});
    const exported = join(dir, "..", "imp-noforce.json");
    await exportRoom("source", exported);

    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: exported, as: "target" }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toMatch(/exists/);

    rmSync(exported, { force: true });
  });

  test("overwrites with force=true (flushes evicts target)", async () => {
    seedRoom("target", (s) => {
      s.canvas.nodes.push({ id: "old", kind: "rect", x: 0, y: 0 });
    });
    seedRoom("source", (s) => {
      s.canvas.nodes.push({ id: "new", kind: "rect", x: 0, y: 0 });
      s.version = 42;
    });
    const exported = join(dir, "..", "imp-force.json");
    await exportRoom("source", exported);

    const { app } = makeApp({ storageDir: dir });
    await app.fetch(new Request("http://localhost/api/state?room=target"));

    const res = await app.fetch(
      new Request("http://localhost/api/rooms/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: exported, as: "target", force: true }),
      }),
    );
    expect(res.status).toBe(200);

    const stateRes = await app.fetch(
      new Request("http://localhost/api/state?room=target"),
    );
    const stateBody = (await stateRes.json()) as {
      canvas: { nodes: Array<{ id: string }> };
    };
    expect(stateBody.canvas.nodes[0].id).toBe("new");

    rmSync(exported, { force: true });
  });

  test("422 on schemaVersion mismatch", async () => {
    const badPath = join(dir, "..", "bad-schema.json");
    writeFileSync(
      badPath,
      JSON.stringify({
        schemaVersion: 999,
        roomId: "x",
        version: 0,
        lastTouched: "2026-01-01T00:00:00Z",
        elementCount: 0,
        canvas: { version: 1, nodes: [], edges: [], groups: [] },
        prompts: [],
      }),
      "utf8",
    );

    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: badPath, as: "x" }),
      }),
    );
    expect(res.status).toBe(422);

    rmSync(badPath, { force: true });
  });
});

describe("DELETE /api/rooms/:id", () => {
  test("requires confirm:true", async () => {
    seedRoom("doomed", () => {});
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/doomed", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("removes file with confirm:true", async () => {
    seedRoom("doomed", () => {});
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/doomed", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );
    expect(res.status).toBe(200);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "doomed.json"))).toBe(false);
  });

  test("no autosave overwrite after delete", async () => {
    const { app, rooms, persistence } = makeApp({ storageDir: dir });
    const r = await rooms.get("ghost");
    r.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
    r.dirty = true;
    r.version = 1;
    persistence!.scheduleSave("ghost", r);

    await app.fetch(
      new Request("http://localhost/api/rooms/ghost", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );

    await new Promise((res) => setTimeout(res, 400));

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "ghost.json"))).toBe(false);
  });
});
