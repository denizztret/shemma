import { describe, expect, it } from "bun:test";
import { parseFull, serialize } from "./envelope";
import { makeRoomState } from "./rooms";
import type { MiroExportsMap, RoomMeta, RoomState } from "./types";

describe("EnvelopeV3 — meta plumbing (DRW-103)", () => {
  it("serialize: includes meta when RoomState.meta is set", () => {
    const s: RoomState = makeRoomState();
    const exports: MiroExportsMap = {
      "miro-board-1": {
        boardName: "Test Board",
        lastExportedAt: "2026-05-20T10:00:00.000Z",
        items: { "shape:e_api": "3458764528467123456" },
        connectors: { "shape:e_api_db": "3458764528467123457" },
      },
    };
    s.meta = { miroExports: exports };
    const raw = serialize("default", s);
    const j = JSON.parse(raw) as { meta?: RoomMeta };
    expect(j.meta).toBeDefined();
    expect(j.meta?.miroExports?.["miro-board-1"]?.boardName).toBe("Test Board");
    expect(j.meta?.miroExports?.["miro-board-1"]?.items?.["shape:e_api"]).toBe(
      "3458764528467123456",
    );
  });

  it("serialize: omits meta when RoomState.meta is undefined", () => {
    const s: RoomState = makeRoomState();
    const raw = serialize("default", s);
    const j = JSON.parse(raw) as { meta?: unknown };
    expect(j.meta).toBeUndefined();
  });

  it("parseFull: round-trips meta", () => {
    const s: RoomState = makeRoomState();
    s.meta = {
      miroExports: {
        "b1": {
          lastExportedAt: "2026-05-20T10:00:00.000Z",
          items: { "shape:e_api": "abc" },
        },
      },
    };
    const env = parseFull(serialize("default", s));
    expect(env.meta).toBeDefined();
    expect(env.meta?.miroExports?.["b1"]?.items?.["shape:e_api"]).toBe("abc");
  });

  it("parseFull: legacy envelope без meta → parsed.meta === undefined", () => {
    const legacy = {
      schemaVersion: 3 as const,
      roomId: "default",
      version: 0,
      lastTouched: "2026-05-15T00:00:00.000Z",
      elementCount: 0,
      shemma: { shemmaVersion: "0.18.0", createdAt: "2026-05-15T00:00:00.000Z" },
      store: { schema: { schemaVersion: 1, storeVersion: 1, recordVersions: {} }, store: {} },
      prompts: [],
      opLog: [],
    };
    const env = parseFull(JSON.stringify(legacy));
    expect(env.meta).toBeUndefined();
  });

  it("ENVELOPE_SCHEMA_VERSION stays at 3 (additive optional, no bump)", async () => {
    const { ENVELOPE_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS } = await import("./envelope");
    expect(ENVELOPE_SCHEMA_VERSION).toBe(3);
    expect(SUPPORTED_SCHEMA_VERSIONS).toEqual([2, 3]);
  });
});
