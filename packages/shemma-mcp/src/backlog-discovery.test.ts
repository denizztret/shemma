import { describe, expect, it } from "bun:test";
import { discoverInProgressTasks } from "./backlog-discovery";

describe("discoverInProgressTasks", () => {
  it("returns task from SHEMMA_TASK_ID env when set", async () => {
    const tasks = await discoverInProgressTasks({
      env: { SHEMMA_TASK_ID: "DRW-054" },
      runBacklog: async () => { throw new Error("must not be called"); },
    });
    expect(tasks).toEqual([{ id: "DRW-054", slug: "drw-054" }]);
  });

  it("parses backlog plain output when env empty", async () => {
    const tasks = await discoverInProgressTasks({
      env: {},
      runBacklog: async (args) => {
        expect(args).toEqual(["task", "list", "--plain", "--status", "In Progress"]);
        return "DRW-054 - Research/brainstorm MCP server для phase 2.3 (medium)\nDRW-061 - Flaky client test (low)\n";
      },
    });
    expect(tasks).toEqual([
      { id: "DRW-054", slug: "drw-054-research-brainstorm-mcp-server-для-phase-2.3" },
      { id: "DRW-061", slug: "drw-061-flaky-client-test" },
    ]);
  });

  it("returns empty list on backlog error", async () => {
    const tasks = await discoverInProgressTasks({
      env: {},
      runBacklog: async () => { throw new Error("backlog not installed"); },
    });
    expect(tasks).toEqual([]);
  });

  it("returns empty list when backlog returns empty", async () => {
    const tasks = await discoverInProgressTasks({
      env: {},
      runBacklog: async () => "",
    });
    expect(tasks).toEqual([]);
  });
});
