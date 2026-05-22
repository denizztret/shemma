import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../../apps/backend/src/index";

/**
 * DRW-057 / DRW-121: startup banner tests.
 *
 * Strategy: spin up an in-process test daemon on a known port, then run the
 * CLI with `--storage <base>` (legacy direct-layout registration) so the CLI
 * has a concrete space target.
 */

const CLI = join(import.meta.dir, "..", "src", "index.ts");

let srv: { port: number; close: () => Promise<void> };
let base: string;
let xdg: string;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "shemma-banner-base-"));
  // DRW-123: isolate registry writes — child CLI runs against an empty
  // `<xdg>/.config/shemma/spaces.json`, never touches the user's real one.
  xdg = mkdtempSync(join(tmpdir(), "shemma-banner-xdg-"));
  mkdirSync(base, { recursive: true });
  srv = await startServer({ port: 0 });
});

afterAll(async () => {
  await srv.close();
  rmSync(base, { recursive: true, force: true });
  rmSync(xdg, { recursive: true, force: true });
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
      XDG_CONFIG_HOME: xdg,
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

describe("DRW-057: startup banner (DRW-121 — space-aware)", () => {
  test("banner prints name/profile/storage/room/URL with the registered space path", async () => {
    const r = await cli([
      "open",
      "my-room",
      "--no-browser",
      "--storage",
      base,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("shemma");
    expect(r.stdout).toContain("[dev]");
    expect(r.stdout).toContain("listening on http://localhost:");
    expect(r.stdout).toContain("storage:");
    // DRW-121: storage row shows the registered space path (base), not a
    // synthesized canvas-dev subdir.
    expect(r.stdout).toContain(base);
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
    const j = JSON.parse(r.stdout.trim());
    expect(j.ok).toBe(true);
    expect(j.room).toBe("my-room");
    expect(r.stdout).not.toContain("listening on http://");
    expect(r.stdout).not.toContain("→ opening");
  });

  test("reused daemon distinction shows in banner", async () => {
    const r = await cli([
      "open",
      "scratch",
      "--no-browser",
      "--storage",
      base,
    ]);
    expect(r.status).toBe(0);
    // DRW-121: singleton daemon — banner always says "already running" when
    // SHEMMA_PORT points at a live server.
    expect(r.stdout).toContain("daemon already running");
  });

  test("banner omits opening line when --no-browser is set", async () => {
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
