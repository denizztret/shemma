import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp } from "../src/index";
import { serialize } from "../src/envelope";
import { makeRoomState } from "../src/rooms";
import type { RoomState } from "../src/types";

// I3 + I5 (Phase 2.0 follow-ups): on 409 the import handler must not touch the
// existing target file and must return its id so callers can decide how to
// retry (force vs different `as`).

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shemma-imp409-"));
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

function seedRoom(
  id: string,
  mutate: (s: ReturnType<typeof makeRoomState>) => void,
) {
  const s = makeRoomState();
  mutate(s);
  writeFileSync(join(dir, `${id}.json`), serialize(id, s), "utf8");
}

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

describe("POST /api/rooms/import — 409 semantics", () => {
  test("returns existingId and leaves target file untouched", async () => {
    // Seed a target room with distinguishable content.
    seedRoom("existing", (s) => {
      seedShape(s, "shape:e_a", "a");
      s.version = 13;
    });
    // Seed and export a source room (the would-be import payload).
    seedRoom("source", (s) => {
      seedShape(s, "shape:e_b", "b");
      s.version = 99;
    });
    const exported = join(dir, "..", "imp-409-existingid.json");
    await exportRoom("source", exported);

    const targetPath = join(dir, "existing.json");
    const before = readFileSync(targetPath, "utf8");

    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: exported, as: "existing" }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      existingId: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("room exists");
    expect(body.existingId).toBe("existing");

    // Target file must be byte-equivalent to its pre-import state.
    const after = readFileSync(targetPath, "utf8");
    expect(after).toBe(before);

    rmSync(exported, { force: true });
  });
});
