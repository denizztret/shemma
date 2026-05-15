import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

describe("GET /api/state", () => {
  test("empty room", async () => {
    const { app } = makeApp({ inMemory: true });
    const r = await app.fetch(new Request("http://x/api/state?room=a"));
    const b = await r.json();
    expect(b.canvas.nodes).toEqual([]);
    expect(b.version).toBe(0);
  });

  test("returns diff with since=", async () => {
    const { app } = makeApp({ inMemory: true });
    await app.fetch(
      new Request("http://x/api/patch?room=a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ops: [
            {
              op: "add",
              target: "node",
              value: { id: "n1", kind: "rect", x: 0, y: 0 },
            },
          ],
          source: "user",
        }),
      }),
    );
    const r = await app.fetch(new Request("http://x/api/state?room=a&since=0"));
    const b = await r.json();
    expect(b.diff).toHaveLength(1);
  });

  test("since= with stale opLog returns truncated:true", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    await app.fetch(
      new Request("http://x/api/patch?room=a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ops: [
            {
              op: "add",
              target: "node",
              value: { id: "n1", kind: "rect", x: 0, y: 0 },
            },
          ],
          source: "user",
        }),
      }),
    );
    // Simulate restart: opLog is in-memory only, persistence drops it on reload.
    const room = await rooms.get("a");
    room.opLog = [];
    const r = await app.fetch(new Request("http://x/api/state?room=a&since=0"));
    const b = await r.json();
    expect(b.truncated).toBe(true);
    expect(b.version).toBe(1);
    expect(b.diff).toBeUndefined();
  });

  test("compact omits empty style/meta", async () => {
    const { app } = makeApp({ inMemory: true });
    await app.fetch(
      new Request("http://x/api/patch?room=a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ops: [
            {
              op: "add",
              target: "node",
              value: { id: "n1", kind: "rect", x: 0, y: 0 },
            },
          ],
          source: "user",
        }),
      }),
    );
    const r = await app.fetch(
      new Request("http://x/api/state?room=a&fmt=compact"),
    );
    const b = await r.json();
    expect(b.canvas.nodes[0]).not.toHaveProperty("style");
  });
});
