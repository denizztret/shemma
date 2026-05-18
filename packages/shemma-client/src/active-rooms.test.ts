import { describe, expect, it } from "bun:test";
import { CanvasClient } from "./index";

describe("CanvasClient.getActiveRooms", () => {
  it("returns rooms list from /api/active-rooms", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      expect(url).toContain("/api/active-rooms");
      return new Response(
        JSON.stringify({ rooms: [{ room: "x", clientCount: 1, lastFocusedAt: 1 }] }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const c = new CanvasClient({ baseUrl: "http://test" });
      const r = await c.getActiveRooms();
      expect(r.rooms[0].room).toBe("x");
    } finally {
      globalThis.fetch = original;
    }
  });
});
