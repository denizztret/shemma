import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const PROFILE_SRC = join(import.meta.dir, "..", "src", "profile.ts");
const CONFIG_SRC = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "apps",
  "backend",
  "src",
  "config.ts",
);

function spawnBunScript(
  script: string,
  env: NodeJS.ProcessEnv,
): { stdout: string; status: number | null } {
  const result = spawnSync("bun", ["-e", script], {
    encoding: "utf8",
    env,
  });
  return { stdout: result.stdout.trim(), status: result.status };
}

describe("runtime profile isolation", () => {
  test("dev and release have different default ports", () => {
    const env = { ...process.env };
    env.SHEMMA_PORT = undefined;

    const script = `
      const { portFor } = await import("${PROFILE_SRC}");
      console.log(JSON.stringify({ dev: portFor("dev"), release: portFor("release") }));
    `;

    const { stdout, status } = spawnBunScript(script, env);
    expect(status).toBe(0);
    const j = JSON.parse(stdout);
    expect(j.dev).toBe(8788);
    expect(j.release).toBe(8787);
  });

  test("pid files are profile-specific", () => {
    const script = `
      const { pidFile } = await import("${PROFILE_SRC}");
      console.log(JSON.stringify({ dev: pidFile("dev"), release: pidFile("release") }));
    `;

    const { stdout, status } = spawnBunScript(script, process.env);
    expect(status).toBe(0);
    const j = JSON.parse(stdout);
    expect(j.dev).not.toBe(j.release);
    expect(j.dev).toContain("shemma-dev");
    expect(j.release).toContain("shemma-release");
  });

  test("storage directory differs per profile", () => {
    const devEnv = { ...process.env, SHEMMA_PROFILE: "dev" };
    devEnv.SHEMMA_STORAGE_DIR = undefined;

    const releaseEnv = { ...process.env, SHEMMA_PROFILE: "release" };
    releaseEnv.SHEMMA_STORAGE_DIR = undefined;

    const script = `
      const { getConfig } = await import("${CONFIG_SRC}");
      console.log(getConfig().storageDir);
    `;

    const { stdout: devPath, status: devStatus } = spawnBunScript(
      script,
      devEnv,
    );
    const { stdout: releasePath, status: releaseStatus } = spawnBunScript(
      script,
      releaseEnv,
    );

    expect(devStatus).toBe(0);
    expect(releaseStatus).toBe(0);

    expect(devPath).not.toBe(releasePath);
    expect(devPath).toContain("canvas-dev");
    expect(releasePath).toMatch(/\/canvas$/);
  });
});
