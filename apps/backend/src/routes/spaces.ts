import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import {
  findSpaceById,
  forgetSpace,
  listSpaces,
  registerSpace,
  renameSpaceLabel,
  toLocalDTO,
  toPublicDTO,
} from "@shemma/spaces";

/**
 * `/api/spaces` CRUD over the workstation-global spaces registry (spec §4.7).
 *
 * Two DTO shapes per spec §6.2:
 *   - `SpaceLocalDTO` — full record incl. absolute `path`. Returned only when
 *     the request `Host` header looks local (`localhost`, `127.0.0.1`, `::1`).
 *   - `SpacePublicDTO` — privacy-stripped (no `path`, no `storageLayout`).
 *
 * Defense-in-depth: the daemon binds to localhost loopback only, so remote
 * clients can't physically reach this. The DTO split protects against future
 * reverse-proxy / SSH-tunnel scenarios where the request technically arrives
 * from a non-loopback host header.
 *
 * Mount BEFORE `spaceMiddleware` so the per-space query-string requirement
 * never applies here — this router is the registry itself.
 */
export const spacesRouter = new Hono()
  .get("/api/spaces", (c) => {
    const isLocal = isLocalhostRequest(c.req.header("host"), c.req.url);
    const records = listSpaces();
    const dtos = records.map((s) => {
      const opts = { orphaned: !fs.existsSync(s.path) };
      return isLocal ? toLocalDTO(s, opts) : toPublicDTO(s, opts);
    });
    return c.json({ spaces: dtos });
  })
  .get("/api/spaces/:id", (c) => {
    const record = findSpaceById(c.req.param("id"));
    if (!record) return c.json({ error: "space_not_found" }, 404);
    const isLocal = isLocalhostRequest(c.req.header("host"), c.req.url);
    const opts = { orphaned: !fs.existsSync(record.path) };
    const dto = isLocal ? toLocalDTO(record, opts) : toPublicDTO(record, opts);
    return c.json({ space: dto });
  })
  .post("/api/spaces", async (c) => {
    let body: { path?: unknown; label?: unknown };
    try {
      body = (await c.req.json()) as { path?: unknown; label?: unknown };
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (typeof body.path !== "string" || body.path.length === 0) {
      return c.json({ error: "path_required" }, 400);
    }
    const label = typeof body.label === "string" ? body.label : undefined;
    try {
      const { space, created } = registerSpace(body.path, { label });
      return c.json({ space: toLocalDTO(space), created });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: string }).code
          : undefined;
      const error = code === "ENOENT" ? "path_not_found" : "invalid_path";
      return c.json({ error, message }, 400);
    }
  })
  .delete("/api/spaces/:id", (c) => {
    forgetSpace(c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/api/probe-space-path", async (c) => {
    let body: { path?: unknown };
    try {
      body = (await c.req.json()) as { path?: unknown };
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (typeof body.path !== "string" || body.path.length === 0) {
      return c.json({ error: "path_required" }, 400);
    }
    try {
      const abs = fs.realpathSync(body.path);
      const stat = fs.statSync(abs);
      if (!stat.isDirectory()) {
        return c.json({ error: "not_a_directory", path: abs }, 400);
      }
      const shemmaCanvas = path.join(abs, ".shemma", "canvas");
      const hasShemma = fs.existsSync(shemmaCanvas) &&
        fs.statSync(shemmaCanvas).isDirectory();
      return c.json({ absolutePath: abs, hasShemma });
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
      if (code === "ENOENT") return c.json({ error: "path_not_found" }, 404);
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "probe_failed", message }, 500);
    }
  })
  .post("/api/spaces/:id/reveal", (c) => {
    const space = findSpaceById(c.req.param("id"));
    if (!space) return c.json({ error: "space_not_found" }, 404);
    if (!fs.existsSync(space.path)) {
      return c.json({ error: "path_missing", path: space.path }, 404);
    }
    try {
      spawn(revealCommand(), [space.path], { detached: true, stdio: "ignore" }).unref();
      return c.json({ ok: true, path: space.path });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "reveal_failed", message }, 500);
    }
  })
  .patch("/api/spaces/:id", async (c) => {
    let body: { label?: unknown };
    try {
      body = (await c.req.json()) as { label?: unknown };
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (typeof body.label !== "string") {
      return c.json({ error: "label_required" }, 400);
    }
    try {
      const updated = renameSpaceLabel(c.req.param("id"), body.label);
      return c.json({ space: toLocalDTO(updated) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "space_not_found", message }, 404);
    }
  });

/**
 * Loopback request detector. The `Host` header is the canonical source under
 * real HTTP traffic (Bun sets it on every request), but in-process tests that
 * call `app.fetch(new Request(...))` ship a bare Request whose Host header is
 * blank — the URL is the only signal. We probe Host first, then fall back to
 * the URL's hostname so both code paths agree.
 *
 * Accepted loopback forms (case-insensitive, optional port):
 *   - `localhost`
 *   - `127.0.0.1`
 *   - `[::1]` (IPv6 bracketed) or bare `::1`
 *
 * Anything else (including IPv6 link-local, public DNS, IP addresses outside
 * the loopback range) returns `false`, downgrading the DTO to PublicDTO.
 */
function isLocalhostRequest(
  hostHeader: string | undefined,
  url: string,
): boolean {
  if (isLocalhostAuthority(hostHeader)) return true;
  try {
    const parsed = new URL(url);
    // URL.hostname strips port and IPv6 brackets, so `[::1]` becomes `::1`.
    return isLocalhostAuthority(parsed.hostname);
  } catch {
    return false;
  }
}

function revealCommand(): string {
  switch (process.platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

function isLocalhostAuthority(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return (
    lower === "localhost" ||
    lower.startsWith("localhost:") ||
    lower === "127.0.0.1" ||
    lower.startsWith("127.0.0.1:") ||
    lower === "[::1]" ||
    lower.startsWith("[::1]:") ||
    lower === "::1"
  );
}
