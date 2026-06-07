/**
 * DRW-222 — `shemma_apply` carries an opaque `actions` schema
 * (`z.array(z.record(z.unknown()))` → `additionalProperties:{}`), so the action
 * discriminator (`kind`) and per-variant fields are invisible to agents — they
 * had to reverse-engineer the format via repeated `dryRun`. The tool
 * description (and the draw-architecture workflow guide) must spell out the
 * action format: every `kind`, its fields, an example batch, and the verified
 * `\n` / emoji label semantics.
 *
 * Static test (reads source files) — same approach as drw-129-troubleshooting:
 * McpServer's `registerTool` exposes no reflection API for descriptions.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOOLS_DIR = join(import.meta.dir);

function read(file: string): string {
  return readFileSync(join(TOOLS_DIR, file), "utf8");
}

describe("DRW-222 — shemma_apply documents the domain-action format", () => {
  it("description lists every action kind with its fields", () => {
    const src = read("domain.ts");
    const idx = src.indexOf('"shemma_apply"');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 4000);
    // Discriminator + all six kinds present in the apply description block.
    expect(block).toContain("kind");
    for (const kind of [
      "define",
      "connect",
      "group",
      "note",
      "layout",
      "delete",
    ]) {
      expect(block).toContain(kind);
    }
  });

  it("description names the canonical group member field `children`", () => {
    const src = read("domain.ts");
    const idx = src.indexOf('"shemma_apply"');
    const block = src.slice(idx, idx + 4000);
    // The exact pitfall that produced the DRW-220 bug: group members go in
    // `children`, not `ids`.
    expect(block).toContain("children");
  });

  it("description carries a concrete JSON example", () => {
    const src = read("domain.ts");
    const idx = src.indexOf('"shemma_apply"');
    const block = src.slice(idx, idx + 4000);
    expect(block.toLowerCase()).toContain("example");
    // A literal kind:value pair so the example is machine-copyable.
    expect(block).toMatch(/kind[\\"':\s]+define/);
  });

  it("description records the verified \\n + emoji label semantics", () => {
    const src = read("domain.ts");
    const idx = src.indexOf('"shemma_apply"');
    const block = src.slice(idx, idx + 4000);
    // Multi-line labels (\n) render as hard line breaks; emoji are safe.
    expect(block.toLowerCase()).toMatch(/newline|multi-line|line break/);
    expect(block.toLowerCase()).toContain("emoji");
  });

  it("draw-architecture guide has an authoritative action-format section", () => {
    const md = read("../workflow/draw-architecture.md");
    expect(md.toLowerCase()).toContain("action format");
    // And the group line uses the canonical `children` field, not legacy `ids`.
    expect(md).toMatch(/group[^\n]*children/);
  });
});
