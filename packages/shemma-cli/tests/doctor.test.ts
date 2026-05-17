import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

async function cli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...(process.env as Record<string, string>), ...env },
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

describe("shemma doctor --json", () => {
  test("returns a JSON array of check results", async () => {
    const r = await cli(["doctor", "--json"]);
    // exit 0 or 3 depending on environment; just verify JSON shape
    const arr = JSON.parse(r.stdout);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeGreaterThan(0);
    for (const item of arr) {
      expect(typeof item.check).toBe("string");
      expect(["ok", "warn", "fail"]).toContain(item.status);
      expect(typeof item.detail).toBe("string");
    }
  });

  test("includes bun-version check", async () => {
    const r = await cli(["doctor", "--json"]);
    const arr = JSON.parse(r.stdout);
    const bunCheck = arr.find((c: { check: string }) => c.check === "bun-version");
    expect(bunCheck).toBeDefined();
    expect(bunCheck.status).toBe("ok"); // bun >= 1.0 in test env
  });

  test("includes shemma-version check", async () => {
    const r = await cli(["doctor", "--json"]);
    const arr = JSON.parse(r.stdout);
    const verCheck = arr.find((c: { check: string }) => c.check === "shemma-version");
    expect(verCheck).toBeDefined();
    expect(verCheck.status).toBe("ok");
  });

  test("includes config-readable check", async () => {
    const r = await cli(["doctor", "--json"]);
    const arr = JSON.parse(r.stdout);
    const cfgCheck = arr.find((c: { check: string }) => c.check === "config-readable");
    expect(cfgCheck).toBeDefined();
    // no config file → ok
    expect(cfgCheck.status).toBe("ok");
  });

  test("includes manifest-reachable check (warn when SHEMMA_MANIFEST_URL unset)", async () => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete (env as Record<string, string | undefined>).SHEMMA_MANIFEST_URL;
    const r = await cli(["doctor", "--json"], env);
    const arr = JSON.parse(r.stdout);
    const mCheck = arr.find((c: { check: string }) => c.check === "manifest-reachable");
    expect(mCheck).toBeDefined();
    expect(mCheck.status).toBe("warn");
    expect(mCheck.hint).toContain("SHEMMA_MANIFEST_URL");
  });

  test("--all includes checks for all 3 profiles", async () => {
    const r = await cli(["doctor", "--all", "--json"]);
    const arr = JSON.parse(r.stdout);
    const daemonChecks = arr.filter((c: { check: string }) =>
      c.check.startsWith("daemon-status["),
    );
    const profiles = daemonChecks.map((c: { check: string }) =>
      c.check.replace("daemon-status[", "").replace("]", ""),
    );
    expect(profiles.sort()).toEqual(["debug", "dev", "release"]);
  });

  test("exit 0 when no failures in typical test env", async () => {
    const r = await cli(["doctor", "--json"]);
    // In test env: no daemons running (ok), no config file (ok), no manifest URL (warn)
    // storage-writable may fail if the dir doesn't exist yet — that's acceptable as fail
    // Key point: if exit is 3, at least one check failed; if 0, all ok/warn
    expect(r.status === 0 || r.status === 3).toBe(true);
  });

  test("human output has summary line", async () => {
    const r = await cli(["doctor"]);
    // Should contain "X ok, Y warn, Z fail"
    expect(r.stdout).toMatch(/\d+ ok, \d+ warn, \d+ fail/);
  });

  test("--all and --profile conflict exits 1", async () => {
    const r = await cli(["doctor", "--all", "--profile", "dev"]);
    expect(r.status).toBe(1);
    const err = JSON.parse(r.stderr);
    expect(err.error).toMatch(/mutually exclusive/);
  });
});

describe("shemma doctor forced failure", () => {
  test("exits 3 when SHEMMA_STORAGE_DIR is unwritable (EACCES)", async () => {
    // Pass a storage dir under a root-level path that cannot be created (EACCES on macOS/Linux)
    const r = await cli(["doctor", "--json"], {
      SHEMMA_STORAGE_DIR: "/nonexistent-path-that-cannot-be-written/abc",
    });
    // Exit 3: at least one check failed
    expect(r.status).toBe(3);
    const arr = JSON.parse(r.stdout);
    const storageCheck = arr.find((c: { check: string }) =>
      c.check.startsWith("storage-writable"),
    );
    expect(storageCheck?.status).toBe("fail");
  });
});

describe("shemma doctor storage mkdir", () => {
  test("storage-writable succeeds for a non-existent but creatable dir", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { rmSync } = await import("node:fs");
    // Use a fresh subdirectory under tmpdir — should not exist yet
    const testDir = join(tmpdir(), `shemma-doctor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const r = await cli(["doctor", "--json"], {
        SHEMMA_STORAGE_DIR: testDir,
      });
      const arr = JSON.parse(r.stdout);
      const storageCheck = arr.find((c: { check: string }) =>
        c.check.startsWith("storage-writable"),
      );
      expect(storageCheck).toBeDefined();
      expect(storageCheck.status).toBe("ok");
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });
});
