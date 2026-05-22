/**
 * DRW-129 — MCP tool descriptions must carry Troubleshooting sections for
 * known failure modes so agents stop retry-looping on `no-client-connected`
 * and friends. We don't enforce exact wording; we just pin presence of the
 * key markers in the source-level description strings.
 *
 * Static test (reads source files), not a runtime probe — McpServer's
 * `registerTool` doesn't expose a reflection API for descriptions, and we
 * don't want to monkey-patch the SDK just to peek at registered metadata.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOOLS_DIR = join(import.meta.dir);

function read(file: string): string {
  return readFileSync(join(TOOLS_DIR, file), "utf8");
}

describe("DRW-129 — MCP tool Troubleshooting sections", () => {
  it("shemma_import_mermaid description mentions Troubleshooting + WS + DevTools fallback", () => {
    const src = read("domain.ts");
    // Pin the registration block via the tool name so we don't false-positive
    // on other strings in the file.
    const idx = src.indexOf('"shemma_import_mermaid"');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 4000);
    expect(block).toContain("Troubleshooting:");
    expect(block).toContain("WebSocket");
    expect(block).toContain("window.shemmaImportMermaid");
    expect(block).toContain("shemma_active_rooms");
  });

  it("shemma_open description mentions Troubleshooting + spawned≠connected", () => {
    const src = read("open.ts");
    expect(src).toContain("Troubleshooting:");
    expect(src).toContain("spawned:true");
    expect(src).toContain("active_rooms");
  });

  it("shemma_health description (DRW-126) spells out space + fallback semantics", () => {
    const src = read("read-only.ts");
    const idx = src.indexOf('"shemma_health"');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2000);
    expect(block).toContain("space");
    expect(block).toContain("fallback");
  });
});
