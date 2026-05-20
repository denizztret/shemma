import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFilePath,
  readConfig,
  readMiroToken,
  unsetMiroToken,
  writeConfig,
  writeMiroToken,
} from "./config";

let savedXdg: string | undefined;
let tmpRoot: string;

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  tmpRoot = mkdtempSync(join(tmpdir(), "shemma-config-test-"));
  process.env.XDG_CONFIG_HOME = tmpRoot;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("configFilePath — XDG resolution", () => {
  it("returns $XDG_CONFIG_HOME/shemma/config.json when XDG_CONFIG_HOME is set", () => {
    const p = configFilePath();
    expect(p).toBe(join(tmpRoot, "shemma", "config.json"));
  });
});

describe("readConfig", () => {
  it("returns null when file does not exist (ENOENT)", () => {
    expect(readConfig()).toBeNull();
  });

  it("throws with file path on invalid JSON", () => {
    const dir = join(tmpRoot, "shemma");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{not-json");
    expect(() => readConfig()).toThrow(/Invalid JSON/);
  });

  it("returns parsed config on valid JSON", () => {
    const dir = join(tmpRoot, "shemma");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ miro: { token: "abc", createdAt: "2026-05-20T00:00:00Z" } }),
    );
    const cfg = readConfig();
    expect(cfg?.miro?.token).toBe("abc");
  });
});

describe("writeConfig", () => {
  it("creates ~/.config/shemma/ if missing", () => {
    writeConfig({ miro: { token: "tok1" } });
    expect(existsSync(join(tmpRoot, "shemma"))).toBe(true);
    expect(existsSync(join(tmpRoot, "shemma", "config.json"))).toBe(true);
  });

  it("chmod 600 on file create", () => {
    writeConfig({ miro: { token: "tok2" } });
    const st = statSync(join(tmpRoot, "shemma", "config.json"));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("round-trips: writeConfig then readConfig returns same data", () => {
    const data = { miro: { token: "rt", createdAt: "2026-05-20T01:00:00Z" } };
    writeConfig(data);
    expect(readConfig()).toEqual(data);
  });
});

describe("readMiroToken", () => {
  it("returns null when file missing", () => {
    expect(readMiroToken()).toBeNull();
  });

  it("returns null when miro key absent", () => {
    writeConfig({});
    expect(readMiroToken()).toBeNull();
  });

  it("returns token string when set", () => {
    writeConfig({ miro: { token: "tk-42" } });
    expect(readMiroToken()).toBe("tk-42");
  });
});

describe("writeMiroToken", () => {
  it("creates config with miro.token and createdAt timestamp", () => {
    writeMiroToken("new-tok");
    const cfg = readConfig();
    expect(cfg?.miro?.token).toBe("new-tok");
    expect(typeof cfg?.miro?.createdAt).toBe("string");
    expect(cfg?.miro?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("merges with existing config (preserves other top-level keys)", () => {
    writeConfig({ drawio: { token: "drw-tok" } } as never);
    writeMiroToken("miro-tok");
    const cfg = readConfig() as { drawio?: { token?: string }; miro?: { token?: string } };
    expect(cfg.drawio?.token).toBe("drw-tok");
    expect(cfg.miro?.token).toBe("miro-tok");
  });
});

describe("unsetMiroToken", () => {
  it("removes token but keeps other keys", () => {
    writeMiroToken("to-remove");
    unsetMiroToken();
    const cfg = readConfig();
    expect(cfg?.miro?.token).toBeUndefined();
  });

  it("noop when token absent (does not throw)", () => {
    expect(() => unsetMiroToken()).not.toThrow();
  });
});
