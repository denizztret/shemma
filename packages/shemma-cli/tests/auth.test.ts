import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders, readToken, saveToken } from "../src/auth";

const TMP_BASE = join(tmpdir(), "shemma-auth-test");

function tmpAuthFile(): string {
  const dir = join(TMP_BASE, `t-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "auth.json");
}

const savedEnv = process.env.SHEMMA_GITHUB_TOKEN;

beforeEach(() => {
  delete process.env.SHEMMA_GITHUB_TOKEN;
});

afterEach(() => {
  if (savedEnv !== undefined) {
    process.env.SHEMMA_GITHUB_TOKEN = savedEnv;
  } else {
    delete process.env.SHEMMA_GITHUB_TOKEN;
  }
  try {
    rmSync(TMP_BASE, { recursive: true, force: true });
  } catch {}
});

describe("readToken precedence", () => {
  test("env var wins over file", () => {
    process.env.SHEMMA_GITHUB_TOKEN = "env-token";
    const f = tmpAuthFile();
    writeFileSync(f, JSON.stringify({ github_token: "file-token" }));
    expect(readToken({ skipGhCli: true, authFile: f })).toBe("env-token");
  });

  test("file used when env absent", () => {
    const f = tmpAuthFile();
    writeFileSync(f, JSON.stringify({ github_token: "file-token" }));
    expect(readToken({ skipGhCli: true, authFile: f })).toBe("file-token");
  });

  test("returns null when env + file + gh all absent (skipGhCli)", () => {
    const f = tmpAuthFile();
    // file doesn't exist at path
    expect(readToken({ skipGhCli: true, authFile: f })).toBeNull();
  });

  test("malformed JSON in file → fallthrough to null", () => {
    const f = tmpAuthFile();
    writeFileSync(f, "{not json");
    expect(readToken({ skipGhCli: true, authFile: f })).toBeNull();
  });

  test("empty github_token treated as absent", () => {
    const f = tmpAuthFile();
    writeFileSync(f, JSON.stringify({ github_token: "" }));
    expect(readToken({ skipGhCli: true, authFile: f })).toBeNull();
  });

  test("empty env token treated as absent (falls through to file)", () => {
    process.env.SHEMMA_GITHUB_TOKEN = "";
    const f = tmpAuthFile();
    writeFileSync(f, JSON.stringify({ github_token: "file-token" }));
    expect(readToken({ skipGhCli: true, authFile: f })).toBe("file-token");
  });
});

describe("saveToken", () => {
  test("writes file with chmod 600", () => {
    const f = tmpAuthFile();
    saveToken("test-token-123", { authFile: f });
    const st = statSync(f);
    // POSIX permission bits = mode & 0o777
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("written file is readable by readToken", () => {
    const f = tmpAuthFile();
    saveToken("roundtrip-token", { authFile: f });
    expect(readToken({ skipGhCli: true, authFile: f })).toBe("roundtrip-token");
  });

  test("creates parent dir if absent", () => {
    const dir = join(TMP_BASE, `nested-${Date.now()}`, "deeper");
    const f = join(dir, "auth.json");
    saveToken("nested-token", { authFile: f });
    expect(readToken({ skipGhCli: true, authFile: f })).toBe("nested-token");
  });
});

describe("authHeaders", () => {
  test("includes Authorization Bearer when token present", () => {
    expect(authHeaders("abc")).toEqual({ Authorization: "Bearer abc" });
  });

  test("returns empty object when token is null", () => {
    expect(authHeaders(null)).toEqual({});
  });
});
