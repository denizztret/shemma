import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "hono";
import { Hono } from "hono";
import { parseHeader } from "../envelope";
import type { Rooms } from "../rooms";
import { validateRoomId } from "../rooms";

// Shared path-param validator. All `:id` routes MUST go through this —
// raw c.req.param("id") joined with storageDir is a path-traversal vector
// (e.g. id="../etc/passwd" → escape storageDir).
export function roomParam(c: Context):
  | { ok: true; id: string }
  | { ok: false; response: Response } {
  const id = c.req.param("id");
  if (!validateRoomId(id)) {
    return {
      ok: false,
      response: c.json(
        { ok: false, error: `invalid room id "${id}"` },
        422,
      ),
    };
  }
  return { ok: true, id };
}

export function roomsRoutes(rooms: Rooms, storageDir: string) {
  const app = new Hono();

  app.get("/api/rooms", async (c) => {
    try {
      const files = await readdir(storageDir);
      const out: Array<{
        id: string;
        version: number;
        elementCount: number;
        lastTouched: string;
        schemaVersion: number;
      }> = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -5);
        try {
          const raw = await readFile(join(storageDir, f), "utf8");
          const hdr = parseHeader(raw);
          if (!hdr) continue;
          out.push({
            id,
            version: hdr.version,
            elementCount: hdr.elementCount,
            lastTouched: hdr.lastTouched,
            schemaVersion: hdr.schemaVersion,
          });
        } catch (e) {
          console.error("[rooms] skip", id, (e as Error).message);
        }
      }
      return c.json({ ok: true, rooms: out, dir: storageDir });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ ok: true, rooms: [], dir: storageDir });
      }
      throw e;
    }
  });

  return app;
}
