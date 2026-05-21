/**
 * DRW-116: daemon lock integration test.
 *
 * Exercises the new mkdir-lock acquire/release flow end-to-end via subprocess:
 *   1. `daemon start` spawns a real child, acquires the lock, writes PID
 *      metadata into `.shemma-port-<port>.lock/daemon.pid`.
 *   2. A second `daemon start` for the same port detects the healthy holder
 *      and reports `already=true` (reuse path).
 *   3. `daemon stop` SIGTERM's the child, child removes the lock dir on
 *      graceful shutdown, parent force-releases as fallback.
 *
 * Uses an isolated SHEMMA_PORT (62787) to avoid colliding with the user's
 * real release/dev daemon, and tracks the lock dir path so leaks are visible.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const TEST_PORT = 62787;
const LOCK_DIR = join(homedir(), ".claude", `.shemma-port-${TEST_PORT}.lock`);

async function cli(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") merged[k] = v;
  }
  // Pin the daemon to a non-default test port via SHEMMA_PORT.
  merged.SHEMMA_PORT = String(TEST_PORT);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const proc = Bun.spawn(["bun", CLI, "--json", ...args], {
    env: merged,
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

describe("DRW-116: daemon mkdir-lock acquire/release", () => {
  beforeEach(() => {
    // Force-clean any stale state from a previous failing run.
    rmSync(LOCK_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    // Belt-and-braces stop: covers tests that didn't reach their own stop().
    await cli(["daemon", "stop", "--profile", "debug"]).catch(() => {});
    rmSync(LOCK_DIR, { recursive: true, force: true });
  });

  test("first start spawns daemon; second start returns already=true with same pid", async () => {
    const first = await cli(["daemon", "start", "--profile", "debug"]);
    expect(first.status).toBe(0);
    const j1 = JSON.parse(first.stdout);
    expect(j1.ok).toBe(true);
    expect(j1.already).toBeUndefined(); // fresh start
    expect(typeof j1.pid).toBe("number");
    expect(existsSync(join(LOCK_DIR, "daemon.pid"))).toBe(true);

    const second = await cli(["daemon", "start", "--profile", "debug"]);
    expect(second.status).toBe(0);
    const j2 = JSON.parse(second.stdout);
    expect(j2.ok).toBe(true);
    expect(j2.already).toBe(true);
    expect(j2.pid).toBe(j1.pid);

    // Stop and verify lock dir is removed.
    const stopRes = await cli(["daemon", "stop", "--profile", "debug"]);
    expect(stopRes.status).toBe(0);
    expect(existsSync(LOCK_DIR)).toBe(false);
  }, 15000);
});
