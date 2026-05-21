import { describe, it, expect } from "bun:test";
import { IdleTracker } from "../idle-tracker";

describe("IdleTracker", () => {
  it("triggers onIdle after threshold with no activity", async () => {
    let called = false;
    const tracker = new IdleTracker(100, () => {
      called = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(called).toBe(true);
    tracker.shutdown();
  });

  it("does not trigger while WS connections open", async () => {
    let called = false;
    const tracker = new IdleTracker(100, () => {
      called = true;
    });
    tracker.noteWsOpen();
    await new Promise((r) => setTimeout(r, 300));
    expect(called).toBe(false);
    tracker.noteWsClose();
    tracker.shutdown();
  });

  it("does not start timer when idleMs <= 0", () => {
    let called = false;
    const tracker = new IdleTracker(0, () => {
      called = true;
    });
    // No interval should be running; shutdown should be a no-op
    tracker.shutdown();
    expect(called).toBe(false);
  });

  it("resets activity on noteHttp so idle window slides", async () => {
    let called = false;
    const tracker = new IdleTracker(200, () => {
      called = true;
    });
    // Tick noteHttp every 80ms for ~300ms — total elapsed > idleMs but
    // lastActivity stayed within the window, so onIdle must NOT fire.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 80));
      tracker.noteHttp();
    }
    expect(called).toBe(false);
    tracker.shutdown();
  });
});
