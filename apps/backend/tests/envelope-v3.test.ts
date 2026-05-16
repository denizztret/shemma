// apps/backend/tests/envelope-v3.test.ts
import { describe, expect, it } from "bun:test";
import { ENVELOPE_SCHEMA_VERSION, parseFull, serialize } from "../src/envelope";
import type { RoomState } from "../src/types";

function makeRoomState(): RoomState {
  return {
    store: {
      schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
      store: {
        "document:document": { id: "document:document", typeName: "document" },
        "page:page": { id: "page:page", typeName: "page" },
      },
    },
    opLog: [],
    prompts: [],
    version: 0,
    dirty: false,
    lastTouched: Date.now(),
    didrawIndex: new Map(),
  };
}

describe("envelope v3", () => {
  it("ENVELOPE_SCHEMA_VERSION is 3", () => {
    expect(ENVELOPE_SCHEMA_VERSION).toBe(3);
  });

  it("serialize emits schemaVersion 3 with store and opLog", () => {
    const s = makeRoomState();
    const raw = serialize("room1", s);
    const j = JSON.parse(raw);
    expect(j.schemaVersion).toBe(3);
    expect(j.roomId).toBe("room1");
    expect(j.version).toBe(0);
    expect(typeof j.lastTouched).toBe("string");
    expect(typeof j.elementCount).toBe("number");
    expect(j.didraw.didrawVersion).toBeString();
    expect(j.store.schema).toBeDefined();
    expect(j.store.store["document:document"]).toBeDefined();
    expect(Array.isArray(j.opLog)).toBe(true);
    expect(Array.isArray(j.prompts)).toBe(true);
  });

  it("parseFull round-trips a v3 envelope", () => {
    const s = makeRoomState();
    s.store.store["shape:abc"] = {
      id: "shape:abc",
      typeName: "shape",
      type: "geo",
      x: 10,
      y: 20,
      meta: { didrawName: "backend" },
    };
    s.version = 5;
    const raw = serialize("r2", s);
    const parsed = parseFull(raw);
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.version).toBe(5);
    expect(parsed.store.store["shape:abc"]?.meta?.didrawName).toBe("backend");
  });

  it("parseFull rejects unknown schemaVersion with descriptive error", () => {
    const bad = JSON.stringify({ schemaVersion: 99, roomId: "x", version: 0, store: {}, prompts: [] });
    expect(() => parseFull(bad)).toThrow(/unsupported schemaVersion: 99/);
  });

  it("parseFull rejects malformed envelope (missing store)", () => {
    const bad = JSON.stringify({ schemaVersion: 3, roomId: "x", version: 0 });
    expect(() => parseFull(bad)).toThrow(/malformed envelope/);
  });

  it("elementCount counts only shape records", () => {
    const s = makeRoomState();
    s.store.store["shape:a"] = { id: "shape:a", typeName: "shape" };
    s.store.store["shape:b"] = { id: "shape:b", typeName: "shape" };
    s.store.store["binding:c"] = { id: "binding:c", typeName: "binding" };
    const raw = serialize("r", s);
    expect(JSON.parse(raw).elementCount).toBe(2);
  });

  it("parseHeader reads header without full store", () => {
    // parseHeader должен работать на v3 envelope; используется в rooms list для cheap stat.
    const s = makeRoomState();
    const raw = serialize("rH", s);
    // parseHeader экспортируется из envelope.ts — тип EnvelopeHeader
    const { parseHeader } = require("../src/envelope");
    const h = parseHeader(raw);
    expect(h).not.toBeNull();
    expect(h.schemaVersion).toBe(3);
    expect(h.roomId).toBe("rH");
  });
});
