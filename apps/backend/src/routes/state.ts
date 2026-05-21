import { Hono } from "hono";
import { resolveRoomId } from "../rooms";
import { isPlaceholderSchema } from "../ws-protocol";
import { bundleForRequest } from "./_space-context";

export function stateRoutes() {
  return (
    new Hono()
      .get("/api/state", async (c) => {
        const rv = resolveRoomId(c.req.query("room"));
        if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
        const id = rv.id;
        const sinceRaw = c.req.query("since");
        const { rooms } = bundleForRequest(c);
        const r = await rooms.get(id);

        if (sinceRaw !== undefined && !Number.isNaN(Number(sinceRaw))) {
          const since = Number(sinceRaw);
          // opLog is in-memory only (lost on restart). If the requested window
          // predates the oldest retained entry, we cannot honour incremental sync —
          // signal `truncated:true` so the client knows to fetch a full snapshot
          // instead of silently treating the gap as no-op.
          const minLogVersion = r.opLog[0]?.version;
          const canServe =
            since >= r.version ||
            (minLogVersion !== undefined && minLogVersion <= since + 1);
          if (!canServe) {
            return c.json({ since, version: r.version, truncated: true });
          }
          return c.json({
            since,
            version: r.version,
            diff: r.opLog.filter((e) => e.version > since),
          });
        }

        return c.json({
          version: r.version,
          store: r.store,
          prompts: r.prompts,
          aiActivity: r.aiActivity ?? null,
        });
      })
      // DRW-047: clients may upload their real V2 tldraw schema via REST before
      // the first GET /api/state, so the initial snapshot already carries a usable
      // schema. Mirrors the WS hello upgrade path (ws-protocol.handleHello):
      // replace only when the stored schema is still the V1 placeholder. Idempotent
      // for rooms that already hold a real schema (returns upgraded:false).
      .post("/api/state/seed-schema", async (c) => {
        const rv = resolveRoomId(c.req.query("room"));
        if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
        const id = rv.id;
        const body = (await c.req.json().catch(() => null)) as {
          schema?: unknown;
        } | null;
        if (
          !body ||
          body.schema === undefined ||
          body.schema === null ||
          typeof body.schema !== "object"
        ) {
          return c.json({ ok: false, error: "schema-required" }, 400);
        }
        const { rooms, scheduleSave } = bundleForRequest(c);
        const r = await rooms.get(id);
        let upgraded = false;
        if (
          isPlaceholderSchema(r.store.schema) &&
          !isPlaceholderSchema(body.schema)
        ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          r.store = { ...r.store, schema: body.schema as any };
          r.dirty = true;
          upgraded = true;
          scheduleSave(id, r);
        }
        return c.json({ ok: true, upgraded, version: r.version });
      })
  );
}
