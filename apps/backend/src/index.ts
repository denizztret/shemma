import fs from "node:fs";
import path from "node:path";
import { releaseLock, writeLockMetadata } from "@shemma/lockfile";
import { runStartupMigration } from "./migration/legacy-spaces.js";
import {
  DebouncedTouch,
  SPACE_ID_PATTERN,
  type SpaceRecord,
  findSpaceById,
  listSpaces,
  registerSpace,
} from "@shemma/spaces";
import type { Context } from "hono";
import { Hono } from "hono";
import { config, resolveLegacyStorageDir } from "./config";
import { EMBEDDED_ASSETS } from "./embedded-assets";
import { IdleTracker } from "./idle-tracker";
import { spaceMiddleware } from "./middleware/space";
import type { FilePersistence } from "./persistence";
import { RoomCache } from "./room-cache";
import { type RoomStore, Rooms, pushOpLog, validateRoomId } from "./rooms";
import {
  type SpaceBundle,
  installBundleResolver,
} from "./routes/_space-context";
import { activeRoomsRoutes } from "./routes/active-rooms";
import { aiRoutes } from "./routes/ai";
import { canvasViewRoutes } from "./routes/canvas-view";
import { contextRoutes } from "./routes/context";
import { schemaRoutes } from "./routes/schema";
import { schemaDuplicateRoutes } from "./routes/schema-duplicate";
import { domainRoutes } from "./routes/domain";
import { exportRoutes } from "./routes/export";
import { makeHealthRoutes } from "./routes/health";
import { fitTextRoutes } from "./routes/fit-text";
import { importMermaidRoutes } from "./routes/import-mermaid";
import { boardLayoutParamsRoutes } from "./routes/board-layout-params";
import { boardStyleDefaultsRoutes } from "./routes/board-style-defaults";
import { boardContainerTitlePositionRoutes } from "./routes/board-container-title-position";
import { styleApplyRoutes } from "./routes/style-apply";
import { layoutRoutes } from "./routes/layout";
import { layoutSelectionRoutes } from "./routes/layout-selection";
import { smartInsertRoutes } from "./routes/smart-insert";
import { promptRoutes } from "./routes/prompts";
import { roomsRoutes } from "./routes/rooms";
import { sessionRoutes } from "./routes/session";
import { spacesRouter } from "./routes/spaces";
import { stateRoutes } from "./routes/state";
import { versionRoutes } from "./routes/version";
import { viewportRoutes } from "./routes/viewport";
import {
  applyStoreChanges,
  isEmptyBatch,
  rebuildDidrawIndex,
} from "./store-ops";
import { DEFAULT_ROOM, type RoomState } from "./types";
import { type Sock, WsHub } from "./ws";
import { handleHello, parseClientMessage } from "./ws-protocol";

export type AppOpts = {
  inMemory?: boolean;
  port?: number;
  /**
   * DRW-116 Task 10b: explicit storage directory override.
   *
   * When provided, `makeApp` synthesizes a `SpaceRecord` with `storageLayout:
   * "direct"` so rooms land exactly under `<storageDir>/<id>.json` (no
   * `.shemma/canvas` subdir tacked on). Used by:
   *   - tests that want a tmpdir-scoped backend
   *   - `--storage <path>` daemon flag → child receives `SHEMMA_STORAGE_DIR`
   * Omitted → falls back to `resolveLegacyStorageDir(config.profile)` for
   * single-space daemons until Task 11 wires per-request space lookup.
   */
  storageDir?: string;
  /**
   * Optional idle tracker. When provided, every `/api/*` request resets the
   * activity timestamp. Tests omit this to avoid leaking intervals; the
   * daemon-mode `startServer` constructs a live tracker and passes it in.
   */
  idle?: IdleTracker;
  /**
   * DRW-116: mount `spaceMiddleware` on `/api/*` to enforce `?space=<id>`
   * presence + registry lookup. OFF by default so legacy backend tests
   * AND the running daemon (which still receives /api/state?room=… from
   * legacy CLI/frontend clients) keep working. Task 11 flips the default
   * to ON and migrates every caller in one pass; until then the flag is
   * strictly opt-in.
   */
  enableSpaceMiddleware?: boolean;
  /**
   * DRW-116 W3: callback fired by `spaceMiddleware` whenever a real
   * `SpaceRecord` is resolved for a request. Production daemon wires this
   * to `DebouncedTouch.touch(space.id)` so the registry's `lastUsedAt`
   * reflects actual API usage (the field was previously only updated on
   * registration or rename, leaving long-running spaces "stale" in
   * `s list --by-last-used`).
   */
  onSpaceResolved?: (space: SpaceRecord) => void;
};

