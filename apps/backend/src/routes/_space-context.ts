import type { SpaceRecord } from "@shemma/spaces";
import { resolveStorageRoot } from "@shemma/spaces";
import type { Context } from "hono";
import { config } from "../config";
import type { Rooms } from "../rooms";
import type { RoomState } from "../types";

/**
 * Per-request bundle of state owned by a single space.
 *
 * DRW-116 Task 11: every `(spaceId)` keyed by `makeApp` owns its own `Rooms`
 * map + `SingleSpacePersistence` adapter. Routes resolve the bundle for the
 * active request via {@link bundleForRequest} so two concurrent `?space=A`
 * and `?space=B` requests can't share in-memory `RoomState` or write into
 * the wrong storage layout.
 *
 * Persistence is intentionally typed as `unknown` here to avoid pulling the
 * `SingleSpacePersistence` class through routes (and to keep the
 * helper module free of `index.ts` import cycles). Routes only need
 * {@link SpaceBundle.scheduleSave} via the `onDirty` callback the bundle
 * exposes; the underlying persistence is a private concern of `makeApp`.
 */
export type SpaceBundle = {
  /** Space the bundle belongs to. `legacy:<storageDir>` for the closure-fallback case. */
  space: SpaceRecord;
  /** Per-space `Rooms` instance — owns the in-memory `Map<RoomId, RoomState>`. */
  rooms: Rooms;
  /**
   * Schedules a debounced save into the per-space `FilePersistence`. Wired
   * into route handlers as `onDirty` so we don't have to thread the raw
   * persistence facade through public route signatures.
   */
  scheduleSave: (room: string, state: RoomState) => void;
  /** Flush pending debounced write for a single room id (no-op if not dirty). */
  flushIfDirty: (room: string) => Promise<void>;
  /** Forces every pending debounced write for this bundle's space to flush. */
  flushAll: () => Promise<void>;
};

/**
 * Hono middleware factory injected by `makeApp` so routes can call
 * {@link bundleForRequest} without importing `index.ts` (which would cycle).
 * Each request gets a fresh resolver closure that already knows the legacy
 * bundle and the per-space cache lookup.
 */
export type BundleResolver = (c: Context) => SpaceBundle;

const RESOLVER_KEY = "__shemma_bundle_resolver__";

/** Mounted by `makeApp` before any route registers; stores `resolver` on `c`. */
export function installBundleResolver(resolver: BundleResolver) {
  return async (c: Context, next: () => Promise<void>): Promise<void> => {
    c.set(RESOLVER_KEY, resolver);
    await next();
  };
}

/**
 * Read the active space bundle from the Hono context. Throws if the resolver
 * middleware wasn't mounted — that would indicate a `makeApp` bug, not a
 * missing query param, so a hard failure is correct.
 */
export function bundleForRequest(c: Context): SpaceBundle {
  const resolver = c.get(RESOLVER_KEY) as BundleResolver | undefined;
  if (!resolver) {
    throw new Error(
      "shemma: bundleForRequest called without installBundleResolver — makeApp bug",
    );
  }
  return resolver(c);
}

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
