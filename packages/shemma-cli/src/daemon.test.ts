import { describe, expect, it, beforeEach, spyOn } from "bun:test";
import { __resetNudgeForTesting, __maybePrintMcpNudgeForTesting } from "./daemon";
import { initOutput } from "./ui";

describe("maybePrintMcpNudge", () => {
  let errors: string[];
  let errSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __resetNudgeForTesting();
    errors = [];
    errSpy?.mockRestore();
    errSpy = spyOn(console, "error").mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    delete process.env.SHEMMA_NO_MCP_NUDGE;
    initOutput({ mode: "human" });
  });

  it("prints on first call when verbose=true", () => {
    __maybePrintMcpNudgeForTesting(true);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/register Shemma as MCP server/);
    expect(errors[0]).toMatch(/claude mcp add shemma --scope user -- shemma mcp start/);
    expect(errors[0]).toMatch(/codex mcp add shemma -- shemma mcp start/);
    expect(errors[0]).toMatch(/gemini mcp add shemma --scope user -- shemma mcp start/);
  });

  it("does NOT print on second call in same process (module-level guard)", () => {
    __maybePrintMcpNudgeForTesting(true);
    __maybePrintMcpNudgeForTesting(true);
    expect(errors.length).toBe(1);
  });

  it("does NOT print when verbose=false (ensureSilent path)", () => {
    __maybePrintMcpNudgeForTesting(false);
    expect(errors.length).toBe(0);
  });

  it("does NOT print when SHEMMA_NO_MCP_NUDGE=1", () => {
    process.env.SHEMMA_NO_MCP_NUDGE = "1";
    __maybePrintMcpNudgeForTesting(true);
    expect(errors.length).toBe(0);
  });

  it("does NOT print in JSON output mode", () => {
    initOutput({ mode: "json" });
    __maybePrintMcpNudgeForTesting(true);
    expect(errors.length).toBe(0);
  });
});