/**
 * Routes that intentionally do NOT require a `?space=<id>`. Cross-space
 * concerns (health probes, version, server-side session metadata, the
 * aggregated active-rooms view, the spaces registry itself, and the global
 * miro-boards listing) live here.
 */
export const SPACE_ALLOWLIST: ReadonlySet<string> = new Set([
  "/api/health",
  "/api/version",
  "/api/session",
  "/api/active-rooms",
  "/api/export/miro/boards",
  // /api/spaces is its own router (added in DRW-116 Task 9) and remains
  // outside the per-space middleware path; the entry is reserved for the
  // forthcoming router prefix even though Hono's `app.use("/api/*")` will
  // skip non-existent paths anyway.
]);

/**
 * Daemon-wide RoomCache singleton. Keyed by `(spaceId, roomId)` → returns the
 * same `FilePersistence` instance per pair so debounced writes survive across
 * HTTP/WS requests in the same room.
 *
 * The cache is lazily instantiated on first `getRoomCache()` call (in-process
 * test usage that never asks for it will not pay the timer cost). Daemon
 * shutdown calls `shutdown()` BEFORE `releaseLock` so pending writes flush.
 */
let _roomCache: RoomCache | undefined;
export function getRoomCache(): RoomCache {
  if (!_roomCache) _roomCache = new RoomCache(config.profile);
  return _roomCache;
}
/** Test-only: drop the cached instance so each test gets a fresh one. */
export function __resetRoomCacheForTests(): void {
  _roomCache = undefined;
}

/**
 * DRW-116 Task 10b: per-`makeApp` single-space persistence facade.
 *
 * Until Task 11 wires routes/WS to read the active `SpaceRecord` from
 * `c.get("space")`, every `makeApp` invocation owns ONE space (synthesized from
 * `opts.storageDir` when provided, or from the legacy `~/.claude/projects/...`
 * default). All `(load|save|scheduleSave|flushIfDirty)` calls thread that space
 * into `RoomCache.get(space, id)` to obtain the right `FilePersistence`.
 *
 * Future task: replace the facade with per-call space lookup once route
 * handlers and the WS message loop start passing `space` explicitly.
 */
class SingleSpacePersistence {
  constructor(
    private readonly space: SpaceRecord,
    private readonly cache: RoomCache,
  ) {}
  private fp(id: string): FilePersistence {
    return this.cache.get(this.space, id);
  }
  load(id: string) {
    return this.fp(id).load(id);
  }
  save(id: string, s: RoomState) {
    return this.fp(id).save(id, s);
  }
  scheduleSave(id: string, s: RoomState): void {
    this.fp(id).scheduleSave(id, s);
  }
  flushIfDirty(id: string): Promise<void> {
    return this.fp(id).flushIfDirty(id);
  }
  /**
   * Best-effort flush for shutdown chains that previously called
   * `StorageDirPersistence.flushAll()`. We delegate to the shared RoomCache
   * since this facade does not track which room ids it has ever touched —
   * the cache is the source of truth. The cache itself stays alive (its
   * timer keeps running) so subsequent `makeApp` calls from the same
   * in-process test session see fresh entries. The daemon's SIGTERM/SIGINT
   * chain calls `getRoomCache().shutdown()` explicitly below.
   */
  async flushAll(): Promise<void> {
    await this.cache.flushAll();
  }
}

/**
 * Synthesize a `SpaceRecord` for the legacy single-space flow: storage layout
 * `direct` means `resolveRoomStorage` treats `space.path` as the final storage
 * directory verbatim (no `.shemma/canvas` subdir tacked on). This preserves the
 * pre-Task-10b semantics where `--storage <path>` lands rooms exactly under
 * `<path>/<id>.json`.
 *
 * The synthetic space has a stable id `legacy-default` so `RoomCache` entries
 * for two `makeApp` instances pointing at the same dir share a `FilePersistence`
 * — matching the `workspace-isolation.test.ts` expectation that "same storageDir
 * see same rooms".
 */
