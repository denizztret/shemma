import { describe, expect, test } from "bun:test";
import { startServer } from "../src/index";

describe("WS /ws — room id validation", () => {
  test("422 on invalid ?room= before WS handshake", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    try {
      const res = await fetch(
        `http://localhost:${srv.port}/ws?room=${encodeURIComponent("bad name")}`,
      );
      expect(res.status).toBe(422);
      const body = await res.text();
      expect(body).toContain("invalid room id");
    } finally {
      await srv.close();
    }
  });

  test("valid room id still upgrades successfully", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    try {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws?room=good-id`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws errored"));
      });
      ws.close();
    } finally {
      await srv.close();
    }
  });
});
