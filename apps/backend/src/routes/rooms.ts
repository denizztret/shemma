import { readdir, readFile, rename, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "hono";
import { Hono } from "hono";
import { parseHeader, serializeExport } from "../envelope";
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

  app.post("/api/rooms/:id/archive", async (c) => {
    const idParam = roomParam(c);
    if (!idParam.ok) return idParam.response;
    const id = idParam.id;
    const srcPath = join(storageDir, `${id}.json`);

    // CRITICAL ORDER: flush BEFORE stat. A freshly-created dirty room may have
    // no file on disk yet (autosave debounce not fired). flushIfDirty is
    // idempotent — no-op if nothing pending.
    await rooms.flushIfDirty(id);

    try {
      await stat(srcPath);
    } catch {
      return c.json({ ok: false, error: "room not found" }, 404);
    }

    await rooms.evict(id);

    const archiveDir = join(storageDir, ".archive");
    await mkdir(archiveDir, { recursive: true });
    const dstPath = join(archiveDir, `${id}.json`);
    await rename(srcPath, dstPath);

    return c.json({ ok: true, archivedTo: dstPath });
  });

  app.post("/api/rooms/:id/restore", async (c) => {
    const idParam = roomParam(c);
    if (!idParam.ok) return idParam.response;
    const id = idParam.id;
    const archiveDir = join(storageDir, ".archive");
    const srcPath = join(archiveDir, `${id}.json`);
    const dstPath = join(storageDir, `${id}.json`);

    try {
      await stat(srcPath);
    } catch {
      return c.json({ ok: false, error: "archived room not found" }, 404);
    }
    await rooms.flushIfDirty(id);
    try {
      await stat(dstPath);
      return c.json(
        { ok: false, error: "active room with this id already exists" },
        409,
      );
    } catch {
      // dstPath does not exist — good
    }

    await rename(srcPath, dstPath);
    return c.json({ ok: true });
  });

  app.post("/api/rooms/:id/export", async (c) => {
    const idParam = roomParam(c);
    if (!idParam.ok) return idParam.response;
    const id = idParam.id;
    const body = (await c.req.json().catch(() => null)) as { to?: string } | null;
    if (!body?.to) {
      return c.json({ ok: false, error: "expected {to: <path>}" }, 400);
    }

    // Flush BEFORE stat. Newly-created dirty rooms may not have a file yet.
    await rooms.flushIfDirty(id);

    const srcPath = join(storageDir, `${id}.json`);
    try {
      await stat(srcPath);
    } catch {
      return c.json({ ok: false, error: "room not found" }, 404);
    }

    const room = await rooms.get(id);
    const raw = serializeExport(id, room);
    await writeFile(body.to, raw, "utf8");

    return c.json({ ok: true, path: body.to, schemaVersion: 1 });
  });

  return app;
}
