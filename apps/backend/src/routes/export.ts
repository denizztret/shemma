
import { Hono } from "hono";
import { readMiroToken } from "../config";
import type { Rooms } from "../rooms";
import { resolveRoomId } from "../rooms";
import { MiroAuthError, MiroClient, type MiroBoard } from "../export/miro/client";
import { runMiroExport } from "../export/miro/upload";
import { VERSION } from "../version";

interface BoardsCacheEntry {
  expiresAt: number;
  boards: MiroBoard[];
}

const BOARDS_TTL_MS = 5 * 60 * 1000;
const boardsCache = new Map<string, BoardsCacheEntry>();

export interface ExportRoutesOpts {
  /** Override Miro base URL for tests. Defaults to https://api.miro.com. */
  miroBaseUrl?: string;
  trackingField?: "metadata" | "appData";
  /** Called per-chunk and after the full export; route caller wires this to persistence. */
  onDirty?: (room: string, state: import("../types").RoomState) => void;
}

function tokenMissingResponse() {
  return {
    ok: false,
    error: "miro-token-missing",
    hint:
      "Run: shemma config set miro.token <token>\n" +
      "Get token: https://developers.miro.com/docs/rest-api-build-your-first-hello-world-app",
  };
}

export function exportRoutes(rooms: Rooms, opts: ExportRoutesOpts = {}) {
  return new Hono()
    // ── POST /api/export/miro ──────────────────────────────────────────────
    .post("/api/export/miro", async (c) => {
      const rv = resolveRoomId(c.req.query("room"));
      if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);

      const token = readMiroToken();
      if (!token) return c.json(tokenMissingResponse(), 412);

      const body = (await c.req.json().catch(() => null)) as {
        boardId?: string;
        selection?: string[];
        boardName?: string;
        scope?: "selection" | "room";
        dryRun?: boolean;
      } | null;
      if (!body || typeof body.boardId !== "string" || body.boardId.length === 0) {
        return c.json({ ok: false, error: "missing-boardId" }, 400);
      }

      const room = await rooms.get(rv.id);

      const selection = Array.isArray(body.selection) && body.selection.length > 0
        ? body.selection
        : body.scope === "room"
          ? Object.keys(room.store.store).filter((id) => id.startsWith("shape:"))
          : [];

      if (selection.length === 0) {
        return c.json({ ok: false, error: "empty-selection" }, 400);
      }

      const client = new MiroClient({ token, baseUrl: opts.miroBaseUrl });

      try {
        if (body.dryRun) {
          // Cheap preview without making Miro calls.
          return c.json({
            ok: true,
            dryRun: true,
            itemCount: selection.length,
            sampleSelection: selection.slice(0, 3),
          });
        }
        const result = await runMiroExport({
          client,
          room,
          boardId: body.boardId,
          boardName: body.boardName,
          selection,
          trackingField: opts.trackingField ?? "metadata",
          shemmaRoom: rv.id,
          shemmaVersion: VERSION.version,
          onCommit: (r) => {
            r.dirty = true;
            opts.onDirty?.(rv.id, r);
          },
        });
        room.dirty = true;
        opts.onDirty?.(rv.id, room);

        return c.json({
          ok: result.error === undefined,
          boardId: body.boardId,
          boardUrl: `https://miro.com/app/board/${body.boardId}/`,
          itemsCreated: result.itemsCreated,
          connectorsCreated: result.connectorsCreated,
          skipped: result.skipped,
          ...(result.error ? { error: result.error } : {}),
        });
      } catch (e) {
        if (e instanceof MiroAuthError) {
          return c.json(
            { ok: false, error: "miro-auth-failed", hint: "Check your token in ~/.config/shemma/config.json" },
            401,
          );
        }
        return c.json({ ok: false, error: (e as Error).message }, 500);
      }
    })
    // ── GET /api/export/miro/boards ────────────────────────────────────────
    .get("/api/export/miro/boards", async (c) => {
      const token = readMiroToken();
      if (!token) return c.json(tokenMissingResponse(), 412);
      const now = Date.now();
      const cached = boardsCache.get(token);
      if (cached && cached.expiresAt > now) {
        return c.json({ boards: cached.boards, cached: true });
      }
      const client = new MiroClient({ token, baseUrl: opts.miroBaseUrl });
      try {
        const boards = await client.listBoards();
        boardsCache.set(token, { boards, expiresAt: now + BOARDS_TTL_MS });
        return c.json({ boards, cached: false });
      } catch (e) {
        if (e instanceof MiroAuthError) {
          return c.json({ ok: false, error: "miro-auth-failed" }, 401);
        }
        return c.json({ ok: false, error: (e as Error).message }, 500);
      }
    });
}
