import fs from "node:fs";
import { releaseLock, writeLockMetadata } from "@shemma/lockfile";
import type { SpaceRecord } from "@shemma/spaces";
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
import { contextRoutes } from "./routes/context";
import { domainRoutes } from "./routes/domain";
import { exportRoutes } from "./routes/export";
import { makeHealthRoutes } from "./routes/health";
import { importMermaidRoutes } from "./routes/import-mermaid";
import { layoutRoutes } from "./routes/layout";
import { layoutSelectionRoutes } from "./routes/layout-selection";
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
    app.use("/api/*", spaceMiddleware({ allowList: new Set(SPACE_ALLOWLIST) }));
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
  app.route("/", promptRoutes(bus));
  app.route("/", aiRoutes(bus));
  app.route("/", roomsRoutes(storageDir));
  app.route("/", viewportRoutes());
  app.route("/", domainRoutes(bus));
  app.route("/", contextRoutes());
  app.route("/", importMermaidRoutes(bus));
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
  // onIdle is patched below to point at the graceful `shutdown` chain; until
  // then we never fire (the interval has not started ticking yet). Using a
  // forwarding closure lets IdleTracker exist before `shutdown` is declared
  // while still routing idle-exit through the same flush + releaseLock path
  // SIGTERM uses (a raw process.exit(0) would leak the lock dir).
  let onIdleFire: () => void = () => process.exit(0);
  const idle = daemonMode
    ? new IdleTracker(undefined, () => onIdleFire())
    : undefined;
  const { app, bus, persistence, rooms } = makeApp({ ...opts, idle });
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
        const clientId = crypto.randomUUID();
        if (
          srv.upgrade(req, { data: { room, clientId } as unknown as undefined })
        )
          return;
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
        const { room } = ws.data as unknown as {
          room: string;
          clientId: string;
        };
        bus.attach(room, ws as Sock);
        idle?.noteWsOpen();
      },
      async message(ws, raw) {
        const { room, clientId } = ws.data as unknown as {
          room: string;
          clientId: string;
        };
        const msg = parseClientMessage(raw);
        if (!msg) return; // malformed → ignore (must not crash)
        if (msg.kind === "hello") {
          const r = await rooms.get(room);
          const { reply, schemaUpgraded } = handleHello(
            r,
            msg.lastVersion,
            msg.schema,
          );
          if (schemaUpgraded) {
            r.dirty = true;
            if (persistence) persistence.scheduleSave(room, r);
          }
          ws.send(JSON.stringify(reply));
          return;
        }
        if (msg.kind === "user-change") {
          const r = await rooms.get(room);
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
          if (persistence) persistence.scheduleSave(room, r);
          // Re-broadcast to other connected clients. The sender will see this
          // frame too — frontend echo-guard suppresses it via clientOpId match.
          bus.publish(room, {
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
          if (msg.focused) {
            bus.getActiveRooms().onFocus(room, clientId);
          } else {
            bus.getActiveRooms().onBlur(room, clientId);
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
      },
      close(ws) {
        const { room, clientId } = ws.data as unknown as {
          room: string;
          clientId: string;
        };
        bus.getActiveRooms().onDisconnect(clientId);
        bus.detach(room, ws as Sock);
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
