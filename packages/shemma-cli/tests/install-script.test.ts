/**
 * Smoke tests for scripts/install.sh (DRW-059 B2):
 *   - Unknown flag handling
 *   - Missing-binary error path with helpful hint about --version
 *   - --version (remote) mode bails cleanly when no PAT + no TTY available
 *
 * We use `Bun.spawn` instead of `spawnSync` (the latter hangs inside `bun test`).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "..", "scripts", "install.sh");

async function runScript(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...extraEnv,
    // Sanitised PATH so an installed gh on dev machines doesn't pick Path A.
    PATH: "/usr/bin:/bin",
    HOME: extraEnv.HOME ?? process.env.HOME ?? "/tmp",
  };
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    env,
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

describe("install.sh argument parsing", () => {
  test("unknown flag → exit 1", async () => {
    const r = await runScript(["--bogus"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown flag");
  });

  test("--prefix without value → exit 1", async () => {
    const r = await runScript(["--prefix"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--prefix requires a value");
  });

  test("default mode reports missing binary with --version hint", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "shemma-install-"));
    try {
      const r = await runScript(["--prefix", prefix, "/nonexistent/shemma"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("binary not found");
      expect(r.stderr).toContain("--version");
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});

describe("install.sh remote mode", () => {
  test("--version latest surfaces a clean error without tools/network", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "shemma-install-latest-"));
    try {
      const r = await runScript(
        [
          "--prefix",
          prefix,
          "--version",
          "latest",
          "--repo",
          "denizztret/this-repo-does-not-exist-xyz",
        ],
        { SHEMMA_GITHUB_TOKEN: "" },
      );
      expect(r.status).not.toBe(0);
      const out = r.stderr + r.stdout;
      const ok =
        out.includes("could not resolve the latest") ||
        out.includes("need curl + jq") ||
        out.includes("jq is required") ||
        out.includes("curl is required");
      if (!ok) {
        console.error("unexpected install.sh latest-mode output:\n" + out);
      }
      expect(ok).toBe(true);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  test("--version without gh/PAT surfaces helpful error", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "shemma-install-remote-"));
    try {
      const r = await runScript(["--prefix", prefix, "--version", "0.0.0-test"], {
        SHEMMA_GITHUB_TOKEN: "",
      });
      expect(r.status).not.toBe(0);
      const stderr = r.stderr;
      const ok =
        stderr.includes("jq is required") ||
        stderr.includes("no TTY available") ||
        stderr.includes("empty PAT") ||
        stderr.includes("curl is required") ||
        stderr.includes("failed to fetch") ||
        stderr.includes("not found in release");
      if (!ok) {
        // Surface diagnostics for forensic CI runs.
        console.error("unexpected install.sh remote-mode stderr:\n" + stderr);
        console.error("stdout:\n" + r.stdout);
      }
      expect(ok).toBe(true);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});