function makeLegacySpace(storageDir: string): SpaceRecord {
  const now = new Date(0).toISOString();
  return {
    id: `legacy:${storageDir}`,
    path: storageDir,
    storageLayout: "direct",
    createdAt: now,
    lastUsedAt: now,
  };
}

export function makeApp(opts: AppOpts = {}) {
  // DRW-116 Task 11: per-space bundle registry.
  //
  // Each space the daemon ever sees gets its own `Rooms` (in-memory state) +
  // `SingleSpacePersistence` (debounced write adapter for the cache entry
  // matching that space). Bundles are created lazily on first request — the
  // legacy bundle for `opts.storageDir` / `resolveLegacyStorageDir(...)` is
  // pre-seeded so existing tests that call `makeApp(...).rooms` see the same
  // instance they always did.
  const inMemory = !!opts.inMemory;
  const bundles = new Map<string, SpaceBundle>();

  function bundleForSpace(space: SpaceRecord): SpaceBundle {
    const cached = bundles.get(space.id);
    if (cached) return cached;
    const persistence = inMemory
      ? null
      : new SingleSpacePersistence(space, getRoomCache());
    const store: RoomStore = persistence
      ? {
          load: (id) => persistence.load(id),
          save: (id, s) => persistence.save(id, s),
        }
      : { load: async () => null, save: async () => {} };
    const rooms = new Rooms(store);
    if (persistence) rooms.setPersistence(persistence);
    const bundle: SpaceBundle = {
      space,
      rooms,
      scheduleSave: persistence
        ? (id, s) => persistence.scheduleSave(id, s)
        : () => {},
      flushIfDirty: persistence
        ? (id) => persistence.flushIfDirty(id)
        : async () => {},
      flushAll: persistence ? () => persistence.flushAll() : async () => {},
    };
    bundles.set(space.id, bundle);
    return bundle;
  }

  // DRW-116 Task 10b: synthesize a SpaceRecord for the legacy single-space flow.
  // `opts.storageDir` (test path + `--storage` flag override) wins; otherwise
  // fall back to the per-project default that used to be `config.storageDir`.
  // The legacy bundle is the default fallback when `?space=<id>` is absent
  // (test path with `enableSpaceMiddleware` off) — and the value exposed via
  // `makeApp(...).rooms` for backwards-compatible test access.
  const storageDir = opts.storageDir ?? resolveLegacyStorageDir(config.profile);
  const legacySpace = makeLegacySpace(storageDir);
  const legacyBundle = bundleForSpace(legacySpace);

  // Resolver used by every route handler to obtain its (space, rooms) tuple.
  // Reads `c.get("space")` when `spaceMiddleware` set it; otherwise returns
  // the legacy bundle so middleware-off tests keep working unchanged.
  const bundleResolver = (c: Context): SpaceBundle => {
    const ctxSpace = c.get("space") as SpaceRecord | undefined;
    if (ctxSpace) return bundleForSpace(ctxSpace);
    return legacyBundle;
  };

  const bus = new WsHub();
  const app = new Hono();

  if (opts.idle) {
    const idle = opts.idle;
    app.use("/api/*", async (c, next) => {
      idle.noteHttp();
      await next();
    });
  }
  // DRW-116 Task 9: spaces router mounts BEFORE spaceMiddleware so the
  // per-space `?space=<id>` invariant never applies to the registry itself.
  // Hono matches routes top-down; an earlier `app.route()` short-circuits
  // before any later `app.use("/api/*", …)` middleware sees the request.
  app.route("/", spacesRouter);
  if (opts.enableSpaceMiddleware) {
    app.use(
      "/api/*",
      spaceMiddleware({
        allowList: new Set(SPACE_ALLOWLIST),
        onResolve: opts.onSpaceResolved,
      }),
    );
  }
  // Bundle resolver mounts AFTER spaceMiddleware so handlers downstream see
  // `c.get("space")` already populated. Routes pull (space, rooms, scheduleSave)
  // exclusively through `bundleForRequest(c)` from here on.
  app.use("/api/*", installBundleResolver(bundleResolver));

  app.route("/", makeHealthRoutes(storageDir));
  app.route("/", versionRoutes);
  app.route("/", sessionRoutes);
  app.route("/", stateRoutes());
  app.route("/", layoutRoutes(bus));
  app.route("/", layoutSelectionRoutes(bus));
  app.route("/", boardLayoutParamsRoutes({
    getRoom: async (space, room) => {
      const bundle = bundles.get(space) ?? legacyBundle;
      try {
        return await bundle.rooms.get(room);
      } catch {
        return undefined;
      }
    },
    persistRoom: (space, room) => {
      const bundle = bundles.get(space) ?? legacyBundle;
      const state = bundle.rooms.peek(room);
      if (state) bundle.scheduleSave(room, state);
    },
    broadcastRoomMeta: () => {},
  }));
  app.route("/", boardStyleDefaultsRoutes({
    getRoom: async (space, room) => {
      const bundle = bundles.get(space) ?? legacyBundle;
      try {
        return await bundle.rooms.get(room);
      } catch {
        return undefined;
      }
    },
    persistRoom: (space, room) => {
      const bundle = bundles.get(space) ?? legacyBundle;
      const state = bundle.rooms.peek(room);
      if (state) bundle.scheduleSave(room, state);
    },
    broadcastRoomMeta: () => {},
  }));
  app.route("/", boardContainerTitlePositionRoutes({
    getRoom: async (space, room) => {
      const bundle = bundles.get(space) ?? legacyBundle;
      try {
        return await bundle.rooms.get(room);
      } catch {
        return undefined;
      }
    },
    persistRoom: (space, room) => {
      const bundle = bundles.get(space) ?? legacyBundle;
      const state = bundle.rooms.peek(room);
      if (state) bundle.scheduleSave(room, state);
    },
    broadcastRoomMeta: () => {},
  }));
  app.route("/", styleApplyRoutes(bus));
  app.route("/", smartInsertRoutes(bus));
  app.route("/", promptRoutes(bus));
  app.route("/", aiRoutes(bus));
  app.route("/", roomsRoutes(storageDir));
  app.route("/", viewportRoutes());
  app.route("/", domainRoutes(bus));
  app.route("/", schemaRoutes(bus));
  app.route("/", schemaDuplicateRoutes(bus));
  app.route("/", contextRoutes());
  app.route("/", canvasViewRoutes());
  app.route("/", importMermaidRoutes(bus));
  app.route("/", fitTextRoutes(bus));
  app.route("/", activeRoomsRoutes(bus.getActiveRooms()));
  app.route("/", exportRoutes());
  return {
    app,
    bus,
    // Backward-compat exports — legacy single-space tests assert against these.
    rooms: legacyBundle.rooms,
    persistence: inMemory ? null : legacyBundle,
    // DRW-116 Task 11 multi-space hooks (used by integration tests).
    legacyBundle,
    bundleForSpace,
    bundles,
  };
}

