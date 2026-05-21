import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetRoomCacheForTests, makeApp } from "../index";

/**
 * DRW-116 Task 11 — multi-space HTTP route isolation invariant.
 *
 * Two `?space=A` and `?space=B` requests against the SAME daemon (one
 * `makeApp`, `enableSpaceMiddleware: true`) must not leak in-memory `Rooms`
 * state nor write into each other's storage path. The bug this guards against
 * was the per-`makeApp` single `Rooms` instance + closure-captured legacy
 * `SingleSpacePersistence` — pre-Task-11 every `?space=…` request collapsed
 * into the same memory + same on-disk file regardless of which space was
 * requested.
 *
 * The test isolates `XDG_CONFIG_HOME` so the spaces registry doesn't touch
 * the user's real `~/.config/shemma/spaces.json`.
 */

let tmpXdg: string;
let dirA: string;
let dirB: string;
let origXdg: string | undefined;

beforeEach(() => {
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "multi-space-xdg-"));
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), "multi-space-A-"));
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), "multi-space-B-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpXdg;
  // Each test gets a fresh RoomCache so per-(space, room) FilePersistence
  // doesn't bleed across cases via the daemon-wide singleton.
  __resetRoomCacheForTests();
});

afterEach(() => {
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  fs.rmSync(tmpXdg, { recursive: true, force: true });
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
  __resetRoomCacheForTests();
});

async function registerSpace(
  app: ReturnType<typeof makeApp>["app"],
  pathStr: string,
  label: string,
): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: pathStr, label }),
    }),
  );
  const body = (await res.json()) as { space: { id: string } };
  return body.space.id;
}

async function postDomain(
  app: ReturnType<typeof makeApp>["app"],
  space: string,
  room: string,
  actions: unknown[],
): Promise<{ status: number; body: unknown }> {
  const res = await app.fetch(
    new Request(`http://localhost/api/domain?space=${space}&room=${room}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actions, layoutHint: null }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

async function getState(
  app: ReturnType<typeof makeApp>["app"],
  space: string,
  room: string,
): Promise<{
  status: number;
  body: {
    version: number;
    store?: {
      store: Record<
        string,
        { typeName?: string; meta?: { didrawName?: string } }
      >;
    };
  };
}> {
  const res = await app.fetch(
    new Request(`http://localhost/api/state?space=${space}&room=${room}`),
  );
  return { status: res.status, body: await res.json() };
}

describe("DRW-116 Task 11 — multi-space HTTP route isolation", () => {
  it("two spaces with the same room id keep independent in-memory state", async () => {
    const { app } = makeApp({ enableSpaceMiddleware: true });
    const idA = await registerSpace(app, dirA, "A");
    const idB = await registerSpace(app, dirB, "B");
    expect(idA).not.toBe(idB);

    // Mutate state in space A — define a shape named "shape-a".
    const mutA = await postDomain(app, idA, "test", [
      { kind: "define", role: "service", name: "shape-a" },
    ]);
    expect(mutA.status).toBe(200);

    // Read state from space B for the same room id — must NOT see shape-a.
    const stB = await getState(app, idB, "test");
    expect(stB.status).toBe(200);
    const shapesInB = Object.values(stB.body.store?.store ?? {}).filter(
      (r) =>
        r.typeName === "shape" &&
        (r as { meta?: { didrawName?: string } }).meta?.didrawName ===
          "shape-a",
    );
    expect(shapesInB).toHaveLength(0);

    // Conversely, space A still has shape-a.
    const stA = await getState(app, idA, "test");
    const shapesInA = Object.values(stA.body.store?.store ?? {}).filter(
      (r) =>
        r.typeName === "shape" &&
        (r as { meta?: { didrawName?: string } }).meta?.didrawName ===
          "shape-a",
    );
    expect(shapesInA).toHaveLength(1);
  });

  it("two spaces write to their own storage paths", async () => {
    const { app } = makeApp({ enableSpaceMiddleware: true });
    const idA = await registerSpace(app, dirA, "A");
    const idB = await registerSpace(app, dirB, "B");

    // Mutate only space A.
    const mutA = await postDomain(app, idA, "isolation", [
      { kind: "define", role: "service", name: "only-in-a" },
    ]);
    expect(mutA.status).toBe(200);

    // Flush A so the room file actually lands on disk.
    await app.fetch(
      new Request(`http://localhost/api/rooms/isolation/archive?space=${idA}`, {
        method: "POST",
      }),
    );

    // Storage root for A uses the `project` layout (default for new spaces),
    // i.e. `<dir>/.shemma/canvas` per `resolveStorageRoot`. The room file
    // should now live in A's archive directory.
    const aArchive = path.join(dirA, ".shemma", "canvas", ".archive");
    const bArchive = path.join(dirB, ".shemma", "canvas", ".archive");
    const filesInA = fs.existsSync(aArchive) ? fs.readdirSync(aArchive) : [];
    const filesInB = fs.existsSync(bArchive) ? fs.readdirSync(bArchive) : [];
    expect(filesInA).toContain("isolation.json");
    expect(filesInB).not.toContain("isolation.json");
  });

  it("400 when ?space= missing on a non-allowlisted route", async () => {
    const { app } = makeApp({ enableSpaceMiddleware: true });
    const res = await app.fetch(
      new Request("http://localhost/api/state?room=foo"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("space_required");
  });

  it("404 when ?space=<unregistered>", async () => {
    const { app } = makeApp({ enableSpaceMiddleware: true });
    const res = await app.fetch(
      new Request("http://localhost/api/state?space=ghost&room=foo"),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("space_not_found");
  });
});
