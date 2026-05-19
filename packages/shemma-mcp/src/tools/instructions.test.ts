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

  it("error response does not leak $bunfs path", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const handle = registerInstructionsTool(server);
    // Force an error by mocking loadWorkflowMarkdown to throw
    const { mock } = await import("bun:test");
    // Simulate what happens if the embedded asset is missing: validate the error shape
    // by directly checking the error path in call() with an invalid topic that bypasses
    // the validation guard — we need to test the catch block.
    // The safest approach: call with valid topic but patch Bun.file to throw.
    const originalBunFile = Bun.file.bind(Bun);
    // biome-ignore lint/suspicious/noExplicitAny: test patch
    (Bun as any).file = () => ({ text: async () => { throw new Error("ENOENT: /$bunfs/root/workflow/overview.md"); } });
    try {
      const result = await handle.call({ topic: "overview" });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe("instructions-unavailable");
      expect(parsed.message).not.toContain("$bunfs");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (Bun as any).file = originalBunFile;
    }
  });
});
