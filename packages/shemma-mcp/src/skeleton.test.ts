import { describe, expect, it } from "bun:test";
import { SHEMMA_MCP_VERSION } from "./index";

describe("shemma-mcp skeleton", () => {
  it("exports version constant", () => {
    expect(SHEMMA_MCP_VERSION).toBe("0.0.0");
  });
});
