// DRW-116 Task 15: regression coverage for the `(space, room)` query shape.
// Every HTTP wrapper must include `space=` so the backend's per-space bundle
// resolver can route the request to the correct room directory.

import { afterEach, describe, expect, test } from "bun:test";
import {
  LEGACY_SPACE_ID,
  archiveRoom,
  deleteRoom,
  duplicateRoom,
  duplicateRoomAuto,
  exportRoom,
  getState,
  listRooms,
  purgeArchive,
  renameRoom,
  restoreRoom,
  seedSchema,
} from "./api";

const originalFetch = globalThis.fetch;

type Captured = { url: string; init?: RequestInit };

function captureFetch(responseBody: unknown = { ok: true }): {
  calls: Captured[];
} {
  const calls: Captured[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("api: composite (space, room) query string", () => {
  test("LEGACY_SPACE_ID matches backend sentinel '__legacy__'", () => {
    expect(LEGACY_SPACE_ID).toBe("__legacy__");
  });

  test("getState includes both space and room", async () => {
    const { calls } = captureFetch({ version: 1, store: {}, prompts: [], aiActivity: null });
    await getState("ws-a", "room-x");
    expect(calls[0]!.url).toContain("/api/state");
    expect(calls[0]!.url).toContain("space=ws-a");
    expect(calls[0]!.url).toContain("room=room-x");
  });

  test("seedSchema includes both space and room", async () => {
    const { calls } = captureFetch();
    await seedSchema("ws-a", "room-x", { schemaVersion: 2 });
    expect(calls[0]!.url).toContain("/api/state/seed-schema");
    expect(calls[0]!.url).toContain("space=ws-a");
    expect(calls[0]!.url).toContain("room=room-x");
  });

  test("listRooms includes space (room scope is bucket-wide)", async () => {
    const { calls } = captureFetch({ ok: true, rooms: [], dir: "" });
    await listRooms("ws-7", { includeArchived: true });
    expect(calls[0]!.url).toContain("/api/rooms");
    expect(calls[0]!.url).toContain("space=ws-7");
    expect(calls[0]!.url).toContain("include=archived");
  });

  test("archiveRoom / restoreRoom carry space", async () => {
    const { calls } = captureFetch();
    await archiveRoom("ws-7", "alpha");
    await restoreRoom("ws-7", "alpha");
    expect(calls[0]!.url).toContain("/api/rooms/alpha/archive?space=ws-7");
    expect(calls[1]!.url).toContain("/api/rooms/alpha/restore?space=ws-7");
  });

  test("deleteRoom / exportRoom / renameRoom carry space", async () => {
    const { calls } = captureFetch();
    await deleteRoom("ws-7", "alpha", { mode: "archive" });
    await exportRoom("ws-7", "alpha", "/tmp/out.json");
    await renameRoom("ws-7", "alpha", "beta");
    expect(calls[0]!.url).toContain("/api/rooms/alpha?space=ws-7");
    expect(calls[1]!.url).toContain("/api/rooms/alpha/export?space=ws-7");
    expect(calls[2]!.url).toContain("/api/rooms/alpha/rename?space=ws-7");
  });

  test("duplicateRoom / duplicateRoomAuto / purgeArchive carry space", async () => {
    const { calls } = captureFetch({ removed: 0 });
    await duplicateRoom("ws-7", "alpha", "alpha-copy");
    await duplicateRoomAuto("ws-7", "alpha");
    await purgeArchive("ws-7");
    expect(calls[0]!.url).toContain("/api/rooms/alpha/duplicate?space=ws-7");
    expect(calls[1]!.url).toContain("/api/rooms/alpha/duplicate-auto?space=ws-7");
    expect(calls[2]!.url).toContain("/api/rooms/purge-archive?space=ws-7");
  });

  test("encodes space + room ids with reserved characters", async () => {
    const { calls } = captureFetch({ version: 1, store: {}, prompts: [], aiActivity: null });
    await getState("a b/c", "x y");
    expect(calls[0]!.url).toContain("space=a%20b%2Fc");
    expect(calls[0]!.url).toContain("room=x%20y");
  });
});
