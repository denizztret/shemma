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
 *
 * DRW-116 Task 11: `/api/health` остаётся в SPACE_ALLOWLIST (cross-space probe,
 * без `?space=`) — поэтому `c.get("space")` тут заведомо undefined. Поле
 * `storage` продолжает репортить тот же closure-resolved `storageDir`, что и в
 * pre-Task-11 версии: для daemon-mode это `resolveLegacyStorageDir` (single-
 * space fallback), для тестов — `startServer({ storageDir })` override. Per-
 * space storage roots discoverable через `/api/spaces` registry.
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

