import type { SpaceRecord } from "@shemma/spaces";
import { resolveStorageRoot } from "@shemma/spaces";
import type { Context } from "hono";
import { config } from "../config";

/**
 * DRW-116 Task 11 — "prefer middleware, fall back to legacy closure" pattern.
 *
 * Routes call `resolveSpaceForRequest(c, fallbackStorageDir)` instead of
 * reading the closure-captured `storageDir`. When `spaceMiddleware` is
 * mounted (production daemon path, opt-in via `makeApp({ enableSpaceMiddleware:
 * true })`), the active `SpaceRecord` is on the Hono context — we honour it
 * verbatim. When the middleware is OFF (legacy test/in-process flow), the
 * helper synthesises the same `direct`-layout legacy `SpaceRecord` that
 * `makeApp` uses for `SingleSpacePersistence` so storage paths stay identical.
 *
 * This lets us migrate routes incrementally without forcing the whole test
 * suite to register `/api/spaces` and thread `?space=<id>` on every call.
 */
export function resolveSpaceForRequest(
  c: Context,
  fallbackStorageDir: string,
): SpaceRecord {
  const ctxSpace = c.get("space") as SpaceRecord | undefined;
  if (ctxSpace) return ctxSpace;
  const now = new Date(0).toISOString();
  return {
    id: `legacy:${fallbackStorageDir}`,
    path: fallbackStorageDir,
    storageLayout: "direct",
    createdAt: now,
    lastUsedAt: now,
  };
}

/**
 * Resolve the on-disk storage root (directory containing `<roomId>.json`
 * files plus `.archive/`) for the current request. Mirrors the legacy
 * `storageDir` closure value but defers to per-request space context when
 * middleware is enabled.
 */
export function resolveStorageDirForRequest(
  c: Context,
  fallbackStorageDir: string,
): string {
  const space = resolveSpaceForRequest(c, fallbackStorageDir);
  return resolveStorageRoot(space, config.profile);
}
