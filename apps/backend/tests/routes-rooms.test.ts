import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp } from "../src/index";
import { serialize } from "../src/envelope";
import { makeRoomState } from "../src/rooms";
import type { RoomState } from "../src/types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "didraw-rt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

function seedRoom(id: string, mutate: (s: ReturnType<typeof makeRoomState>) => void) {
  const s = makeRoomState();
  mutate(s);
  writeFileSync(join(dir, `${id}.json`), serialize(id, s), "utf8");
}

function shapesOf(state: { store: { store: Record<string, { typeName: string }> } }) {
  return Object.values(state.store.store).filter((r) => r.typeName === "shape");
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
      seedShape(s, "shape:n1", "n1");
      s.version = 7;
    });
    seedRoom("def", (s) => {
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

    const def = body.rooms.find((r) => r.id === "def");
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

  test("ignores filenames that fail validateRoomId", async () => {
    // Filenames containing chars outside [a-zA-Z0-9_-] must be skipped before
    // any read attempt — guards against accidental path-traversal listings.
    writeFileSync(join(dir, "bad name.json"), "{}", "utf8");
    writeFileSync(join(dir, "with!bang.json"), "{}", "utf8");
    seedRoom("ok", () => {});
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(new Request("http://localhost/api/rooms"));
    const body = (await res.json()) as { rooms: Array<{ id: string }> };
    expect(body.rooms.map((r) => r.id)).toEqual(["ok"]);
  });

  test("?include=archived joins active + archived items, archived have archived:true", async () => {
    seedRoom("active-one", () => {});
    seedRoom("will-archive", () => {});
    mkdirSync(join(dir, ".archive"), { recursive: true });
    const { renameSync } = await import("node:fs");
    renameSync(join(dir, "will-archive.json"), join(dir, ".archive", "will-archive.json"));

    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms?include=archived"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      rooms: Array<{ id: string; archived?: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.rooms).toHaveLength(2);

    const active = body.rooms.find((r) => r.id === "active-one");
    expect(active).toBeDefined();
    expect(active?.archived).toBeUndefined();

    const archived = body.rooms.find((r) => r.id === "will-archive");
    expect(archived).toBeDefined();
    expect(archived?.archived).toBe(true);
  });

  test("?include=archived with empty archive returns only active rooms", async () => {
    seedRoom("only-active", () => {});
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms?include=archived"),
    );
    const body = (await res.json()) as { rooms: Array<{ id: string }> };
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].id).toBe("only-active");
  });

  test("without ?include=archived, archived rooms are not returned", async () => {
    seedRoom("active", () => {});
    mkdirSync(join(dir, ".archive"), { recursive: true });
    seedRoom("archived-hidden", () => {});
    const { renameSync } = await import("node:fs");
    renameSync(join(dir, "archived-hidden.json"), join(dir, ".archive", "archived-hidden.json"));

    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(new Request("http://localhost/api/rooms"));
    const body = (await res.json()) as { rooms: Array<{ id: string }> };
    expect(body.rooms.map((r) => r.id)).toEqual(["active"]);
  });

  test("rooms have projectDir + projectName populated when env set", async () => {
    const { __resetConfigForTests } = await import("../src/config");
    process.env.DIDRAW_PROJECT_DIR = "/home/user/my-project";
    __resetConfigForTests();
    try {
      // Seed a room that already exists on disk without projectDir.
      seedRoom("proj-test", (s) => {
        s.version = 1;
      });

      const { app, rooms, persistence } = makeApp({ storageDir: dir });
      // GET state loads the room (existing file → isNew=false) → auto-populates projectDir.
      await app.fetch(new Request("http://localhost/api/state?room=proj-test"));

      // Flush the pending auto-backfill save.
      await persistence!.flushIfDirty("proj-test");

      // Drop in-memory cache to force re-read from disk.
      await rooms.evict("proj-test");

      const res = await app.fetch(new Request("http://localhost/api/rooms"));
      const body = (await res.json()) as {
        rooms: Array<{ id: string; projectDir?: string; projectName?: string }>;
      };
      const room = body.rooms.find((r) => r.id === "proj-test");
      expect(room?.projectDir).toBe("/home/user/my-project");
      expect(room?.projectName).toBe("my-project");
    } finally {
      delete process.env.DIDRAW_PROJECT_DIR;
      __resetConfigForTests();
    }
  });
});

