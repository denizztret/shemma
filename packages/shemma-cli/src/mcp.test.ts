import { afterEach, describe, expect, it } from "bun:test";
import { __resolveProjectDirForTesting, parseMcpStartFlags } from "./mcp";

describe("parseMcpStartFlags", () => {
  it("parses defaults", () => {
    const o = parseMcpStartFlags([]);
    expect(o).toMatchObject({ autoOpenMode: "once", noAutoEnsure: false });
  });
  it("parses --auto-open never", () => {
    expect(parseMcpStartFlags(["--auto-open", "never"]).autoOpenMode).toBe("never");
  });
  it("rejects invalid --auto-open", () => {
    expect(() => parseMcpStartFlags(["--auto-open", "wat"])).toThrow();
  });
  it("parses --no-auto-ensure", () => {
    expect(parseMcpStartFlags(["--no-auto-ensure"]).noAutoEnsure).toBe(true);
  });
  it("throws hard error on --cwd with migration message (removed in 0.14.0)", () => {
    expect(() => parseMcpStartFlags(["--cwd", "/tmp/x"])).toThrow(
      /--cwd flag was removed in 0\.14\.0/,
    );
    expect(() => parseMcpStartFlags(["--cwd", "/tmp/x"])).toThrow(
      /Set SHEMMA_CWD env/,
    );
  });
  it("silently ignores other unknown flags (minimal surface change)", () => {
    expect(() => parseMcpStartFlags(["--unknown-future-flag", "x"])).not.toThrow();
  });
  it("parses --room id", () => {
    expect(parseMcpStartFlags(["--room", "abc"]).room).toBe("abc");
  });
  it("parses --base-url", () => {
    expect(parseMcpStartFlags(["--base-url", "http://x"]).baseUrl).toBe("http://x");
  });
});

describe("resolveProjectDir (SHEMMA_CWD env resolution)", () => {
  // Pure helper test — no module mocks. cmdMcpStart just forwards the return
  // value of resolveProjectDir() to startStdio's projectDir argument.
  afterEach(() => {
    delete process.env.SHEMMA_CWD;
  });

  it("uses SHEMMA_CWD env when set", () => {
    process.env.SHEMMA_CWD = "/tmp/from-env";
    expect(__resolveProjectDirForTesting()).toBe("/tmp/from-env");
  });

  it("falls back to process.cwd() when SHEMMA_CWD unset", () => {
    delete process.env.SHEMMA_CWD;
    expect(__resolveProjectDirForTesting()).toBe(process.cwd());
  });

  it("trims SHEMMA_CWD whitespace", () => {
    process.env.SHEMMA_CWD = "  /tmp/trimmed  ";
    expect(__resolveProjectDirForTesting()).toBe("/tmp/trimmed");
  });

  it("treats empty SHEMMA_CWD as unset", () => {
    process.env.SHEMMA_CWD = "";
    expect(__resolveProjectDirForTesting()).toBe(process.cwd());
  });
});
