import { Hono } from "hono";
import { config } from "./config";
import { FilePersistence } from "./persistence";
import { type RoomStore, Rooms } from "./rooms";
import { healthRoutes } from "./routes/health";
import { layoutRoutes } from "./routes/layout";
import { patchRoutes } from "./routes/patch";
import { promptRoutes } from "./routes/prompts";
import { stateRoutes } from "./routes/state";
import { versionRoutes } from "./routes/version";
import { DEFAULT_ROOM, type RoomState } from "./types";
import { type Sock, WsHub } from "./ws";

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
  const bus = new WsHub();
  const app = new Hono();
  const onDirty = persistence
    ? (id: string, room: RoomState) => persistence.scheduleSave(id, room)
    : undefined;
  app.route("/", healthRoutes);
  app.route("/", versionRoutes);
  app.route("/", stateRoutes(rooms));
  app.route("/", patchRoutes(rooms, bus, { onDirty }));
  app.route("/", layoutRoutes(rooms, bus, { onDirty }));
  app.route("/", promptRoutes(rooms, bus, { onDirty }));
  return { app, rooms, bus, persistence };
}

export async function startServer(opts: AppOpts = {}) {
  const { app, bus, persistence } = makeApp(opts);
  const server = Bun.serve({
    port: opts.port ?? config.port,
    fetch: (req, srv) => {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const room = url.searchParams.get("room") ?? DEFAULT_ROOM;
        if (srv.upgrade(req, { data: { room } })) return;
        return new Response("upgrade failed", { status: 500 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        const { room } = ws.data as { room: string };
        bus.attach(room, ws as Sock);
        ws.send(JSON.stringify({ kind: "hello", version: 0 }));
      },
      message() {},
      close(ws) {
        const { room } = ws.data as { room: string };
        bus.detach(room, ws as Sock);
      },
    },
  });

  const shutdown = async (signal: string) => {
    console.log(`[didraw] ${signal} received, flushing…`);
    server.stop();
    if (persistence) await persistence.flushAll();
    process.exit(0);
  };
  if (import.meta.main) {
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  }

  return {
    port: server.port,
    close: async () => {
      server.stop();
      if (persistence) await persistence.flushAll();
    },
  };
}

if (import.meta.main) {
  void startServer().then((s) =>
    console.log(`[didraw] listening on :${s.port} (profile=${config.profile})`),
  );
}
