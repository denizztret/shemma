import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstructionsTool } from "./instructions";

describe("shemma_get_instructions", () => {
  it("registers tool and returns overview by default", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const handle = registerInstructionsTool(server);
    const result = await handle.call({});
    expect(result.content[0].text).toContain("Shemma — agent overview");
  });

  it("returns requested topic", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const handle = registerInstructionsTool(server);
    const result = await handle.call({ topic: "trust-model" });
    expect(result.content[0].text).toContain("Trust model");
  });

  it("returns error for invalid topic", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const handle = registerInstructionsTool(server);
    const result = await handle.call({ topic: "unknown" as unknown as "overview" });
    expect(result.isError).toBe(true);
  });
});
