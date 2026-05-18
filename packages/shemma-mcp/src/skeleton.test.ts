import { describe, expect, it } from "bun:test";
import { SHEMMA_MCP_VERSION } from "./index";

describe("shemma-mcp skeleton", () => {
  it("exports a non-empty version constant", () => {
    expect(typeof SHEMMA_MCP_VERSION).toBe("string");
    expect(SHEMMA_MCP_VERSION.length).toBeGreaterThan(0);
    expect(SHEMMA_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
