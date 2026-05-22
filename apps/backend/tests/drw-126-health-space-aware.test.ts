/**
 * DRW-126 — `/api/health` is space-aware.
 *
 * Before: `/api/health` returned the closure-captured `storageDir` from
 * daemon startup regardless of any `?space=` on the request. With registry-
 * driven multi-space (DRW-116), that path is the legacy `~/.claude/projects/
 * <slug>/canvas` fallback and diverges from real per-space storage
 * (`<space.path>/.shemma/canvas/`). Agents calling `shemma_health` to verify
 * where a write should land saw the wrong directory.
 *
 * After:
 *  - No `?space=` → 200 with legacy behaviour PLUS `fallback: true` marker.
 *  - Valid registered `?space=<id>` → 200 with space-aware storage and
 *    `space: <id>` field, `fallback: false`.
 *  - Malformed `?space=` → 400 `invalid_space_id`.
 *  - Unknown `?space=` → 404 `space_not_found`.
 *
 * XDG isolation: tmpdir keeps the registry write out of the user's real
 * `~/.config/shemma/spaces.json` per feedback-cli-tests-xdg-isolation.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSpace } from "@shemma/spaces";
import { startServer } from "../src/index";

let srv: { port: number; close: () => Promise<void> };
let fallbackDir: string;
let spaceDir: string;
let xdgRoot: string;
let registeredId: string;

beforeAll(async () => {
  // realpathSync: macOS resolves /var → /private/var; registerSpace stores
  // realpath, so use the same for assertions to avoid prefix mismatch.
  xdgRoot = realpathSync(mkdtempSync(join(tmpdir(), "shemma-drw126-xdg-")));
  fallbackDir = realpathSync(
    mkdtempSync(join(tmpdir(), "shemma-drw126-fallback-")),
  );
  spaceDir = realpathSync(
    mkdtempSync(join(tmpdir(), "shemma-drw126-space-")),
  );
  process.env.XDG_CONFIG_HOME = xdgRoot;
  const { space } = registerSpace(spaceDir, {
    storageLayout: "project",
    label: "drw-126-space",
  });
  registeredId = space.id;
  srv = await startServer({
    port: 0,
    storageDir: fallbackDir,
    enableSpaceMiddleware: true,
  });
});

afterAll(async () => {
  await srv.close();
  rmSync(xdgRoot, { recursive: true, force: true });
  rmSync(fallbackDir, { recursive: true, force: true });
  rmSync(spaceDir, { recursive: true, force: true });
});

describe("DRW-126 — /api/health space awareness", () => {
  test("no ?space → fallback storage with fallback:true marker", async () => {
    const r = await fetch(`http://localhost:${srv.port}/api/health`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      ok: boolean;
      storage: string;
      fallback?: boolean;
      space?: string;
    };
    expect(j.ok).toBe(true);
    expect(j.storage).toBe(fallbackDir);
    expect(j.fallback).toBe(true);
    expect(j.space).toBeUndefined();
  });

  test("?space=<registered> → per-space storage with fallback:false", async () => {
    const r = await fetch(
      `http://localhost:${srv.port}/api/health?space=${encodeURIComponent(registeredId)}`,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      ok: boolean;
      storage: string;
      fallback?: boolean;
      space?: string;
    };
    expect(j.ok).toBe(true);
    expect(j.space).toBe(registeredId);
    expect(j.fallback).toBe(false);
    // project layout = <space.path>/.shemma/canvas/ for release profile (or
    // canvas-dev for dev). We just assert the path roots in spaceDir, not
    // claude-projects fallback.
    expect(j.storage.startsWith(spaceDir)).toBe(true);
    expect(j.storage).not.toContain(".claude/projects");
  });

  test("?space=<malformed> → 400 invalid_space_id", async () => {
    const r = await fetch(
      `http://localhost:${srv.port}/api/health?space=__bad__`,
    );
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe("invalid_space_id");
  });

  test("?space=<unknown> → 404 space_not_found", async () => {
    const r = await fetch(
      `http://localhost:${srv.port}/api/health?space=nonexistent`,
    );
    expect(r.status).toBe(404);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe("space_not_found");
  });

  test("rooms_list and health agree on storage for the same space", async () => {
    const [hRes, rRes] = await Promise.all([
      fetch(
        `http://localhost:${srv.port}/api/health?space=${encodeURIComponent(registeredId)}`,
      ),
      fetch(
        `http://localhost:${srv.port}/api/rooms?space=${encodeURIComponent(registeredId)}`,
      ),
    ]);
    const h = (await hRes.json()) as { storage: string };
    const rooms = (await rRes.json()) as { dir: string };
    expect(h.storage).toBe(rooms.dir);
  });
});
