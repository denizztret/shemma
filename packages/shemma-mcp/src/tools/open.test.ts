import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { AutoOpenManager } from "../auto-open";
import type { ResolveSpaceFn } from "../space-resolver";
import { registerOpenTool, waitForClientConnection } from "./open";

const fakeSpaceRecord = {
  id: "test-space",
  path: "/tmp/test-space",
  storageLayout: "project" as const,
  createdAt: "2026-01-01T00:00:00Z",
  lastUsedAt: "2026-01-01T00:00:00Z",
};
const fakeResolveSpace: ResolveSpaceFn = ({ space }) => {
  if (space) return { space: { ...fakeSpaceRecord, id: space }, source: "explicit" };
  return { space: fakeSpaceRecord, source: "default" };
};

type SetupOpts = {
  mode?: "never" | "once" | "always" | "confirm";
  throwOnSpawn?: boolean;
  // DRW-133: stub for client.getActiveRooms used by waitForClient polling.
  // Returns the same response for every call; pass a function instead for
  // step-by-step scenarios (e.g. "first call empty, second call connected").
  activeRoomsResponse?:
    | { rooms: Array<{ space?: string; room: string; clientCount: number; lastFocusedAt: number }> }
    | (() => { rooms: Array<{ space?: string; room: string; clientCount: number; lastFocusedAt: number }> });
};

function setup(opts: SetupOpts = {}) {
  const calls: string[] = [];
  const auto = new AutoOpenManager({
    mode: opts.mode ?? "never",
    env: {},
    spawn: async (r) => {
      if (opts.throwOnSpawn) throw new Error("spawn failed");
      calls.push(r);
    },
  });
  const server = new McpServer({ name: "t", version: "0" });
  // DRW-133: stubbed client. registerOpenTool now requires one for the
  // waitForClient polling path; tests not exercising that path pass any
  // CanvasClient and it stays unused.
  const client = new CanvasClient({ baseUrl: "http://test.invalid" });
  if (opts.activeRoomsResponse !== undefined) {
    // biome-ignore lint/suspicious/noExplicitAny: monkey-patch for stub
    (client as any).getActiveRooms = async () =>
      typeof opts.activeRoomsResponse === "function"
        ? opts.activeRoomsResponse()
        : opts.activeRoomsResponse;
  }
  const handles = registerOpenTool(server, {
    autoOpen: auto,
    defaultRoom: "default",
    resolveSpace: fakeResolveSpace,
    client,
    sleep: async () => {}, // no-op sleep so polling loops finish instantly
  });
  return { server, auto, handles, calls, client };
}

describe("shemma_open", () => {
  it("registers tool without throwing", () => {
    expect(() => setup()).not.toThrow();
  });

  it("explicit open with room arg spawns subprocess", async () => {
    const { handles, calls } = setup();
    const r = await handles.open.call({ room: "test-room" });
    expect(calls).toEqual(["test-room"]);
    expect(r.structuredContent).toMatchObject({ ok: true, room: "test-room", data: { spawned: true } });
  });

  it("uses defaultRoom when no room arg", async () => {
    const { handles, calls } = setup();
    const r = await handles.open.call({});
    expect(calls).toEqual(["default"]);
    expect(r.structuredContent).toMatchObject({ ok: true, room: "default" });
  });

  it("noBrowser:true skips spawn", async () => {
    const { handles, calls } = setup();
    const r = await handles.open.call({ noBrowser: true });
    expect(calls).toEqual([]);
    expect(r.structuredContent).toMatchObject({
      ok: true,
      data: { spawned: false, reason: "noBrowser" },
    });
  });

  it("explicit open ignores mode (even never)", async () => {
    const { handles, calls } = setup({ mode: "never" });
    await handles.open.call({ room: "x" });
    expect(calls).toEqual(["x"]);
  });

  it("returns error when spawn throws", async () => {
    const { handles } = setup({ throwOnSpawn: true });
    const r = await handles.open.call({ room: "x" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ ok: false, code: "unexpected-error" });
  });
});

