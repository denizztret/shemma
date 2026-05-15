import { describe, expect, test } from "bun:test";
import { startServer } from "../src/index";

describe("WS /ws", () => {
  test("client receives patch broadcast for its room", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws?room=a`);
    // biome-ignore lint/suspicious/noExplicitAny: parsed WS messages are untyped in tests
    const msgs: any[] = [];
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    ws.onmessage = (e) => msgs.push(JSON.parse(e.data as string));
    await new Promise((r) => setTimeout(r, 30));
    await fetch(`http://localhost:${srv.port}/api/patch?room=a`, {
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
        source: "ai",
      }),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(msgs.some((m) => m.kind === "hello")).toBe(true);
    expect(msgs.some((m) => m.kind === "patch" && m.version === 1)).toBe(true);
    ws.close();
    await srv.close();
  });

  test("rooms isolated on WS", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws?room=a`);
    // biome-ignore lint/suspicious/noExplicitAny: parsed WS messages are untyped in tests
    const msgs: any[] = [];
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    ws.onmessage = (e) => msgs.push(JSON.parse(e.data as string));
    await fetch(`http://localhost:${srv.port}/api/patch?room=b`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            op: "add",
            target: "node",
            value: { id: "n", kind: "rect", x: 0, y: 0 },
          },
        ],
        source: "ai",
      }),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(msgs.find((m) => m.kind === "patch")).toBeUndefined();
    ws.close();
    await srv.close();
  });
});
