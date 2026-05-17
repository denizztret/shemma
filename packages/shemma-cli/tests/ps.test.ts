import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

async function cli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // Group A (DRW-056): default output is friendly; tests opt-in to --json.
  const proc = Bun.spawn(["bun", CLI, "--json", ...args], {
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

describe("shemma ps", () => {
  test("ps returns JSON array of all profiles", async () => {
    const r = await cli(["ps"]);
    expect(r.status).toBe(0);
    const arr = JSON.parse(r.stdout);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(3);
    const profiles = arr.map((e: { profile: string }) => e.profile).sort();
    expect(profiles).toEqual(["debug", "dev", "release"]);
  });

  test("ps entries have required fields", async () => {
    const r = await cli(["ps"]);
    expect(r.status).toBe(0);
    const arr = JSON.parse(r.stdout);
    for (const entry of arr) {
      expect(typeof entry.profile).toBe("string");
      expect(typeof entry.port).toBe("number");
      expect(typeof entry.running).toBe("boolean");
      expect(typeof entry.healthy).toBe("boolean");
    }
  });

  test("ps exits 0 even when no daemons running", async () => {
    // Ensure no live daemons affect exit code
    const r = await cli(["ps"]);
    expect(r.status).toBe(0);
  });
});

describe("shemma ps per-profile port", () => {
  test("release entry shows port 8787 even when running as dev profile", async () => {
    // Run ps with SHEMMA_PROFILE=dev env — release profile must still show 8787
    const r = await cli(["ps"], { SHEMMA_PROFILE: "dev" });
    expect(r.status).toBe(0);
    const arr = JSON.parse(r.stdout);
    const releaseEntry = arr.find((e: { profile: string }) => e.profile === "release");
    expect(releaseEntry).toBeDefined();
    expect(releaseEntry.port).toBe(8787);
  });

  test("dev entry shows port 8788 when running as release profile", async () => {
    const r = await cli(["ps"], { SHEMMA_PROFILE: "release" });
    expect(r.status).toBe(0);
    const arr = JSON.parse(r.stdout);
    const devEntry = arr.find((e: { profile: string }) => e.profile === "dev");
    expect(devEntry).toBeDefined();
    expect(devEntry.port).toBe(8788);
  });
});

describe("shemma --debug flag", () => {
  test("--debug sets profile to debug", async () => {
    // We test this by checking that daemon status with --debug points to port 8787
    const r = await cli(["daemon", "status", "--debug"]);
    // daemon status may fail if no daemon is running, but exit code should be 0 for status
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.profile).toBe("debug");
    expect(j.port).toBe(8787);
  });
});
