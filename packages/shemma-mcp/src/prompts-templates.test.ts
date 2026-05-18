import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpPrompts } from "./prompts-templates";

describe("registerMcpPrompts", () => {
  it("registers 4 prompts without throwing", () => {
    const server = new McpServer({ name: "t", version: "0" });
    expect(() => registerMcpPrompts(server)).not.toThrow();
  });
});