// In compiled binary EMBEDDED_ASSETS maps URL paths → /$bunfs/... virtual paths
// (populated by scripts/build-release.sh before --compile). In dev/uncompiled
// mode the map is empty and we fall back to reading from a disk frontend-dist.
const DEV_FRONTEND_DIST = `${import.meta.dir}/frontend-dist`;

async function tryServeFrontend(pathname: string): Promise<Response | null> {
  const assetPath = pathname === "/" ? "/index.html" : pathname;
  const embedded = EMBEDDED_ASSETS[assetPath];
  if (embedded) return new Response(Bun.file(embedded));
  const onDisk = Bun.file(`${DEV_FRONTEND_DIST}${assetPath}`);
  if (await onDisk.exists()) return new Response(onDisk);
  return null;
}

export async function startServer(opts: AppOpts = {}) {
  // Idle tracker is daemon-only: in-process test usage (lifecycle.http.test
  // and friends) would otherwise leak intervals and risk killing the test
  // runner via the default `process.exit(0)` onIdle. Gate matches the same
  // condition as the SIGTERM handler installation below.
  const daemonMode = import.meta.main || !!process.env.SHEMMA_LOCK_DIR;

  // DRW-116 Task 23: deprecate SHEMMA_STORAGE_DIR. Only warn + auto-register
  // at actual daemon entry point — not in tests or in-process usage.
  //
  // DRW-120 recursion guard: lifecycle.open() exports SHEMMA_STORAGE_DIR =
  // `<cwd>/.shemma/canvas` when spawning a child daemon (legacy compat). If
  // that path is the canvas storage of an already-registered `project`-layout
  // space (e.g. cwd IS di.draw, which is registered with project layout),
  // auto-registering it again would create a confusing nested orphan. Skip
  // when the path resolves into an existing space.
  if (process.env.SHEMMA_STORAGE_DIR && daemonMode) {
    const storageDirRaw = process.env.SHEMMA_STORAGE_DIR;
    const storageDirAbs = fs.existsSync(storageDirRaw)
      ? fs.realpathSync(storageDirRaw)
      : path.resolve(storageDirRaw);
    const containingSpace = listSpaces().find((s) => {
      const sPath = s.path.endsWith(path.sep) ? s.path : s.path + path.sep;
      return (
        storageDirAbs === s.path || storageDirAbs.startsWith(sPath)
      );
    });
    if (containingSpace) {
      console.error(
        `[shemma] SHEMMA_STORAGE_DIR points inside registered space '${containingSpace.id}' (${containingSpace.path}) — skipping auto-register.`,
      );
    } else {
      console.error(
        `[shemma] WARNING: SHEMMA_STORAGE_DIR is deprecated. Use 'shemma s add <path>' to register a space.`,
      );
      try {
        const { space, created } = registerSpace(storageDirRaw, {
          storageLayout: "direct",
          label: "Default (from SHEMMA_STORAGE_DIR)",
          id: "default",
        });
        if (created) {
          console.error(`[shemma] Auto-registered as space '${space.id}'.`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[shemma] Failed to auto-register: ${msg}`);
      }
    }
  }
  // DRW-116 Task 30: auto-register legacy ~/.claude/projects/*/canvas/ on first
  // boot. Idempotent — skipped when spaces.json already exists.
  if (daemonMode) {
    const migResult = runStartupMigration({
      skipFlag: process.env.SHEMMA_SKIP_LEGACY_MIGRATION === "1",
    });
    if (migResult.skipped) {
      console.error("[shemma] SHEMMA_SKIP_LEGACY_MIGRATION=1 — skipping legacy migration scan");
    } else if (migResult.migrated > 0) {
      console.error(
        `[shemma] Legacy migration: ${migResult.migrated} project(s) auto-registered. Default space: ${migResult.defaultId ?? "(none)"}`,
      );
    }
  }

  // onIdle is patched below to point at the graceful `shutdown` chain; until
  // then we never fire (the interval has not started ticking yet). Using a
  // forwarding closure lets IdleTracker exist before `shutdown` is declared
  // while still routing idle-exit through the same flush + releaseLock path
  // SIGTERM uses (a raw process.exit(0) would leak the lock dir).
  let onIdleFire: () => void = () => process.exit(0);
  const idle = daemonMode
    ? new IdleTracker(undefined, () => onIdleFire())
    : undefined;
  // DRW-116 W3: debounced lastUsedAt updates. Only in daemon mode — in-process
  // test usage skips it to avoid leaking timers + writes into the user's real
  // ~/.config/shemma/spaces.json. The middleware fires `onResolve(space)` on
  // every real-space request (allowlist routes skipped).
  const debouncedTouch = daemonMode ? new DebouncedTouch() : undefined;

  // DRW-116 C1: production daemon MUST enforce composite-key invariant via
  // spaceMiddleware. Tests calling `makeApp({ storageDir })` keep the
  // middleware off (compat preserved). The `enableSpaceMiddleware` flag in
  // `opts` (if a future caller passes it explicitly) wins over the
  // daemonMode-derived default.
  //
  // DRW-138: compute the effective value ONCE so that both the HTTP path
  // (via makeApp → spaceMiddleware) and the WS path (via resolveWsSpace below)
  // agree on whether the registry is authoritative. Reading `opts.enable…`
  // directly inside `resolveWsSpace` silently dropped to `undefined` and
  // landed every WS upgrade in the legacy bundle, while HTTP correctly used
  // the daemonMode-derived `true` — splitting persistence into two
  // in-memory states for the same (space, room).
  const effectiveSpaceMiddleware = opts.enableSpaceMiddleware ?? daemonMode;
  const { app, bus, persistence, bundleForSpace, legacyBundle } = makeApp({
    ...opts,
    idle,
    enableSpaceMiddleware: effectiveSpaceMiddleware,
    onSpaceResolved: debouncedTouch
      ? (s) => debouncedTouch.touch(s.id)
      : undefined,
  });
  /**
   * DRW-116 Task 12 — resolve `(space, room)` for a WS upgrade.
   *
   * When `enableSpaceMiddleware: true` AND `?space=<id>` is provided we
   * validate via the registry (same checks as HTTP `spaceMiddleware`):
   *   1. Format check — `SPACE_ID_PATTERN`. Reject malformed.
   *   2. Registry lookup — `findSpaceById`. Reject unknown.
   * Otherwise (middleware OFF, or `?space=` absent) we fall back to the
   * synthesized `LEGACY_SPACE_ID` bucket and the daemon's legacy bundle —
   * which preserves single-space behavior for the existing WS tests AND for
   * any production frontend that hasn't been updated to send `?space=` yet.
   *
   * Returns `null` when validation fails so the caller can reject the
   * upgrade with a 4xx instead of a silent fallback (security: the client
   * asked for a specific space; refusing is safer than swapping it out for
   * the legacy one without telling them).
   */
  function resolveWsSpace(
    rawSpaceId: string | null,
  ): { spaceId: string; bundle: ReturnType<typeof bundleForSpace> } | null {
    if (!rawSpaceId) {
      // No ?space= → fall back to the legacy bundle. We don't enforce
      // `?space=` on WS even when `enableSpaceMiddleware` is on because the
      // running daemon still serves browser tabs from frontends that haven't
      // shipped the multi-space query string yet. HTTP routes gain
      // enforcement first; WS rejection is reserved for the explicit
      // malformed/unknown case below.
      //
      // CRITICAL invariant: the subscription key uses `legacyBundle.space.id`
      // (NOT `LEGACY_SPACE_ID`) so it matches the value routes pass to
      // `bus.publish(...)` via `bundle.space.id` — otherwise the publish
      // and the subscribe land in different buckets and the broadcast
      // silently drops. `LEGACY_SPACE_ID` remains the active-rooms
      // tracker default (Task 11 fix); it is a separate concept.
      return { spaceId: legacyBundle.space.id, bundle: legacyBundle };
    }
    // DRW-138: use the effective flag computed in the outer scope (NOT
    // `opts.enableSpaceMiddleware`, which is undefined when callers rely on
    // the daemonMode default — that's the bug we're fixing).
    if (effectiveSpaceMiddleware) {
      if (!SPACE_ID_PATTERN.test(rawSpaceId)) return null;
      const record = findSpaceById(rawSpaceId);
      if (!record) return null;
      return { spaceId: record.id, bundle: bundleForSpace(record) };
    }
    // Middleware OFF + explicit `?space=<id>` — preserve the test path where
    // a `?space=` value is supplied without going through `/api/spaces`
    // registration. We don't synthesize a SpaceRecord here (would diverge
    // from production storage layout); instead routes still see the legacy
    // bundle, and we use the legacy bundle's id for the subscription key
    // so the publish/subscribe pair stays consistent.
    return { spaceId: legacyBundle.space.id, bundle: legacyBundle };
  }
  type WsData = {
    space: string;
    room: string;
    clientId: string;
    bundleSpaceId: string;
  };
  /**
   * Map a `bundleSpaceId` captured at WS upgrade back to its bundle. Legacy
   * connections short-circuit to the closure-resolved `legacyBundle`; real
   * spaces re-resolve through the registry so a forgotten space falls back
   * gracefully without crashing the WS message loop.
   */
  function resolveBundleForWs(bundleSpaceId: string): SpaceBundle {
    if (bundleSpaceId === legacyBundle.space.id) return legacyBundle;
    const rec = findSpaceById(bundleSpaceId);
    return rec ? bundleForSpace(rec) : legacyBundle;
  }
  const server = Bun.serve({
    port: opts.port ?? config.port,
    // SO_REUSEPORT: освобождает port:bind race после graceful stop() — без него
    // re-bind на :8787 сразу после stop() может упасть с EADDRINUSE из-за
    // TIME_WAIT (~15s на macOS). Critical для shemma update flow (stop → start
    // в одном process). Bun honours `reusePort` since v1.0 (см. bun.sh docs).
    reusePort: true,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const room = url.searchParams.get("room") ?? DEFAULT_ROOM;
        if (!validateRoomId(room)) {
          return new Response("invalid room id", { status: 422 });
        }
        const rawSpace = url.searchParams.get("space");
        const resolved = resolveWsSpace(rawSpace);
        if (!resolved) {
          // Explicit ?space=<bad-id> or ?space=<unknown> — reject with 1008
          // semantics via HTTP 400 before the upgrade. (We can't send a
          // close frame yet — handshake hasn't completed.)
          return new Response("invalid space id", { status: 400 });
        }
        const clientId = crypto.randomUUID();
        const data: WsData = {
          space: resolved.spaceId,
          room,
          clientId,
          bundleSpaceId: resolved.bundle.space.id,
        };
        if (srv.upgrade(req, { data: data as unknown as undefined })) return;
        return new Response("upgrade failed", { status: 500 });
      }
      // serve frontend for release/debug profiles; dev relies on Vite's own server
      if (config.profile !== "dev" && !url.pathname.startsWith("/api")) {
        const served = await tryServeFrontend(url.pathname);
        if (served) return served;
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        const { space, room } = ws.data as unknown as WsData;
        bus.attach(space, room, ws as Sock);
        idle?.noteWsOpen();
      },
      async message(ws, raw) {
        const { space, room, clientId, bundleSpaceId } =
          ws.data as unknown as WsData;
        // Resolve the bundle once per message — `bundleSpaceId` was captured
        // at upgrade and matches the registry lookup result, so this is just
        // a Map.get(). For legacy connections it points at the legacy
        // bundle's id (set in resolveWsSpace).
        const bundle = resolveBundleForWs(bundleSpaceId);
        const wsRooms = bundle.rooms;
        const msg = parseClientMessage(raw);
        if (!msg) return; // malformed → ignore (must not crash)
        if (msg.kind === "hello") {
          const r = await wsRooms.get(room);
          const { reply, schemaUpgraded } = handleHello(
            r,
            msg.lastVersion,
            msg.schema,
          );
          if (schemaUpgraded) {
            r.dirty = true;
            bundle.scheduleSave(room, r);
          }
          ws.send(JSON.stringify(reply));
          return;
        }
        if (msg.kind === "user-change") {
          const r = await wsRooms.get(room);
          // Skip empty batches — keep version monotonic only on real mutations.
          if (isEmptyBatch(msg.changes)) return;
          // DRW-094: defense-in-depth — WS path принимает untrusted client batches;
          // никакая ошибка в apply не должна ронять daemon, дропаем frame и идём дальше.
          try {
            r.store = applyStoreChanges(r.store, msg.changes);
          } catch (e) {
            console.warn(
              `[shemma] dropping malformed user-change batch in room "${room}":`,
              (e as Error).message,
            );
            return;
          }
          r.didrawIndex = rebuildDidrawIndex(r.store);
          r.version += 1;
          pushOpLog(
            r,
            {
              ops: msg.changes,
              source: "user",
              version: r.version,
              at: Date.now(),
              clientOpId: msg.clientOpId,
            },
            config.opLogMaxSize,
          );
          r.dirty = true;
          bundle.scheduleSave(room, r);
          // Re-broadcast to other connected clients. The sender will see this
          // frame too — frontend echo-guard suppresses it via clientOpId match.
          bus.publish(space, room, {
            changes: msg.changes,
            source: "user",
            version: r.version,
            originClientId: msg.clientOpId,
          });
          return;
        }
        if (msg.kind === "board-focus") {
          // Always use `room` from ws.data (WS connection scope), NOT msg.room.
          // A client connected to room "A" could send {room:"B"} to pollute
          // tracker state for room "B" — msg.room is untrusted client input.
          // Same rule applies to `space`: bound at upgrade, never trusted
          // from message payload.
          if (msg.focused) {
            bus.getActiveRooms().onFocus(room, clientId, space);
          } else {
            bus.getActiveRooms().onBlur(room, clientId, space);
          }
          return;
        }
        if (msg.kind === "import-mermaid-result") {
          bus.resolveImportMermaid(msg.requestId, {
            ok: msg.ok,
            shape_ids: msg.shape_ids,
            didraw_names: msg.didraw_names,
            root_ids: msg.root_ids,
            error: msg.error,
          });
          return;
        }
        if (msg.kind === "fit-text-result") {
          bus.resolveFitText(msg.requestId, {
            ok: msg.ok,
            count: msg.count,
            shape_ids: msg.shape_ids,
            error: msg.error,
          });
          return;
        }
      },
      close(ws) {
        const { space, room, clientId } = ws.data as unknown as WsData;
        bus.getActiveRooms().onDisconnect(clientId);
        bus.detach(space, room, ws as Sock);
        idle?.noteWsClose();
      },
    },
  });

  // DRW-116: write lock metadata after the server is listening, so any
  // concurrent `shemma daemon start` invocation can detect a healthy holder
  // via readLockMetadata(SHEMMA_LOCK_DIR). The CLI parent created the lock
  // dir before spawn; we only write the PID file inside it.
  const lockDir = process.env.SHEMMA_LOCK_DIR;
  if (lockDir) {
    // mkdir is idempotent (CLI already created it via acquireLock).
    fs.mkdirSync(lockDir, { recursive: true });
    writeLockMetadata(lockDir, {
      pid: process.pid,
      port: server.port as number,
      startedAt: new Date().toISOString(),
      profile: config.profile,
    });
  }

  const shutdown = async (signal: string) => {
    console.log(`[shemma] ${signal} received, flushing…`);
    idle?.shutdown();
    server.stop();
    // DRW-116 W3: flush any pending lastUsedAt updates BEFORE the room cache
    // shutdown — DebouncedTouch writes to spaces.json (registry), not to
    // room storage, so ordering vs roomCache is independent, but doing it
    // first keeps the flush chain linear and lets the registry settle while
    // larger room writes finalize.
    debouncedTouch?.shutdown();
    // DRW-116 Task 10b: drain EVERY cached (space, room) persistence buffer +
    // stop the sweep interval. This supersedes the per-makeApp facade flushAll
    // — it's a cache-wide flush that catches rooms touched in other spaces too.
    // MUST run BEFORE releaseLock so the lock dir persists while writes finalize.
    await getRoomCache().shutdown();
    if (lockDir) releaseLock(lockDir);
    process.exit(0);
  };
  // Route idle-exit through the same graceful chain as SIGTERM.
  onIdleFire = () => void shutdown("IDLE");
  // Install signal handlers when running as a daemon process. Two triggers:
  //   - `import.meta.main` — direct `bun apps/backend/src/index.ts` invocation
  //   - `SHEMMA_LOCK_DIR` env — CLI-spawned child via `shemma internal-server`
  // In-process test usage (lifecycle.http.test) sets neither and must NOT
  // attach handlers (they'd swallow the test runner's signals).
  if (import.meta.main || process.env.SHEMMA_LOCK_DIR) {
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  }

  return {
    port: server.port as number,
    close: async () => {
      idle?.shutdown();
      server.stop();
      // DRW-116 W3: mirror SIGTERM chain — flush pending lastUsedAt updates.
      debouncedTouch?.shutdown();
      // Test-mode close path mirrors the SIGTERM chain: flush every cached
      // persistence (across spaces touched in this process) before releasing
      // the daemon lock dir.
      if (persistence) await persistence.flushAll();
      if (lockDir) releaseLock(lockDir);
    },
  };
}

if (import.meta.main) {
  void startServer().then((s) =>
    console.log(`[shemma] listening on :${s.port} (profile=${config.profile})`),
  );
}
