import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../../apps/backend/src/index";

/**
 * DRW-057: startup banner tests.
 *
 * Strategy: spin up an in-process test daemon на known port + storage,
 * затем запускаем CLI с `--storage <base>` (где base/canvas-dev === srv.storage)
 * — это эквивалентно matching-storage happy path. Banner печатается в stdout.
 *
 * `--no-browser` чтобы CLI не пытался открыть URL.
 */

const CLI = join(import.meta.dir, "..", "src", "index.ts");

let srv: { port: number; close: () => Promise<void> };
let base: string;
let subdir: string;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "shemma-banner-base-"));
  subdir = join(base, "canvas-dev");
  mkdirSync(subdir, { recursive: true });
  srv = await startServer({ port: 0, storageDir: subdir });
});

afterAll(async () => {
  await srv.close();
  rmSync(base, { recursive: true, force: true });
});

async function cli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      SHEMMA_PORT: String(srv.port),
      SHEMMA_PROFILE: "dev",
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

describe("DRW-057: startup banner", () => {
  test("banner printed before browser open with name/profile/storage/room/URL", async () => {
    const r = await cli([
      "open",
      "my-room",
      "--no-browser",
      "--storage",
      base,
    ]);
    expect(r.status).toBe(0);
    // Banner content
    expect(r.stdout).toContain("shemma");
    expect(r.stdout).toContain("[dev]");
    expect(r.stdout).toContain("listening on http://localhost:");
    expect(r.stdout).toContain("storage:");
    expect(r.stdout).toContain(subdir);
    expect(r.stdout).toContain("room:");
    expect(r.stdout).toContain("my-room");
  });

  test("banner suppressed in --json mode (byte-compat)", async () => {
    const r = await cli([
      "--json",
      "open",
      "my-room",
      "--no-browser",
      "--storage",
      base,
    ]);
    expect(r.status).toBe(0);
    // Stdout must parse cleanly as JSON — no banner mixed in.
    const j = JSON.parse(r.stdout.trim());
    expect(j.ok).toBe(true);
    expect(j.room).toBe("my-room");
    expect(r.stdout).not.toContain("listening on http://");
    expect(r.stdout).not.toContain("→ opening");
  });

  test("reused daemon distinction: '· daemon already running' (not '✔ daemon started')", async () => {
    // First invocation may "start" (since test srv is already up, getRunningDaemonStorage
    // returns srv.storage → no spawn needed). Banner should say "daemon already running".
    const r = await cli([
      "open",
      "scratch",
      "--no-browser",
      "--storage",
      base,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("daemon already running");
  });

  test("banner omits → opening line when --no-browser is set", async () => {
    const r = await cli([
      "open",
      "no-browser-room",
      "--no-browser",
      "--storage",
      base,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("→ opening");
  });
});
