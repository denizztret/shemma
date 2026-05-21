import { Hono } from "hono";
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
 *   storage conflicts (DRW-052). Returns `profile`, resolved `storage` path
 *   (включая profile subdir) и `version`, чтобы CLI мог сравнить cwd-target
 *   с активным daemon'ом и предупредить о mismatched storage.
 *
 * `storageDir` параметр передаётся явно (instead of reading a global),
 * чтобы honor'ить `startServer({ storageDir })` override — иначе in-process
 * test daemons и `--storage` flag репортили бы ambient default path.
 * DRW-116 Task 10b: the ambient default now comes from `resolveLegacyStorageDir`
 * (single-space fallback); Task 11 will replace `storage` payload with the
 * per-space root resolved from `c.get("space")`.
 */
export function makeHealthRoutes(storageDir: string) {
  return new Hono()
    .get("/healthz", (c) => c.json({ ok: true }))
    .get("/api/health", (c) =>
      c.json({
        ok: true,
        profile: config.profile,
        storage: storageDir,
        version: VERSION.version,
        pid: process.pid,
      }),
    );
}

