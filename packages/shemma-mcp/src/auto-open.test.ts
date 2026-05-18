import { describe, expect, it } from "bun:test";
import { AutoOpenManager, type OpenSpawnFn } from "./auto-open";

function recorderSpawn(): { spawn: OpenSpawnFn; calls: Array<{ room: string }> } {
  const calls: Array<{ room: string }> = [];
  return {
    spawn: async (room) => { calls.push({ room }); },
    calls,
  };
}

describe("AutoOpenManager", () => {
  it("once: opens on first write, no-op on second", async () => {
    const { spawn, calls } = recorderSpawn();
    const m = new AutoOpenManager({ mode: "once", spawn, env: {} });
    await m.notifyWrite("room-a");
    await m.notifyWrite("room-a");
    expect(calls.map((c) => c.room)).toEqual(["room-a"]);
  });

  it("once: separate rooms each trigger once", async () => {
    const { spawn, calls } = recorderSpawn();
    const m = new AutoOpenManager({ mode: "once", spawn, env: {} });
    await m.notifyWrite("a");
    await m.notifyWrite("b");
    expect(calls.map((c) => c.room)).toEqual(["a", "b"]);
  });

  it("never: never opens", async () => {
    const { spawn, calls } = recorderSpawn();
    const m = new AutoOpenManager({ mode: "never", spawn, env: {} });
    await m.notifyWrite("a");
    expect(calls).toEqual([]);
  });

  it("always: opens every time", async () => {
    const { spawn, calls } = recorderSpawn();
    const m = new AutoOpenManager({ mode: "always", spawn, env: {} });
    await m.notifyWrite("a");
    await m.notifyWrite("a");
    expect(calls.length).toBe(2);
  });

  it("confirm: never spawns automatically; consentRequired flag set", async () => {
    const { spawn, calls } = recorderSpawn();
    const m = new AutoOpenManager({ mode: "confirm", spawn, env: {} });
    const result = await m.notifyWrite("a");
    expect(calls).toEqual([]);
    expect(result.openConsentRequired).toBe(true);
  });

  it("SHEMMA_NO_BROWSER=1 overrides always to never", async () => {
    const { spawn, calls } = recorderSpawn();
    const m = new AutoOpenManager({ mode: "always", spawn, env: { SHEMMA_NO_BROWSER: "1" } });
    await m.notifyWrite("a");
    expect(calls).toEqual([]);
  });

  it("explicit open(room) opens regardless of mode and updates openedRooms", async () => {
    const { spawn, calls } = recorderSpawn();
    const m = new AutoOpenManager({ mode: "never", spawn, env: {} });
    await m.open("a");
    expect(calls.map((c) => c.room)).toEqual(["a"]);
    expect(m.snapshot().openedRooms).toContain("a");
  });
});
