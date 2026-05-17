import { readdir, readFile, rename, mkdir, stat, writeFile, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  ENVELOPE_SCHEMA_VERSION,
  parseFull,
  parseHeader,
  serializeExport,
} from "../envelope";
import type { Rooms } from "../rooms";
import { validateRoomId } from "../rooms";
import { config } from "../config";

// Shared path-param validator. All `:id` routes MUST go through this —
// raw c.req.param("id") joined with storageDir is a path-traversal vector
// (e.g. id="../etc/passwd" → escape storageDir).
export function roomParam(c: Context):
  | { ok: true; id: string }
  | { ok: false; response: Response } {
  const id = c.req.param("id") ?? "";
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
    const includeArchived = c.req.query("include") === "archived";
    type RoomItem = {
      id: string;
      version: number;
      elementCount: number;
      lastTouched: string;
      schemaVersion: number;
      linkedSession?: string;
      projectDir?: string;
      projectName?: string;
      archived?: boolean;
    };

    async function readRoomItems(fromDir: string, archived: boolean): Promise<RoomItem[]> {
      let files: string[];
      try {
        files = await readdir(fromDir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
      const out: RoomItem[] = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -5);
        if (!validateRoomId(id)) continue;
        try {
          const raw = await readFile(join(fromDir, f), "utf8");
          const hdr = parseHeader(raw);
          if (!hdr) continue;
          const item: RoomItem = {
            id,
            version: hdr.version,
            elementCount: hdr.elementCount,
            lastTouched: hdr.lastTouched,
            schemaVersion: hdr.schemaVersion,
          };
          if (archived) item.archived = true;
          // Best-effort: parse full envelope to read linkedSession + projectDir.
          try {
            const full = parseFull(raw);
            if (full.linkedSession !== undefined) item.linkedSession = full.linkedSession;
            if (full.projectDir !== undefined) {
              item.projectDir = full.projectDir;
              item.projectName = basename(full.projectDir);
            }
          } catch {
            // non-v3 or malformed — no extra fields
          }
          out.push(item);
        } catch (e) {
          console.error("[rooms] skip", id, (e as Error).message);
        }
      }
      return out;
    }

    try {
      const activeItems = await readRoomItems(storageDir, false);
      let allItems = activeItems;
      if (includeArchived) {
        const archiveDir = join(storageDir, ".archive");
        const archivedItems = await readRoomItems(archiveDir, true);
        allItems = [...activeItems, ...archivedItems];
      }
      return c.json({ ok: true, rooms: allItems, dir: storageDir });
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
    await rooms.evict(id);   // clear stale in-memory state from prior GETs
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

    return c.json({
      ok: true,
      path: body.to,
      schemaVersion: ENVELOPE_SCHEMA_VERSION,
    });
  });

  app.post("/api/rooms/import", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { from?: string; as?: string; force?: boolean }
      | null;

    if (!body?.from) {
      return c.json({ ok: false, error: "expected {from, as?, force?}" }, 400);
    }

    let raw: string;
    try {
      raw = await readFile(body.from, "utf8");
    } catch {
      return c.json({ ok: false, error: "source file not found" }, 404);
    }

    let env;
    try {
      env = parseFull(raw);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 422);
    }

    const targetId = body.as ?? env.roomId;
    if (!validateRoomId(targetId)) {
      return c.json(
        { ok: false, error: `invalid target room id "${targetId}"` },
        422,
      );
    }

    const dstPath = join(storageDir, `${targetId}.json`);
    let exists = false;
    try {
      await stat(dstPath);
      exists = true;
    } catch {}

    if (exists && !body.force) {
      // I5 (Phase 2.0): expose `existingId` so callers can decide how to retry
      // (force-overwrite vs different `as`). The error string is a stable
      // machine-checkable token; details go in the message-free fields.
      return c.json(
        { ok: false, error: "room exists", existingId: targetId },
        409,
      );
    }

    if (exists) {
      // I2 (Phase 2.0): explicit flush BEFORE evict. `evict` already calls
      // `flushIfDirty` internally, but the daemon-safe pattern
      // (flushIfDirty → stat → op) demands the call be visible at every
      // file-mutating site so future refactors of `evict` can't silently drop
      // pending writes.
      await rooms.flushIfDirty(targetId);
      await rooms.evict(targetId);
    }

    // Drop the source opLog by design: import resets history.
    const { opLog: _drop, ...rest } = env;
    const newEnv = { ...rest, roomId: targetId };
    await writeFile(dstPath, JSON.stringify(newEnv, null, 2), "utf8");

    return c.json({ ok: true, roomId: targetId, version: env.version });
  });

  app.post("/api/rooms/:id/rename", async (c) => {
    const idParam = roomParam(c);
    if (!idParam.ok) return idParam.response;
    const id = idParam.id;

    const body = (await c.req.json().catch(() => null)) as { to?: string; force?: boolean } | null;
    const to = body?.to;
    const force = !!body?.force;

    if (!to || !validateRoomId(to)) {
      return c.json({ ok: false, error: "invalid-room-id" }, 422);
    }

    // CRITICAL ORDER: flush BEFORE stat — a freshly-mutated dirty room may not
    // have a file on disk yet (autosave debounce not fired).
    await rooms.flushIfDirty(id);

    // Reject rename of archived rooms
    const archivedSrcPath = join(storageDir, ".archive", `${id}.json`);
    try {
      await stat(archivedSrcPath);
      return c.json({ ok: false, error: "rename-archived-not-supported" }, 422);
    } catch {
      // not archived — continue
    }

    const srcPath = join(storageDir, `${id}.json`);
    try {
      await stat(srcPath);
    } catch {
      return c.json({ ok: false, error: "room not found" }, 404);
    }

    // Conflict check: active OR archived target already exists
    const dstPath = join(storageDir, `${to}.json`);
    const dstArchivedPath = join(storageDir, ".archive", `${to}.json`);
    let conflict = false;
    try { await stat(dstPath); conflict = true; } catch { /* ok */ }
    if (!conflict) {
      try { await stat(dstArchivedPath); conflict = true; } catch { /* ok */ }
    }
    if (conflict && !force) {
      return c.json({ ok: false, error: "room-exists", existingId: to }, 409);
    }

    // Evict after flush — room flushed above, now clear from memory
    await rooms.evict(id);

    const raw = await readFile(srcPath, "utf8");
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: "malformed envelope" }, 422);
    }
    envelope.roomId = to;

    const tmp = `${dstPath}.tmp`;
    await writeFile(tmp, JSON.stringify(envelope, null, 2), "utf8");
    await rename(tmp, dstPath);
    await unlink(srcPath);
    await rooms.evict(to); // force fresh load on next access

    return c.json({ ok: true, id: to });
  });

  app.post("/api/rooms/:id/duplicate", async (c) => {
    const idParam = roomParam(c);
    if (!idParam.ok) return idParam.response;
    const id = idParam.id;

    const body = (await c.req.json().catch(() => null)) as { as?: string } | null;
    const as = body?.as;

    if (!as || !validateRoomId(as)) {
      return c.json({ ok: false, error: "invalid-room-id" }, 422);
    }

    // CRITICAL ORDER: flush BEFORE stat — debounced save may not have written yet.
    await rooms.flushIfDirty(id);

    // Find source: active first, then archived
    const srcActive = join(storageDir, `${id}.json`);
    const srcArchived = join(storageDir, ".archive", `${id}.json`);
    let srcPath: string | null = null;
    try { await stat(srcActive); srcPath = srcActive; } catch { /* not active */ }
    if (!srcPath) {
      try { await stat(srcArchived); srcPath = srcArchived; } catch { /* not archived either */ }
    }
    if (!srcPath) {
      return c.json({ ok: false, error: "room not found" }, 404);
    }

    // Duplicate to existing target → conflict (no force option)
    const dstPath = join(storageDir, `${as}.json`);
    try {
      await stat(dstPath);
      return c.json({ ok: false, error: "room-exists", existingId: as }, 409);
    } catch { /* ok — target doesn't exist */ }

    const raw = await readFile(srcPath, "utf8");
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: "malformed envelope" }, 422);
    }

    // Reset per AC: new identity, empty opLog, version reset, no linkedSession
    envelope.roomId = as;
    envelope.opLog = [];
    envelope.version = 1;
    delete envelope.linkedSession;

    const tmp = `${dstPath}.tmp`;
    await writeFile(tmp, JSON.stringify(envelope, null, 2), "utf8");
    await rename(tmp, dstPath);

    return c.json({ ok: true, id: as });
  });

  app.delete("/api/rooms/:id", async (c) => {
    const idParam = roomParam(c);
    if (!idParam.ok) return idParam.response;
    const id = idParam.id;
    const body = (await c.req.json().catch(() => ({}))) as {
      confirm?: boolean;
      mode?: "archive" | "hard";
      force?: boolean;
    };
    if (!body.confirm) {
      return c.json(
        { ok: false, error: "expected {confirm:true} in body" },
        400,
      );
    }

    const mode = body.mode ?? "archive";
    const force = body.force ?? false;

    // Flush before stat: pending writes for this room must materialize so we
    // either find the file (and delete it) or honestly 404.
    await rooms.flushIfDirty(id);

    const path = join(storageDir, `${id}.json`);
    try {
      await stat(path);
    } catch {
      return c.json({ ok: false, error: "room not found" }, 404);
    }

    if (mode === "archive") {
      // Reuse existing archive logic: move file to .archive/.
      await rooms.evict(id);
      const archiveDir = join(storageDir, ".archive");
      await mkdir(archiveDir, { recursive: true });
      const dstPath = join(archiveDir, `${id}.json`);
      await rename(path, dstPath);
      return c.json({ ok: true, archivedTo: dstPath });
    }

    // mode === "hard"
    // Pre-flight: load room to check linkedSession (populates it if applicable).
    const room = await rooms.get(id);
    if (
      room.linkedSession !== undefined &&
      room.linkedSession === config.sessionId &&
      !force
    ) {
      return c.json(
        {
          ok: false,
          error: "linked-to-active-session",
          linkedSession: room.linkedSession,
        },
        409,
      );
    }

    await rooms.evict(id);
    await unlink(path);
    return c.json({ ok: true });
  });

  app.post("/api/rooms/purge-archive", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: boolean };
    if (!body.confirm) {
      return c.json(
        { ok: false, error: "expected {confirm:true} in body" },
        422,
      );
    }

    const archiveDir = join(storageDir, ".archive");
    let files: string[];
    try {
      files = await readdir(archiveDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ ok: true, removed: 0 });
      }
      throw e;
    }

    let removed = 0;
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        await unlink(join(archiveDir, f));
        removed++;
      } catch (e) {
        console.error("[rooms] purge-archive skip", f, (e as Error).message);
      }
    }
    return c.json({ ok: true, removed });
  });

  return app;
}
