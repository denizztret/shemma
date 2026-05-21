import { Hono } from "hono";
import type { ActiveRoomsTracker } from "../ws/active-rooms";

/**
 * DRW-116 Task 11: `/api/active-rooms` stays in `SPACE_ALLOWLIST` (cross-space
 * aggregate view), but an optional `?space=<id>` query string filters the
 * response to a single space — used by the gallery UI to scope presence
 * indicators to its own workspace.
 */
export function activeRoomsRoutes(tracker: ActiveRoomsTracker) {
  return new Hono().get("/api/active-rooms", (c) => {
    const space = c.req.query("space");
    return c.json({ rooms: tracker.list(space ? { space } : {}) });
  });
}
