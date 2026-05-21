import type { MiddlewareHandler } from "hono";
import { SPACE_ID_PATTERN, findSpaceById } from "@shemma/spaces";

/**
 * Resolves `?space=<id>` query parameter into a `SpaceRecord` on the Hono
 * context (`c.set("space", ...)`). Enforces composite-key invariant per
 * spec §6.2 — every authenticated `/api/*` route must address a specific
 * space.
 *
 * Validation order:
 *   1. `allowList` short-circuits (e.g. /api/health, /api/version).
 *   2. Missing `?space=` → 400 `space_required`.
 *   3. Malformed id (not matching SPACE_ID_PATTERN) → 400 `invalid_space_id`.
 *   4. Unknown id (no registry record) → 404 `space_not_found`.
 *   5. Resolved record stored on context for downstream handlers.
 *
 * Mounted opt-in via `makeApp({ enableSpaceMiddleware: true })`. Default is
 * OFF so the bulk of legacy backend tests (still calling /api/state?room=…
 * without ?space=) continue to pass; Task 11 of DRW-116 flips production
 * code and migrates tests in one pass.
 */
export function spaceMiddleware(
  opts: { allowList?: Set<string> } = {},
): MiddlewareHandler {
  const allowList = opts.allowList ?? new Set<string>();
  return async (c, next) => {
    if (allowList.has(c.req.path)) {
      await next();
      return;
    }
    const spaceId = c.req.query("space");
    if (!spaceId) return c.json({ error: "space_required" }, 400);
    if (!SPACE_ID_PATTERN.test(spaceId)) {
      return c.json({ error: "invalid_space_id" }, 400);
    }
    const record = findSpaceById(spaceId);
    if (!record) return c.json({ error: "space_not_found", id: spaceId }, 404);
    c.set("space", record);
    await next();
  };
}
