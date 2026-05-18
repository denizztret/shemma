// packages/shemma-mcp/src/room-resolver.test.ts
import { describe, expect, it } from "bun:test";
import { RoomResolver, type ResolveResult } from "./room-resolver";

function activeRoomsStub(rooms: string[]) {
  return async () => ({ rooms: rooms.map((r) => ({ room: r, clientCount: 1, lastFocusedAt: Date.now() })) });
}

describe("RoomResolver", () => {
  it("arg wins over everything", async () => {
    const r = new RoomResolver({
      configRoom: "config",
      sessionEnv: "session",
      getActiveRooms: activeRoomsStub(["active-1", "active-2"]),
      getInProgressTasks: async () => [{ id: "DRW-1", slug: "drw-1-x" }],
    });
    const out = await r.resolve({ argRoom: "explicit" });
    expect(out).toEqual({ ok: true, room: "explicit", source: "arg" });
  });

  it("config wins over env/active/task", async () => {
    const r = new RoomResolver({
      configRoom: "config",
      sessionEnv: "session",
      getActiveRooms: activeRoomsStub(["active-1"]),
      getInProgressTasks: async () => [{ id: "DRW-1", slug: "drw-1-x" }],
    });
    expect(await r.resolve({})).toEqual({ ok: true, room: "config", source: "config" });
  });

  it("session env wins over active/task when no config", async () => {
    const r = new RoomResolver({
      configRoom: undefined,
      sessionEnv: "session",
      getActiveRooms: activeRoomsStub(["active-1"]),
      getInProgressTasks: async () => [{ id: "DRW-1", slug: "drw-1-x" }],
    });
    expect(await r.resolve({})).toEqual({ ok: true, room: "session", source: "session" });
  });

  it("single active room wins over task when no session", async () => {
    const r = new RoomResolver({
      configRoom: undefined,
      sessionEnv: undefined,
      getActiveRooms: activeRoomsStub(["active-1"]),
      getInProgressTasks: async () => [{ id: "DRW-1", slug: "drw-1-x" }],
    });
    expect(await r.resolve({})).toEqual({ ok: true, room: "active-1", source: "active" });
  });

  it("ambiguous when multiple active and no other resolution", async () => {
    const r = new RoomResolver({
      configRoom: undefined,
      sessionEnv: undefined,
      getActiveRooms: activeRoomsStub(["a", "b"]),
      getInProgressTasks: async () => [],
    });
    const out = await r.resolve({});
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("ambiguous-room");
      expect(out.candidates.map((c) => c.room)).toEqual(["a", "b"]);
    }
  });

  it("task slug wins when no active rooms", async () => {
    const r = new RoomResolver({
      configRoom: undefined,
      sessionEnv: undefined,
      getActiveRooms: activeRoomsStub([]),
      getInProgressTasks: async () => [{ id: "DRW-54", slug: "drw-54-mcp" }],
    });
    expect(await r.resolve({})).toEqual({ ok: true, room: "drw-54-mcp", source: "task" });
  });

  it("ambiguous when multiple in-progress tasks", async () => {
    const r = new RoomResolver({
      configRoom: undefined,
      sessionEnv: undefined,
      getActiveRooms: activeRoomsStub([]),
      getInProgressTasks: async () => [
        { id: "DRW-1", slug: "drw-1-a" },
        { id: "DRW-2", slug: "drw-2-b" },
      ],
    });
    const out = await r.resolve({});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("ambiguous-room");
  });

  it("lastTouched used when nothing else available", async () => {
    const r = new RoomResolver({
      configRoom: undefined,
      sessionEnv: undefined,
      getActiveRooms: activeRoomsStub([]),
      getInProgressTasks: async () => [],
    });
    r.recordTouch("touched-room");
    expect(await r.resolve({})).toEqual({ ok: true, room: "touched-room", source: "lastTouched" });
  });

  it("default fallback when nothing", async () => {
    const r = new RoomResolver({
      configRoom: undefined,
      sessionEnv: undefined,
      getActiveRooms: activeRoomsStub([]),
      getInProgressTasks: async () => [],
    });
    expect(await r.resolve({})).toEqual({ ok: true, room: "default", source: "default" });
  });
});
