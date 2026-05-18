import { Hono } from "hono";
import type { ActiveRoomsTracker } from "../ws/active-rooms";

export function activeRoomsRoutes(tracker: ActiveRoomsTracker) {
  return new Hono().get("/api/active-rooms", (c) => {
    return c.json({ rooms: tracker.list() });
  });
}
