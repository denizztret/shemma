import { Hono } from "hono";
import { config } from "./config";
import { FilePersistence } from "./persistence";
import { type RoomStore, Rooms } from "./rooms";
import { healthRoutes } from "./routes/health";
import { type PatchBus, patchRoutes } from "./routes/patch";
import { stateRoutes } from "./routes/state";

export type AppOpts = { inMemory?: boolean; storageDir?: string };

export function makeApp(opts: AppOpts = {}) {
  // Fix vs plan: don't double-join — config.storageDir already ends in the correct path
  const storageDir = opts.storageDir ?? config.storageDir;
  const persistence = opts.inMemory ? null : new FilePersistence(storageDir);
  const store: RoomStore = persistence
    ? {
        load: (id) => persistence.load(id),
        save: (id, s) => persistence.save(id, s),
      }
    : { load: async () => null, save: async () => {} };
  const rooms = new Rooms(store);
  const bus: PatchBus = { publish: () => {} };
  const app = new Hono();
  app.route("/", healthRoutes);
  app.route("/", stateRoutes(rooms));
  app.route(
    "/",
    patchRoutes(rooms, bus, {
      onDirty: persistence
        ? (id) => {
            void rooms.get(id).then((s) => persistence.scheduleSave(id, s));
          }
        : undefined,
    }),
  );
  return { app, rooms, bus, persistence };
}

if (import.meta.main) {
  const { app } = makeApp();
  const server = Bun.serve({ port: config.port, fetch: app.fetch });
  console.log(`[didraw] listening on http://localhost:${server.port}`);
}
