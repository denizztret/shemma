import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { ActiveRoomsTracker } from "../ws/active-rooms";
import { activeRoomsRoutes } from "./active-rooms";

function makeApp(tracker: ActiveRoomsTracker) {
  return new Hono().route("/", activeRoomsRoutes(tracker));
}

describe("GET /api/active-rooms", () => {
  it("returns empty array when nothing focused", async () => {
    const t = new ActiveRoomsTracker();
    const res = await makeApp(t).request("/api/active-rooms");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rooms: [] });
  });

  it("returns focused rooms sorted by lastFocusedAt desc", async () => {
    let now = 1000;
    const t = new ActiveRoomsTracker({ now: () => now });
    t.onFocus("a", "c1");
    now = 2000;
    t.onFocus("b", "c2");
    const res = await makeApp(t).request("/api/active-rooms");
    const body = (await res.json()) as { rooms: Array<{ room: string }> };
    expect(body.rooms.map((r) => r.room)).toEqual(["b", "a"]);
  });

  it("counts multiple clients", async () => {
    const t = new ActiveRoomsTracker();
    t.onFocus("a", "c1");
    t.onFocus("a", "c2");
    const res = await makeApp(t).request("/api/active-rooms");
    const body = (await res.json()) as { rooms: Array<{ clientCount: number }> };
    expect(body.rooms[0].clientCount).toBe(2);
  });
});
