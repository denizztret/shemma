import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../../../apps/backend/src/index";
import { CanvasClient } from "../src/index";

let srv: { port: number; close: () => Promise<void> };
beforeAll(async () => {
  srv = await startServer({ inMemory: true, port: 0 });
});
afterAll(async () => {
  await srv.close();
});

describe("CanvasClient", () => {
  test("uses CLAUDE_SESSION_ID from env as default room", () => {
    process.env.CLAUDE_SESSION_ID = "abc";
    const c = new CanvasClient({ baseUrl: `http://localhost:${srv.port}` });
    expect(c.room).toBe("abc");
    // biome-ignore lint/performance/noDelete: env var must be unset for portability across runtimes (Node coerces `=undefined` to string "undefined")
    delete process.env.CLAUDE_SESSION_ID;
  });

  test("getState returns empty for new room", async () => {
    const c = new CanvasClient({
      baseUrl: `http://localhost:${srv.port}`,
      room: "test1",
    });
    const s = await c.getState();
    expect(s.canvas.nodes).toEqual([]);
  });

  test("applyPatch + getState round-trip", async () => {
    const c = new CanvasClient({
      baseUrl: `http://localhost:${srv.port}`,
      room: "test2",
    });
    const r = await c.applyPatch([
      {
        op: "add",
        target: "node",
        value: { id: "n1", kind: "rect", x: 0, y: 0 },
      },
    ]);
    expect(r.ok).toBe(true);
    expect(r.version).toBe(1);
    const s = await c.getState();
    expect(s.canvas.nodes[0].id).toBe("n1");
  });
});
