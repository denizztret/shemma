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
  it("parses --cwd path", () => {
    expect(parseMcpStartFlags(["--cwd", "/tmp/x"]).cwd).toBe("/tmp/x");
  });
  it("parses --room id", () => {
    expect(parseMcpStartFlags(["--room", "abc"]).room).toBe("abc");
  });
  it("parses --base-url", () => {
    expect(parseMcpStartFlags(["--base-url", "http://x"]).baseUrl).toBe("http://x");
  });
});
