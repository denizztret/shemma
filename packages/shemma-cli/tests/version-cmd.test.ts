/**
 * Verify dev-mode version fallback (DRW-059 B3):
 * when SHEMMA_VERSION env is absent the `shemma version` command reads
 * package.json:version and suffixes `-dev` (instead of legacy "unknown").
 *
 * `Bun.spawn` is required (spawnSync hangs inside `bun test`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const PKG_PATH = join(import.meta.dir, "..", "package.json");

function pkgVersion(): string {
  return (JSON.parse(readFileSync(PKG_PATH, "utf8")) as { version: string }).version;
}

async function cli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...(process.env as Record<string, string>), ...env },
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

describe("shemma version dev-mode fallback", () => {
  test("uses package.json:version + '-dev' when SHEMMA_VERSION is unset", async () => {
    const r = await cli(["--json", "version"], {
      SHEMMA_PROFILE: "dev",
      SHEMMA_PORT: "65193",
      SHEMMA_VERSION: "",
    });
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.version).toBe(`${pkgVersion()}-dev`);
    expect(payload.daemonRunning).toBe(false);
  });

  test("uses SHEMMA_VERSION verbatim when set", async () => {
    const r = await cli(["--json", "version"], {
      SHEMMA_PROFILE: "dev",
      SHEMMA_PORT: "65194",
      SHEMMA_VERSION: "9.9.9",
    });
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.version).toBe("9.9.9");
  });
});
