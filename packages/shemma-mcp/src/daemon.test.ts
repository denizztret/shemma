import { describe, expect, it } from "bun:test";
import { ensureDaemonSilent, type EnsureResult } from "./daemon";

describe("ensureDaemonSilent", () => {
  it("returns ok=true when health probe succeeds first try", async () => {
    let calls = 0;
    const r: EnsureResult = await ensureDaemonSilent({
      profile: "release",
      port: 8787,
      autoEnsure: true,
      probeHealth: async () => { calls++; return true; },
      startBackground: async () => { throw new Error("should not start"); },
      sleep: async () => {},
      maxAttempts: 5,
    });
    expect(r).toEqual({ ok: true, port: 8787 });
    expect(calls).toBe(1);
  });

  it("starts daemon and re-probes when first probe fails", async () => {
    let probeCount = 0;
    let started = false;
    const r = await ensureDaemonSilent({
      profile: "release",
      port: 8787,
      autoEnsure: true,
      probeHealth: async () => { probeCount++; return probeCount > 1; },
      startBackground: async () => { started = true; },
      sleep: async () => {},
      maxAttempts: 5,
    });
    expect(r).toEqual({ ok: true, port: 8787 });
    expect(started).toBe(true);
    expect(probeCount).toBeGreaterThanOrEqual(2);
  });

  it("returns ok=false when autoEnsure=false and not healthy", async () => {
    const r = await ensureDaemonSilent({
      profile: "release",
      port: 8787,
      autoEnsure: false,
      probeHealth: async () => false,
      startBackground: async () => { throw new Error("must not start"); },
      sleep: async () => {},
      maxAttempts: 5,
    });
    expect(r).toEqual({ ok: false, code: "daemon-unavailable", port: 8787 });
  });

  it("returns ok=false when start succeeds but probes never become healthy", async () => {
    const r = await ensureDaemonSilent({
      profile: "release",
      port: 8787,
      autoEnsure: true,
      probeHealth: async () => false,
      startBackground: async () => {},
      sleep: async () => {},
      maxAttempts: 3,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("daemon-unhealthy");
  });
});
