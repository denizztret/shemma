import { Hono } from "hono";
import { config } from "./config";
import { EMBEDDED_ASSETS } from "./embedded-assets";
import { FilePersistence } from "./persistence";
import { type RoomStore, Rooms, pushOpLog, validateRoomId } from "./rooms";
import { aiRoutes } from "./routes/ai";
import { contextRoutes } from "./routes/context";
import { domainRoutes } from "./routes/domain";
import { makeHealthRoutes } from "./routes/health";
import { layoutRoutes } from "./routes/layout";
import { sessionRoutes } from "./routes/session";
import { promptRoutes } from "./routes/prompts";
import { roomsRoutes } from "./routes/rooms";
import { stateRoutes } from "./routes/state";
import { versionRoutes } from "./routes/version";
import { viewportRoutes } from "./routes/viewport";
import { applyStoreChanges, isEmptyBatch, rebuildDidrawIndex } from "./store-ops";
import { DEFAULT_ROOM, type RoomState } from "./types";
import { type Sock, WsHub } from "./ws";
import { handleHello, parseClientMessage } from "./ws-protocol";

export type AppOpts = {
  inMemory?: boolean;
  port?: number;
  storageDir?: string;
};

export function makeApp(opts: AppOpts = {}) {
  const storageDir = opts.storageDir ?? config.storageDir; // Fix: no double-join
  const persistence = opts.inMemory ? null : new FilePersistence(storageDir);
  const store: RoomStore = persistence
    ? {
        load: (id) => persistence.load(id),
        save: (id, s) => persistence.save(id, s),
      }
    : { load: async () => null, save: async () => {} };
  const rooms = new Rooms(store);
  if (persistence) rooms.setPersistence(persistence);
  const bus = new WsHub();
  const app = new Hono();
  const onDirty = persistence
    ? (id: string, room: RoomState) => persistence.scheduleSave(id, room)
    : undefined;
  app.route("/", makeHealthRoutes(storageDir));
  app.route("/", versionRoutes);
  app.route("/", sessionRoutes);
  app.route("/", stateRoutes(rooms, { onDirty }));
  app.route("/", layoutRoutes(rooms, bus, { onDirty }));
  app.route("/", promptRoutes(rooms, bus, { onDirty }));
  app.route("/", aiRoutes(rooms, bus));
  app.route("/", roomsRoutes(rooms, storageDir));
  app.route("/", viewportRoutes(rooms));
  app.route("/", domainRoutes(rooms, bus, { onDirty }));
  app.route("/", contextRoutes(rooms));
  return { app, rooms, bus, persistence };
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
  const { app, bus, persistence, rooms } = makeApp(opts);
  const server = Bun.serve({
    port: opts.port ?? config.port,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const room = url.searchParams.get("room") ?? DEFAULT_ROOM;
        if (!validateRoomId(room)) {
          return new Response("invalid room id", { status: 422 });
        }
        if (srv.upgrade(req, { data: { room } as unknown as undefined })) return;
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
        const { room } = ws.data as unknown as { room: string };
        bus.attach(room, ws as Sock);
      },
      async message(ws, raw) {
        const { room } = ws.data as unknown as { room: string };
        const msg = parseClientMessage(raw);
        if (!msg) return; // malformed → ignore (must not crash)
        if (msg.kind === "hello") {
          const r = await rooms.get(room);
          const { reply, schemaUpgraded } = handleHello(r, msg.lastVersion, msg.schema);
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
          r.store = applyStoreChanges(r.store, msg.changes);
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
      },
      close(ws) {
        const { room } = ws.data as unknown as { room: string };
        bus.detach(room, ws as Sock);
      },
    },
  });

  const shutdown = async (signal: string) => {
    console.log(`[shemma] ${signal} received, flushing…`);
    server.stop();
    if (persistence) await persistence.flushAll();
    process.exit(0);
  };
  if (import.meta.main) {
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  }

  return {
    port: server.port as number,
    close: async () => {
      server.stop();
      if (persistence) await persistence.flushAll();
    },
  };
}

if (import.meta.main) {
  void startServer().then((s) =>
    console.log(`[shemma] listening on :${s.port} (profile=${config.profile})`),
  );
}
