import { Hono } from "hono";
import {
  findSpaceById,
  resolveStorageRoot,
  SPACE_ID_PATTERN,
} from "@shemma/spaces";
import { config } from "../config";
import { VERSION } from "../version";

// `config` is referenced lazily inside the route handler — getProfile() reads
// SHEMMA_PROFILE at request time, which keeps in-process test daemons (which
// don't touch process.env) honest about their own profile.


/**
 * Health endpoint factory.
 *
 * `/healthz` — legacy `{ ok: true }` (preserved for compatibility with
 *   `CanvasClient.health()` boolean probe и Playwright wait-on).
 *
 * `/api/health` — extended status used by `shemma open` to detect daemon
 *   storage conflicts (DRW-052) and by `shemma_health` MCP tool to verify
 *   where writes land for a given space (DRW-126).
 *
 * Response shape:
 *   - `ok`, `profile`, `version`, `pid` — daemon-level scalars (always present).
 *   - `storage` — directory containing room JSON files. Resolution:
 *       1. If `?space=<id>` present AND valid AND registered → per-space
 *          storage via `resolveStorageRoot(record, profile)` (DRW-126).
 *       2. Otherwise → closure-captured daemon-default `storageDir` (which
 *          for daemon mode is `resolveLegacyStorageDir(profile)`).
 *   - `space` — present iff request resolved to a registered space.
 *   - `fallback: true` — present iff `storage` is the daemon-default fallback
 *     (no `?space=`). Tells agents "this path is global, not necessarily
 *     where any specific space writes". Distinguishes a healthy multi-space
 *     daemon from a single-space legacy daemon.
 *
 * `/api/health` is in SPACE_ALLOWLIST so the global space middleware doesn't
 * enforce `?space=`. The route resolves the optional param itself.
 *
 * Errors (only when `?space=` is provided):
 *   - 400 `{error: "invalid_space_id"}` — malformed id (fails SPACE_ID_PATTERN).
 *   - 404 `{error: "space_not_found"}` — registry has no record with that id.
 *
 * `storageDir` параметр передаётся явно (instead of reading a global),
 * чтобы honor'ить `startServer({ storageDir })` override — иначе in-process
 * test daemons и `--storage` flag репортили бы ambient default path.
 */
export function makeHealthRoutes(storageDir: string) {
  return new Hono()
    .get("/healthz", (c) => c.json({ ok: true }))
    .get("/api/health", (c) => {
      const base = {
        ok: true as const,
        profile: config.profile,
        version: VERSION.version,
        pid: process.pid,
      };
      const spaceId = c.req.query("space");
      if (!spaceId) {
        return c.json({ ...base, storage: storageDir, fallback: true });
      }
      if (!SPACE_ID_PATTERN.test(spaceId)) {
        return c.json({ error: "invalid_space_id" }, 400);
      }
      const record = findSpaceById(spaceId);
      if (!record) {
        return c.json({ error: "space_not_found", id: spaceId }, 404);
      }
      return c.json({
        ...base,
        storage: resolveStorageRoot(record, config.profile),
        space: record.id,
        fallback: false,
      });
    });
}
