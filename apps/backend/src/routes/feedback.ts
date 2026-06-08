import { Hono } from "hono";
import { buildAnnotationRecord } from "../feedback/record";
import type { FeedbackWriter } from "../feedback/writer";
import { resolveRoomId } from "../rooms";
import { bundleForRequest } from "./_space-context";

const MAX_FIELD_BYTES = 4096;

/**
 * POST /api/agent/feedback  (DRW-227.02)
 *
 * Appends an optional agent annotation ("what I wanted / where I got stuck")
 * to the same per-room JSONL as the objective backbone (DRW-227.01). Purely
 * additive — the backbone works with zero annotations.
 *
 * This route is intentionally NOT in the backbone allowlist, so the annotation
 * POST itself is never logged as a `request` record (no noise / recursion).
 *
 * Body: { text: string (required); phase?: "intent"|"blocker"|"resolution";
 *         clientOpId?; agent?; sessionId? }
 * Query: ?room=<room-id>
 *
 * Responses:
 *  200 { ok: true, recorded: true }                       — appended
 *  200 { ok: true, recorded: false, reason }              — feedback disabled / write failed
 *  400 { error: "text is required" }
 *  422 { error }                                          — bad room
 *
 * `writer` is undefined when SHEMMA_FEEDBACK is off → the route no-ops with
 * `recorded:false` so the agent's call never fails.
 */
export function feedbackRoutes(writer?: FeedbackWriter) {
  return new Hono().post("/api/agent/feedback", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ error: rv.reason }, 422);
    const room = rv.id;

    const body = (await c.req.json().catch(() => null)) as {
      text?: unknown;
      phase?: unknown;
      clientOpId?: unknown;
      agent?: unknown;
      sessionId?: unknown;
    } | null;

    if (!body || typeof body.text !== "string" || body.text.trim() === "") {
      return c.json({ error: "text is required" }, 400);
    }

    if (!writer) {
      return c.json({ ok: true, recorded: false, reason: "feedback disabled" });
    }

    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.length > 0 ? v : undefined;

    try {
      const { space } = bundleForRequest(c);
      const record = buildAnnotationRecord({
        ts: new Date().toISOString(),
        space: space.id,
        room,
        text: body.text,
        phase: str(body.phase),
        clientOpId: str(body.clientOpId),
        agent: str(body.agent),
        sessionId: str(body.sessionId),
        maxFieldBytes: MAX_FIELD_BYTES,
      });
      writer.append(space.id, room, record);
      return c.json({ ok: true, recorded: true });
    } catch {
      // best-effort: never fail the agent on a logging error
      return c.json({ ok: true, recorded: false, reason: "write failed" });
    }
  });
}
