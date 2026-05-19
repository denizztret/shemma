import { Hono } from "hono";
import { resolveRoomId } from "../rooms";
import type { WsHub } from "../ws";

/**
 * POST /api/agent/import-mermaid
 *
 * Sends an import-mermaid command to the first connected WS subscriber in the
 * room, waits up to 10s for the frontend result, returns shape ids / didraw names.
 *
 * Body: { source: string; mode?: "append" | "replace"; clientOpId?: string }
 * Query: ?room=<room-id>
 *
 * Responses:
 *  200 { shape_ids, didraw_names, root_ids }
 *  400 missing source
 *  503 no client connected
 *  500 timeout or frontend error
 */
export function importMermaidRoutes(bus: WsHub) {
  return new Hono().post("/api/agent/import-mermaid", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ error: rv.reason }, 422);
    const room = rv.id;

    const body = (await c.req.json().catch(() => null)) as {
      source?: unknown;
      mode?: unknown;
      clientOpId?: unknown;
    } | null;

    if (!body || typeof body.source !== "string" || body.source.trim() === "") {
      return c.json({ error: "source is required" }, 400);
    }

    const source = body.source;
    const mode: "append" | "replace" =
      body.mode === "replace" ? "replace" : "append";

    if (bus.subscriberCount(room) === 0) {
      return c.json({ error: "no client connected" }, 503);
    }

    const requestId = crypto.randomUUID();

    try {
      const result = await bus.sendImportMermaid(room, requestId, source, mode);
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
