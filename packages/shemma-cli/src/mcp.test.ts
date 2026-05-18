import { describe, expect, it, mock } from "bun:test";
import { parseMcpStartFlags } from "./mcp";

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

describe("cmdMcpStart projectDir resolution", () => {
  // We mock the @shemma/mcp dynamic import so cmdMcpStart doesn't actually
  // try to open stdio. We capture the projectDir argument passed to startStdio.
  let captured: { projectDir?: string } = {};

  function mockStartStdio() {
    captured = {};
    mock.module("@shemma/mcp", () => ({
      startStdio: async (opts: { projectDir: string }) => {
        captured.projectDir = opts.projectDir;
      },
    }));
  }

  it("uses SHEMMA_CWD env when set", async () => {
    mockStartStdio();
    process.env.SHEMMA_CWD = "/tmp/from-env";
    const { cmdMcpStart } = await import("./mcp");
    await cmdMcpStart([]);
    expect(captured.projectDir).toBe("/tmp/from-env");
    delete process.env.SHEMMA_CWD;
  });

  it("falls back to process.cwd() when SHEMMA_CWD unset", async () => {
    mockStartStdio();
    delete process.env.SHEMMA_CWD;
    const { cmdMcpStart } = await import("./mcp");
    await cmdMcpStart([]);
    expect(captured.projectDir).toBe(process.cwd());
  });

  it("trims SHEMMA_CWD whitespace", async () => {
    mockStartStdio();
    process.env.SHEMMA_CWD = "  /tmp/trimmed  ";
    const { cmdMcpStart } = await import("./mcp");
    await cmdMcpStart([]);
    expect(captured.projectDir).toBe("/tmp/trimmed");
    delete process.env.SHEMMA_CWD;
  });

  it("treats empty SHEMMA_CWD as unset", async () => {
    mockStartStdio();
    process.env.SHEMMA_CWD = "";
    const { cmdMcpStart } = await import("./mcp");
    await cmdMcpStart([]);
    expect(captured.projectDir).toBe(process.cwd());
    delete process.env.SHEMMA_CWD;
  });
});
