import { describe, expect, it } from "bun:test";
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
