import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdConfigGet, cmdConfigSet, cmdConfigUnset } from "./config";
import { initOutput } from "./ui";

let savedXdg: string | undefined;
let tmpRoot: string;
let mockServer: { url: string; stop: () => void } | null = null;

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  tmpRoot = mkdtempSync(join(tmpdir(), "shemma-cli-config-"));
  process.env.XDG_CONFIG_HOME = tmpRoot;
  initOutput({ mode: "human", isTTY: false, isStderrTTY: false });
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(tmpRoot, { recursive: true, force: true });
  mockServer?.stop();
  mockServer = null;
  delete process.env.SHEMMA_MIRO_BASE_URL;
});

function startMiroMock(status: number): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("{}", { status }),
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

describe("cmdConfigSet — miro.token", () => {
  it("writes token to ~/.config/shemma/config.json with chmod 600", async () => {
    mockServer = startMiroMock(200);
    process.env.SHEMMA_MIRO_BASE_URL = mockServer.url;
    await cmdConfigSet("miro.token", "tk-valid");
    const path = join(tmpRoot, "shemma", "config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { miro?: { token?: string } };
    expect(raw.miro?.token).toBe("tk-valid");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("invalid token (401 from Miro): does NOT write file, exits with code 1", async () => {
    mockServer = startMiroMock(401);
    process.env.SHEMMA_MIRO_BASE_URL = mockServer.url;
    const origExit = process.exit;
    let exitCode: number | undefined;
    (process as { exit: (c?: number) => never }).exit = ((c?: number) => {
      exitCode = c;
      throw new Error("EXIT");
    }) as never;
    try {
      await cmdConfigSet("miro.token", "tk-bad").catch(() => {});
      expect(exitCode).toBe(1);
    } finally {
      (process as unknown as { exit: typeof origExit }).exit = origExit;
    }
  });

  it("network offline: writes token with warning (graceful)", async () => {
    process.env.SHEMMA_MIRO_BASE_URL = "http://127.0.0.1:1"; // unreachable
    await cmdConfigSet("miro.token", "tk-offline");
    const path = join(tmpRoot, "shemma", "config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { miro?: { token?: string } };
    expect(raw.miro?.token).toBe("tk-offline");
  });

  it("unknown key: throws / exits with usage error", async () => {
    const origExit = process.exit;
    let exitCode: number | undefined;
    (process as { exit: (c?: number) => never }).exit = ((c?: number) => {
      exitCode = c;
      throw new Error("EXIT");
    }) as never;
    try {
      await cmdConfigSet("miro.weird", "x").catch(() => {});
      expect(exitCode).toBe(1);
    } finally {
      (process as unknown as { exit: typeof origExit }).exit = origExit;
    }
  });
});

describe("cmdConfigGet — miro.token (mask token)", () => {
  it("token absent → prints '[unset]'", async () => {
    const orig = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      await cmdConfigGet("miro.token");
      expect(lines.some((l) => l.includes("[unset]"))).toBe(true);
    } finally {
      console.log = orig;
    }
  });

  it("token set → prints '[set] (N chars)', NEVER the raw token", async () => {
    mockServer = startMiroMock(200);
    process.env.SHEMMA_MIRO_BASE_URL = mockServer.url;
    await cmdConfigSet("miro.token", "tk-secret-1234");

    const orig = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      await cmdConfigGet("miro.token");
      const joined = lines.join("\n");
      expect(joined).toContain("[set]");
      expect(joined).toContain("14 chars");
      expect(joined).not.toContain("tk-secret-1234");
    } finally {
      console.log = orig;
    }
  });
});

describe("cmdConfigUnset — miro.token", () => {
  it("removes token from config", async () => {
    mockServer = startMiroMock(200);
    process.env.SHEMMA_MIRO_BASE_URL = mockServer.url;
    await cmdConfigSet("miro.token", "to-remove");
    await cmdConfigUnset("miro.token");
    const path = join(tmpRoot, "shemma", "config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { miro?: { token?: string } };
    expect(raw.miro?.token).toBeUndefined();
  });

  it("noop when token absent (does not throw)", async () => {
    await expect(cmdConfigUnset("miro.token")).resolves.toBeUndefined();
  });
});

describe("--json mode", () => {
  it("set: emits {ok:true, message:...} JSON", async () => {
    mockServer = startMiroMock(200);
    process.env.SHEMMA_MIRO_BASE_URL = mockServer.url;
    initOutput({ mode: "json", isTTY: false, isStderrTTY: false });
    const orig = process.stdout.write.bind(process.stdout);
    const captured: string[] = [];
    (process.stdout as { write: typeof orig }).write = ((s: string) => {
      captured.push(String(s));
      return true;
    }) as typeof orig;
    try {
      await cmdConfigSet("miro.token", "x");
      const out = captured.join("");
      expect(() => JSON.parse(out)).not.toThrow();
      const j = JSON.parse(out) as { ok?: boolean };
      expect(j.ok).toBe(true);
    } finally {
      (process.stdout as { write: typeof orig }).write = orig;
    }
  });
});