// DRW-133: waitForClient polling. The stubbed CanvasClient mimics the
// /api/active-rooms response shape; the registerOpenTool setup passes a
// no-op sleep so the polling loop runs synchronously (timing is mocked
// via the fake clock in `waitForClientConnection` unit tests below).
describe("shemma_open waitForClient — DRW-133", () => {
  it("connected → returns connected:true + waitedMs", async () => {
    let attempt = 0;
    const { handles } = setup({
      activeRoomsResponse: () => {
        attempt++;
        // First poll empty, second poll the client is there. Forces the
        // loop to iterate at least once → exercises real polling code.
        if (attempt === 1) return { rooms: [] };
        return {
          rooms: [
            { space: "test-space", room: "demo", clientCount: 1, lastFocusedAt: Date.now() },
          ],
        };
      },
    });
    const r = await handles.open.call({ room: "demo", waitForClient: true });
    expect(r.structuredContent).toMatchObject({
      ok: true,
      room: "demo",
      data: { spawned: true, connected: true },
    });
    const data = (r.structuredContent as { data: { waitedMs: number } }).data;
    expect(typeof data.waitedMs).toBe("number");
  });

  it("timeout → returns connected:false + waitedMs == timeout", async () => {
    const { handles } = setup({
      activeRoomsResponse: { rooms: [] },
    });
    const r = await handles.open.call({
      room: "demo",
      waitForClient: true,
      timeoutMs: 50,
    });
    expect(r.structuredContent).toMatchObject({
      ok: true,
      room: "demo",
      data: { spawned: true, connected: false, waitedMs: 50 },
    });
  });

  it("without waitForClient → original response shape (no connected field)", async () => {
    const { handles } = setup();
    const r = await handles.open.call({ room: "x" });
    expect(r.structuredContent).toMatchObject({
      ok: true,
      data: { spawned: true },
    });
    expect(
      (r.structuredContent as { data: Record<string, unknown> }).data.connected,
    ).toBeUndefined();
  });
});

describe("waitForClientConnection helper — DRW-133", () => {
  function fakeClock(): { now: () => number; advance: (ms: number) => void } {
    let t = 0;
    return { now: () => t, advance: (ms) => { t += ms; } };
  }

  it("returns waitedMs when room becomes active", async () => {
    const clock = fakeClock();
    let attempt = 0;
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    const client = {
      async getActiveRooms() {
        attempt++;
        // Make time advance on each poll attempt.
        clock.advance(100);
        if (attempt < 3) return { rooms: [] };
        return {
          rooms: [{ space: "s", room: "r", clientCount: 1, lastFocusedAt: 0 }],
        };
      },
    } as any;
    const r = await waitForClientConnection({
      client,
      space: "s",
      room: "r",
      timeoutMs: 1000,
      sleep: async () => {},
      now: clock.now,
    });
    expect(r).not.toBeNull();
    expect(r?.waitedMs).toBeGreaterThan(0);
  });

  it("returns null on timeout", async () => {
    const clock = fakeClock();
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    const client = {
      async getActiveRooms() {
        clock.advance(100);
        return { rooms: [] };
      },
    } as any;
    const r = await waitForClientConnection({
      client,
      space: "s",
      room: "r",
      timeoutMs: 300,
      sleep: async () => {},
      now: clock.now,
    });
    expect(r).toBeNull();
  });

  it("transient fetch errors don't abort — keep polling until budget runs out", async () => {
    const clock = fakeClock();
    let attempt = 0;
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    const client = {
      async getActiveRooms() {
        attempt++;
        clock.advance(50);
        if (attempt < 3) throw new Error("network jitter");
        return {
          rooms: [{ space: "s", room: "r", clientCount: 1, lastFocusedAt: 0 }],
        };
      },
    } as any;
    const r = await waitForClientConnection({
      client,
      space: "s",
      room: "r",
      timeoutMs: 500,
      sleep: async () => {},
      now: clock.now,
    });
    expect(r).not.toBeNull();
    expect(attempt).toBe(3);
  });
});
