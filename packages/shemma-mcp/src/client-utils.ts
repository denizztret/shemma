import { CanvasClient } from "@shemma/client";

/**
 * Build a CanvasClient scoped to a specific room (and optionally space).
 *
 * When `space` is undefined the existing `base.space` (`__legacy__` for
 * single-space daemons) is preserved — guarantees back-compat for callers
 * that don't yet resolve space.
 *
 * DRW-116 Task 26: room-scoped MCP handlers resolve `space` via the
 * space-resolver and pass the id through here so backend `bundleForRequest`
 * routes to the right space bundle.
 */
export function clientForRoom(
  base: CanvasClient,
  room: string | undefined,
  space?: string,
): CanvasClient {
  if (!room && !space) return base;
  return new CanvasClient({
    baseUrl: base.baseUrl,
    room,
    space: space ?? base.space,
  });
}
