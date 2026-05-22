import { describe, expect, it, beforeEach, spyOn } from "bun:test";
import {
  __resetNudgeForTesting,
  __maybePrintMcpNudgeForTesting,
  evaluateLockOwnership,
} from "./daemon";
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

// DRW-132: release and debug share port 8787 → share the lockDir → both
// read the same daemon.pid metadata. Pre-fix, status(profile) returned
// running:true (with pid) for whichever non-holder profile happened to
// share the port. evaluateLockOwnership is the pure branch that decides.
describe("evaluateLockOwnership — DRW-132", () => {
  const alwaysAlive = () => true;
  const meta = { pid: 12345, profile: "release", startedAt: "2026-05-22T00:00:00Z" };

  it("missing metadata → null (not running)", () => {
    expect(evaluateLockOwnership(undefined, "release", alwaysAlive)).toBeNull();
  });

  it("dead holder pid → null (not running)", () => {
    expect(
      evaluateLockOwnership(meta, "release", () => false),
    ).toBeNull();
  });

  it("profile match + alive → returns owner details", () => {
    expect(evaluateLockOwnership(meta, "release", alwaysAlive)).toEqual({
      pid: 12345,
      startedAt: "2026-05-22T00:00:00Z",
    });
  });

  it("profile mismatch (debug querying release's lock) → null", () => {
    expect(evaluateLockOwnership(meta, "debug", alwaysAlive)).toBeNull();
  });

  it("symmetric: release querying a debug lock → null", () => {
    const debugMeta = { ...meta, profile: "debug" };
    expect(evaluateLockOwnership(debugMeta, "release", alwaysAlive)).toBeNull();
  });
});
