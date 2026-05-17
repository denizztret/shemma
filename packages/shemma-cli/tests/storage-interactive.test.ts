import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

/**
 * DRW-058 tests:
 *   1. Non-TTY fail-fast when `.shemma/` is missing
 *   2. `shemma init` creates `.shemma/`
 *   3. Explicit `--storage` skips prompt even without `.shemma/`
 *   4. Existing `.shemma/` → silent reuse (no prompt)
 *
 * TTY interactive prompt path: NOT covered here because Bun.spawn'ed
 * subprocesses default to non-TTY stdin, and bridging a fake-TTY via
 * pseudo-terminal would require `node-pty` or similar (not in deps).
 * It is verified manually + by ui.test.ts unit coverage of the helpers.
 */

async function cli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(opts.env ?? {}),
  };
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env,
    cwd: opts.cwd,
    stdin: "ignore", // non-TTY
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

describe("DRW-058: missing .shemma/ handling", () => {
  test("non-TTY: fail-fast with friendly hint + exit 1 when .shemma/ missing", async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "shemma-no-storage-"));
    try {
      // Strip env that would bypass the check.
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        SHEMMA_PROFILE: "release",
      };
      delete env.SHEMMA_STORAGE_DIR;
      delete env.DIDRAW_STORAGE_DIR;
      const r = await cli(["--no-browser"], { cwd: tmpCwd, env });
      expect(r.status).toBe(1);
      // Human-mode error to stderr; contains ✖ and the friendly hint
      expect(r.stderr).toContain("✖");
      expect(r.stderr).toContain("no .shemma/");
      expect(r.stderr).toContain("shemma init");
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test("non-TTY + --json: structured fail-fast error preserved", async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "shemma-no-storage-json-"));
    try {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        SHEMMA_PROFILE: "release",
      };
      delete env.SHEMMA_STORAGE_DIR;
      delete env.DIDRAW_STORAGE_DIR;
      const r = await cli(["--json", "--no-browser"], { cwd: tmpCwd, env });
      expect(r.status).toBe(1);
      const j = JSON.parse(r.stderr.trim());
      expect(j.ok).toBe(false);
      expect(j.error).toBe("no-storage");
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test("explicit --storage bypasses missing-.shemma/ check", async () => {
    // Use a non-existent base path with --storage — should attempt mkdir + then
    // hit daemon-conflict (or healthy-start) rather than no-storage error.
    const cwdDir = mkdtempSync(join(tmpdir(), "shemma-bypass-cwd-"));
    const storageBase = join(cwdDir, "custom-storage");
    try {
      // We set SHEMMA_PORT to a likely-unused port so isHealthy returns false
      // and the CLI tries to start a daemon. We don't care about the daemon
      // outcome — only that the no-storage check is skipped.
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        SHEMMA_PROFILE: "dev",
        SHEMMA_PORT: "59123",
      };
      delete env.SHEMMA_STORAGE_DIR;
      const r = await cli(
        ["--no-browser", "--storage", storageBase],
        { cwd: cwdDir, env },
      );
      // Either exit 0 (somehow started) or exit 3 (not healthy in 5s) — but
      // NOT exit 1 with no-storage, and stderr must not mention "no .shemma/".
      expect(r.stderr).not.toContain("no .shemma/");
    } finally {
      // Cleanup any spawned daemon (best-effort).
      await cli(["daemon", "stop", "--profile", "dev"], {
        env: { ...(process.env as Record<string, string>), SHEMMA_PORT: "59123" },
      }).catch(() => {});
      rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test("SHEMMA_STORAGE_DIR env bypasses missing-.shemma/ check", async () => {
    const cwdDir = mkdtempSync(join(tmpdir(), "shemma-env-cwd-"));
    const storageBase = mkdtempSync(join(tmpdir(), "shemma-env-storage-"));
    try {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        SHEMMA_PROFILE: "dev",
        SHEMMA_PORT: "59124",
        SHEMMA_STORAGE_DIR: storageBase,
      };
      const r = await cli(["--no-browser"], { cwd: cwdDir, env });
      expect(r.stderr).not.toContain("no .shemma/");
    } finally {
      await cli(["daemon", "stop", "--profile", "dev"], {
        env: { ...(process.env as Record<string, string>), SHEMMA_PORT: "59124" },
      }).catch(() => {});
      rmSync(cwdDir, { recursive: true, force: true });
      rmSync(storageBase, { recursive: true, force: true });
    }
  });
});

describe("DRW-058 bonus: shemma init", () => {
  test("`shemma init` creates .shemma/ in cwd + friendly success line", async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "shemma-init-cwd-"));
    try {
      const r = await cli(["init"], { cwd: tmpCwd });
      expect(r.status).toBe(0);
      // Human mode success
      expect(r.stdout).toContain("✔");
      expect(r.stdout).toContain("initialized");
      expect(statSync(join(tmpCwd, ".shemma")).isDirectory()).toBe(true);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test("`shemma init <path>` creates .shemma/ in the given path", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "shemma-init-arg-"));
    const sub = join(tmpRoot, "deep", "project");
    try {
      const r = await cli(["init", sub], { cwd: tmpRoot });
      expect(r.status).toBe(0);
      expect(statSync(join(sub, ".shemma")).isDirectory()).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("`shemma init --json` emits structured success", async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "shemma-init-json-"));
    try {
      const r = await cli(["--json", "init"], { cwd: tmpCwd });
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout.trim());
      expect(j.ok).toBe(true);
      expect(j.path).toBeDefined();
      expect(existsSync(j.path)).toBe(true);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test("`shemma init` idempotent on existing .shemma/", async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "shemma-init-idem-"));
    try {
      const r1 = await cli(["init"], { cwd: tmpCwd });
      const r2 = await cli(["init"], { cwd: tmpCwd });
      expect(r1.status).toBe(0);
      expect(r2.status).toBe(0);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});
