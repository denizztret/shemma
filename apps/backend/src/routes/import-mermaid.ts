import { Hono } from "hono";
import { resolveRoomId } from "../rooms";
import type { WsHub } from "../ws";

/**
 * POST /api/agent/import-mermaid
 *
 * Sends an import-mermaid command to the first connected WS subscriber in the
 * room, waits up to 10s for the frontend result, returns shape ids / didraw names.
 *
 * Body: { source: string; clientOpId? }
 * Query: ?room=<room-id>
 *
 * Append-only: never replaces or deletes existing shapes. Wiping the canvas is
 * a separate (not-yet-implemented) explicit `shemma_clear_room` operation.
 *
 * Responses:
 *  200 { shape_ids, didraw_names, root_ids }
 *  400 missing source
 *  503 { error: "no client connected", room_url } — caller should open
 *      `room_url` in a browser and retry once.
 *  500 timeout or frontend error
 */
export function importMermaidRoutes(bus: WsHub) {
  return new Hono().post("/api/agent/import-mermaid", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ error: rv.reason }, 422);
    const room = rv.id;

    const body = (await c.req.json().catch(() => null)) as {
      source?: unknown;
      clientOpId?: unknown;
      focus?: unknown;
    } | null;

    if (!body || typeof body.source !== "string" || body.source.trim() === "") {
      return c.json({ error: "source is required" }, 400);
    }

    const source = body.source;
    // DRW-086: optional viewport behavior after import. Validate and pass through.
    const VALID_FOCUS = ["new", "fit-all", "none"] as const;
    type FocusMode = (typeof VALID_FOCUS)[number];
    const focus: FocusMode | undefined =
      typeof body.focus === "string" && (VALID_FOCUS as readonly string[]).includes(body.focus)
        ? (body.focus as FocusMode)
        : undefined;

    if (bus.subscriberCount(room) === 0) {
      // Build canonical room URL so AI can open the tab and retry. We surface
      // the request's host (works across profiles/ports) rather than hard-coding.
      const reqUrl = new URL(c.req.url);
      const roomUrl = `${reqUrl.protocol}//${reqUrl.host}/?room=${encodeURIComponent(room)}`;
      return c.json({ error: "no client connected", room_url: roomUrl }, 503);
    }

    const requestId = crypto.randomUUID();

    try {
      const result = await bus.sendImportMermaid(room, requestId, source, focus);
      if (!result.ok) {
        return c.json({ error: result.error ?? "import failed" }, 500);
      }
      return c.json({
        ok: true,
        shape_ids: result.shape_ids ?? [],
        didraw_names: result.didraw_names ?? [],
        root_ids: result.root_ids ?? [],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return c.json({ error: message }, 500);
    }
  });
}
