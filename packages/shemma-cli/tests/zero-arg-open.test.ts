import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../../apps/backend/src/index";

/**
 * DRW-121: zero-arg `shemma` / `shemma open [<room>]` flow.
 *
 * The pre-DRW-116 "storage-conflict-detection" contract no longer applies —
 * the daemon is a singleton serving all spaces. The CLI's job is to resolve
 * cwd to a registered space (or auto-register, or fall back to landing) and
 * open the right URL.
 *
 * In-process test server mounted on a random port; CLI subprocess given the
 * same SHEMMA_PORT so `isHealthy()` hits the test server.
 */

const CLI = join(import.meta.dir, "..", "src", "index.ts");

let srv: { port: number; close: () => Promise<void> };
let xdg: string;

beforeAll(async () => {
  // DRW-123: isolate registry writes from the user's real ~/.config/shemma.
  xdg = mkdtempSync(join(tmpdir(), "shemma-zero-arg-xdg-"));
  srv = await startServer({ port: 0 });
});
afterAll(async () => {
  await srv.close();
  rmSync(xdg, { recursive: true, force: true });
});

async function cli(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, "--json", ...args], {
    env: opts.env ?? {},
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status: exitCode, stdout, stderr };
}

function envFor(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SHEMMA_PORT: String(srv.port),
    SHEMMA_PROFILE: "dev",
    XDG_CONFIG_HOME: xdg,
    ...extra,
  };
  delete env.SHEMMA_STORAGE_DIR;
  delete env.DIDRAW_STORAGE_DIR;
  return env;
}

describe("DRW-121: zero-arg / open — cwd → space resolution", () => {
  test("cwd without registered space and without .shemma/canvas → landing URL", async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "shemma-no-space-"));
    try {
      const r = await cli(["--no-browser"], { cwd: tmpCwd, env: envFor() });
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.ok).toBe(true);
      expect(j.space).toBeNull();
      // Landing URL = bare `/`
      expect(j.url).toMatch(/\/$/);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test("cwd with .shemma/canvas/ but unregistered → auto-registered + space URL", async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "shemma-auto-register-"));
    mkdirSync(join(tmpCwd, ".shemma", "canvas"), { recursive: true });
    let spaceId: string | null = null;
    try {
      const r = await cli(["--no-browser"], { cwd: tmpCwd, env: envFor() });
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.ok).toBe(true);
      expect(typeof j.space).toBe("string");
      expect(j.url).toContain(`?space=${j.space}`);
      // Gallery URL — no `room` segment when no room arg.
      expect(j.url).not.toContain("room=");
      spaceId = j.space;
    } finally {
      if (spaceId) {
        await cli(["s", "forget", spaceId], { env: envFor() }).catch(() => {});
      }
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test("`open <room>` threads room into the URL", async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "shemma-room-arg-"));
    mkdirSync(join(tmpCwd, ".shemma", "canvas"), { recursive: true });
    try {
      const r = await cli(["open", "scratch", "--no-browser"], {
        cwd: tmpCwd,
        env: envFor(),
      });
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.ok).toBe(true);
      expect(j.room).toBe("scratch");
      expect(j.url).toContain("room=scratch");
      expect(j.url).toContain("space=");
      if (j.space) {
        await cli(["s", "forget", j.space], { env: envFor() }).catch(() => {});
      }
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test("--storage <path> registers as direct-layout space + opens its URL", async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "shemma-storage-arg-"));
    const storage = mkdtempSync(join(tmpdir(), "shemma-storage-dir-"));
    try {
      const r = await cli(["--no-browser", "--storage", storage], {
        cwd: tmpCwd,
        env: envFor(),
      });
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.ok).toBe(true);
      expect(typeof j.space).toBe("string");
      expect(j.url).toContain(`?space=${j.space}`);
      if (j.space) {
        await cli(["s", "forget", j.space], { env: envFor() }).catch(() => {});
      }
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });
});