describe("POST /api/rooms/:id/archive", () => {
  test("moves file to .archive/ and evicts from memory", async () => {
    seedRoom("to-archive", (s) => {
      seedShape(s, "shape:n1", "n1");
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
    seedShape(r, "shape:n1", "n1");
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
      seedShape(s, "shape:preserved", "preserved");
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
    const body1 = (await statePreRestore.json()) as { store: { store: Record<string, unknown> } };
    expect(shapesOf(body1 as { store: { store: Record<string, { typeName: string }> } }).length).toBe(0);

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
      store: { store: Record<string, { typeName: string; meta?: { didrawName?: string } }> };
      version: number;
    };
    const preserved = Object.values(body2.store.store).find(
      (r) => r.typeName === "shape" && r.meta?.didrawName === "preserved",
    );
    expect(preserved).toBeDefined();
    expect(body2.version).toBe(9);
  });
});

describe("POST /api/rooms/:id/export", () => {
  test("writes envelope with exportedAt to target path", async () => {
    seedRoom("design", (s) => {
      seedShape(s, "shape:n1", "n1");
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
    expect(env.schemaVersion).toBe(3);
    expect(env.roomId).toBe("design");
    expect(env.version).toBe(4);
    expect(env.elementCount).toBe(1);
    expect(typeof env.exportedAt).toBe("string");
    expect(env.store.store["shape:n1"]).toBeDefined();

    rmSync(target, { force: true });
  });

  test("flushes dirty room before export", async () => {
    const { app, rooms, persistence } = makeApp({ storageDir: dir });
    const r = await rooms.get("dirty");
    seedShape(r, "shape:n1", "n1");
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
      seedShape(s, "shape:n1", "n1");
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
      store: { store: Record<string, { typeName: string }> };
      version: number;
    };
    expect(stateBody.store.store["shape:n1"]).toBeDefined();
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
      seedShape(s, "shape:old", "old");
    });
    seedRoom("source", (s) => {
      seedShape(s, "shape:new1", "newone");
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
      store: { store: Record<string, { typeName: string; meta?: { didrawName?: string } }> };
    };
    const found = Object.values(stateBody.store.store).find(
      (r) => r.typeName === "shape" && r.meta?.didrawName === "newone",
    );
    expect(found).toBeDefined();

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
        store: { schema: {}, store: {} },
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

  test("default mode (no mode field) archives the file", async () => {
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
    // File moved to archive, not unlinked
    expect(existsSync(join(dir, "doomed.json"))).toBe(false);
    expect(existsSync(join(dir, ".archive", "doomed.json"))).toBe(true);
  });

  test("mode=archive moves file to .archive/", async () => {
    seedRoom("arch-explicit", () => {});
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/arch-explicit", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, mode: "archive" }),
      }),
    );
    expect(res.status).toBe(200);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "arch-explicit.json"))).toBe(false);
    expect(existsSync(join(dir, ".archive", "arch-explicit.json"))).toBe(true);
  });

  test("mode=hard removes file without linked check (no session)", async () => {
    seedRoom("hard-room", () => {});
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/hard-room", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, mode: "hard" }),
      }),
    );
    expect(res.status).toBe(200);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "hard-room.json"))).toBe(false);
  });

  test("no autosave overwrite after hard delete", async () => {
    const { app, rooms, persistence } = makeApp({ storageDir: dir });
    const r = await rooms.get("ghost");
    seedShape(r, "shape:n1", "n1");
    r.dirty = true;
    r.version = 1;
    persistence!.scheduleSave("ghost", r);

    await app.fetch(
      new Request("http://localhost/api/rooms/ghost", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, mode: "hard" }),
      }),
    );

    await new Promise((res) => setTimeout(res, 400));

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "ghost.json"))).toBe(false);
  });

  test("mode=hard on linked room without force → 409", async () => {
    const sessionId = "linked-test-session";
    process.env.CLAUDE_SESSION_ID = sessionId;
    const { __resetConfigForTests } = await import("../src/config");
    __resetConfigForTests();
    try {
      seedRoom(sessionId, (s) => {
        s.linkedSession = sessionId;
      });
      const { app } = makeApp({ storageDir: dir });
      const res = await app.fetch(
        new Request(`http://localhost/api/rooms/${sessionId}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true, mode: "hard" }),
        }),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("linked-to-active-session");
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      __resetConfigForTests();
    }
  });

  test("mode=hard on linked room with force=true → 200, file unlinked", async () => {
    const sessionId = "linked-force-session";
    process.env.CLAUDE_SESSION_ID = sessionId;
    const { __resetConfigForTests } = await import("../src/config");
    __resetConfigForTests();
    try {
      seedRoom(sessionId, (s) => {
        s.linkedSession = sessionId;
      });
      const { app } = makeApp({ storageDir: dir });
      const res = await app.fetch(
        new Request(`http://localhost/api/rooms/${sessionId}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true, mode: "hard", force: true }),
        }),
      );
      expect(res.status).toBe(200);
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(dir, `${sessionId}.json`))).toBe(false);
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      __resetConfigForTests();
    }
  });

  test("mode=hard on linked room with DIFFERENT session → 200 (not blocked)", async () => {
    const linkedSess = "other-session-id";
    const activeSess = "active-session-id";
    process.env.CLAUDE_SESSION_ID = activeSess;
    const { __resetConfigForTests } = await import("../src/config");
    __resetConfigForTests();
    try {
      seedRoom("cross-session-room", (s) => {
        s.linkedSession = linkedSess;
      });
      const { app } = makeApp({ storageDir: dir });
      const res = await app.fetch(
        new Request("http://localhost/api/rooms/cross-session-room", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true, mode: "hard" }),
        }),
      );
      expect(res.status).toBe(200);
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      __resetConfigForTests();
    }
  });

  test("POST /api/rooms/purge-archive without confirm → 422", async () => {
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/purge-archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(422);
  });

  test("POST /api/rooms/purge-archive with confirm → removes archived files", async () => {
    seedRoom("purge-a", () => {});
    seedRoom("purge-b", () => {});
    const { app } = makeApp({ storageDir: dir });

    // Archive both rooms
    await app.fetch(
      new Request("http://localhost/api/rooms/purge-a/archive", { method: "POST" }),
    );
    await app.fetch(
      new Request("http://localhost/api/rooms/purge-b/archive", { method: "POST" }),
    );

    const res = await app.fetch(
      new Request("http://localhost/api/rooms/purge-archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removed: number };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(2);

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, ".archive", "purge-a.json"))).toBe(false);
    expect(existsSync(join(dir, ".archive", "purge-b.json"))).toBe(false);
  });

  test("POST /api/rooms/purge-archive with no archived files → removed:0", async () => {
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/purge-archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removed: number };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(0);
  });
});
