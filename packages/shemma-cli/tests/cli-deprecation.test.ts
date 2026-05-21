/**
 * Tests for deprecated flags / env vars (DRW-116 Task 23):
 *   - `--storage <path>` emits warning + auto-registers a direct-layout space
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "index.ts");

let tmpXdg: string;

/** Run CLI with XDG_CONFIG_HOME isolated to tmpXdg. */
async function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      XDG_CONFIG_HOME: tmpXdg,
      // Pin to an unused port so daemon-related commands don't block
      SHEMMA_PORT: "59777",
      ...extraEnv,
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

beforeEach(() => {
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "cli-depr-xdg-"));
});

afterEach(() => {
  fs.rmSync(tmpXdg, { recursive: true, force: true });
});

describe("--storage deprecation", () => {
  test("emits warning and auto-registers space on 'open --storage'", async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "depr-stor-"));
    try {
      // --no-browser skips the browser launch; daemon ensure may fail (port
      // 59777 unused) but warning + registry update happen before that.
      const r = await runCli(["open", "--storage", tmpProj, "--no-browser"]);
      expect(r.stderr).toContain("--storage is deprecated");
      expect(r.stderr).toContain("shemma s add");

      // Verify the space was auto-registered by querying 's list --json'.
      // Use a separate invocation with the same XDG so the registry is shared.
      const list = await runCli(["s", "list", "--json"]);
      expect(list.status).toBe(0);
      const parsed = JSON.parse(list.stdout) as { spaces: Array<{ storageLayout: string }> };
      expect(parsed.spaces.length).toBeGreaterThanOrEqual(1);
      const found = parsed.spaces.find((s) => s.storageLayout === "direct");
      expect(found).toBeDefined();
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  test("emits warning on 'daemon start --storage'", async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "depr-dstart-"));
    try {
      // daemon start will attempt to spawn; may succeed or fail depending on
      // environment. We only assert warning appeared — it fires before spawn.
      const r = await runCli([
        "daemon",
        "start",
        "--profile",
        "dev",
        "--storage",
        tmpProj,
      ]);
      expect(r.stderr).toContain("--storage is deprecated");
      // Clean up any daemon that may have started
      await runCli(["daemon", "stop", "--profile", "dev"]).catch(() => {});
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  test("second 'daemon start --storage' on same path does not re-register (idempotent)", async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "depr-idem-"));
    try {
      // First call — deprecation warning + auto-registers the space.
      // We only validate the warning, not daemon spawn outcome.
      const r1 = await runCli([
        "daemon",
        "start",
        "--profile",
        "dev",
        "--storage",
        tmpProj,
      ]);
      expect(r1.stderr).toContain("--storage is deprecated");
      expect(r1.stderr).toContain("Auto-registered");

      const listAfterFirst = await runCli(["s", "list", "--json"]);
      const countFirst = (
        JSON.parse(listAfterFirst.stdout) as { spaces: unknown[] }
      ).spaces.length;

      // Second call — same path; registerSpace is idempotent (path already exists),
      // "Auto-registered" must NOT appear again.
      const r2 = await runCli([
        "daemon",
        "start",
        "--profile",
        "dev",
        "--storage",
        tmpProj,
      ]);
      expect(r2.stderr).toContain("--storage is deprecated");
      expect(r2.stderr).not.toContain("Auto-registered");

      const listAfterSecond = await runCli(["s", "list", "--json"]);
      const countSecond = (
        JSON.parse(listAfterSecond.stdout) as { spaces: unknown[] }
      ).spaces.length;

      // No new spaces were added on the second call.
      expect(countSecond).toBe(countFirst);
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
      await runCli(["daemon", "stop", "--profile", "dev"]).catch(() => {});
    }
  });
});
