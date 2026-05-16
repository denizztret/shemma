import { describe, expect, test } from "bun:test";
import { emptyCanvasState, makeRoomState } from "../src/rooms";
import { parseFull, parseHeader, serialize } from "../src/envelope";

describe("envelope", () => {
  test("serialize → parseFull roundtrip", () => {
    const s = makeRoomState();
    s.canvas.nodes.push({ id: "n1", kind: "rect", x: 1, y: 2 });
    s.prompts.push({
      id: "p1",
      selection: [],
      text: "hi",
      createdAt: 1000,
      status: "pending",
    });
    s.version = 5;

    const raw = serialize("room-a", s);
    const env = parseFull(raw);

    expect(env.schemaVersion).toBe(2);
    expect(env.roomId).toBe("room-a");
    expect(env.version).toBe(5);
    expect(env.elementCount).toBe(1);
    expect(env.canvas.nodes[0].id).toBe("n1");
    expect(env.prompts[0].id).toBe("p1");
    expect(typeof env.lastTouched).toBe("string");
  });

  test("elementCount = nodes + edges + groups", () => {
    const s = makeRoomState();
    s.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
    s.canvas.nodes.push({ id: "n2", kind: "rect", x: 0, y: 0 });
    s.canvas.edges.push({
      id: "e1",
      from: { kind: "node", id: "n1" },
      to: { kind: "node", id: "n2" },
    });
    s.canvas.groups.push({ id: "g1", kind: "frame", children: [] });

    const env = parseFull(serialize("r", s));
    expect(env.elementCount).toBe(4);
  });

  test("parseHeader projects out only metadata fields", () => {
    const s = makeRoomState();
    s.canvas.nodes.push({ id: "n1", kind: "rect", x: 1, y: 2 });
    s.version = 7;
    const raw = serialize("room-b", s);

    const hdr = parseHeader(raw);
    expect(hdr).not.toBeNull();
    expect(hdr!.roomId).toBe("room-b");
    expect(hdr!.version).toBe(7);
    expect(hdr!.elementCount).toBe(1);
    expect(hdr!.schemaVersion).toBe(2);
    expect((hdr as Record<string, unknown>).canvas).toBeUndefined();
    expect((hdr as Record<string, unknown>).prompts).toBeUndefined();
  });

  test("parseHeader returns null on malformed JSON", () => {
    expect(parseHeader("not json")).toBeNull();
    expect(parseHeader("{")).toBeNull();
  });

  test("parseFull rejects unsupported schemaVersion", () => {
    const bad = JSON.stringify({
      schemaVersion: 999,
      roomId: "r",
      version: 0,
      lastTouched: new Date().toISOString(),
      elementCount: 0,
      canvas: emptyCanvasState(),
      prompts: [],
    });
    expect(() => parseFull(bad)).toThrow(/unsupported schemaVersion/);
  });

  test("header fields appear early in serialized output", () => {
    const s = makeRoomState();
    const raw = serialize("room-c", s);
    const idxSchema = raw.indexOf('"schemaVersion"');
    const idxRoom = raw.indexOf('"roomId"');
    const idxVersion = raw.indexOf('"version"');
    const idxLast = raw.indexOf('"lastTouched"');
    const idxCount = raw.indexOf('"elementCount"');
    const idxCanvas = raw.indexOf('"canvas"');
    expect(idxSchema).toBeGreaterThan(-1);
    expect(idxSchema).toBeLessThan(idxCanvas);
    expect(idxRoom).toBeLessThan(idxCanvas);
    expect(idxVersion).toBeLessThan(idxCanvas);
    expect(idxLast).toBeLessThan(idxCanvas);
    expect(idxCount).toBeLessThan(idxCanvas);
  });
});
