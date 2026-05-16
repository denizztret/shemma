import { describe, expect, test } from "bun:test";
import { parseFull, serialize } from "../src/envelope";
import { makeRoomState } from "../src/rooms";

describe("envelope opLog roundtrip", () => {
  test("v2 envelope persists opLog and round-trips", () => {
    const s = makeRoomState();
    s.opLog.push({ ops: [], source: "ai", version: 1, at: 100 });
    s.opLog.push({ ops: [], source: "user", version: 2, at: 200 });

    const raw = serialize("room1", s);
    const env = parseFull(raw);

    expect(env.opLog).toBeDefined();
    expect(env.opLog).toHaveLength(2);
    expect(env.opLog?.[1].version).toBe(2);
    expect(env.opLog?.[1].source).toBe("user");
  });

  test("v1 envelope reads with empty opLog", () => {
    const v1 = JSON.stringify({
      schemaVersion: 1,
      roomId: "r",
      version: 5,
      lastTouched: "2026-05-16T00:00:00.000Z",
      elementCount: 0,
      canvas: { version: 1, nodes: [], edges: [], groups: [] },
      prompts: [],
    });
    const env = parseFull(v1);
    expect(env.schemaVersion).toBe(1);
    expect(env.opLog).toEqual([]);
  });

  test("serialized envelope has schemaVersion 2", () => {
    const s = makeRoomState();
    const raw = serialize("room1", s);
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(2);
    expect(Array.isArray(parsed.opLog)).toBe(true);
  });
});
