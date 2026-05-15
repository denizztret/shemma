import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

describe("AI activity routes", () => {
  test("start sets activity, stop clears it", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const start = await app.fetch(
      new Request("http://x/api/ai/start?room=a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "sonnet", task: "draw demo" }),
      }),
    );
    expect((await start.json()).ok).toBe(true);
    const r = await rooms.get("a");
    expect(r.aiActivity?.actor).toBe("sonnet");
    expect(r.aiActivity?.task).toBe("draw demo");

    const stop = await app.fetch(
      new Request("http://x/api/ai/stop?room=a", { method: "POST" }),
    );
    expect((await stop.json()).ok).toBe(true);
    expect(r.aiActivity).toBeUndefined();
  });

  test("start without actor/task → 400", async () => {
    const { app } = makeApp({ inMemory: true });
    const r = await app.fetch(
      new Request("http://x/api/ai/start?room=a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "sonnet" }),
      }),
    );
    expect(r.status).toBe(400);
  });

  test("activity endpoint returns null when nothing active", async () => {
    const { app } = makeApp({ inMemory: true });
    const r = await app.fetch(new Request("http://x/api/ai/activity?room=a"));
    expect((await r.json()).activity).toBeNull();
  });

  test("stale activity auto-clears on read", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("a");
    // Plant a 6-minute-old record; STALE_MS is 5 minutes.
    r.aiActivity = {
      actor: "sonnet",
      task: "zombie",
      startedAt: Date.now() - 6 * 60 * 1000,
    };
    const got = await app.fetch(new Request("http://x/api/ai/activity?room=a"));
    expect((await got.json()).activity).toBeNull();
    expect(r.aiActivity).toBeUndefined();
  });
});
