/**
 * Cross-package integration test: legacy migration → MCP default space fallback.
 *
 * Intentionally uses a relative import to @shemma/mcp/space-resolver because
 * @shemma/mcp is not a declared dependency of @shemma/backend. The test belongs
 * here (rather than in @shemma/mcp) because it exercises the end-to-end chain
 * that starts with legacy-spaces migration.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSpaces, findSpaceById } from "@shemma/spaces";
import { resolveSpace } from "../../../../../packages/shemma-mcp/src/space-resolver";
import { migrateLegacySpacesIfNeeded } from "../legacy-spaces";

let tmpXdg: string;
let origXdg: string | undefined;
let tmpHome: string;
let origCwd: string;

beforeEach(() => {
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "mig-mcp-xdg-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpXdg;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mig-mcp-home-"));
  origCwd = process.cwd();
});

afterEach(() => {
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  try {
    process.chdir(origCwd);
  } catch {
    // ignore — origCwd might be deleted in edge cases
  }
  fs.rmSync(tmpXdg, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("Legacy migration → MCP default fallback", () => {
  it("MCP call without space resolves to default after legacy migration", () => {
    // Setup: fake legacy project with canvas file
    const projDir = path.join(tmpHome, ".claude", "projects", "legacy-foo");
    fs.mkdirSync(path.join(projDir, "canvas"), { recursive: true });
    fs.writeFileSync(path.join(projDir, "canvas", "r1.json"), "{}");

    // Migrate
    const result = migrateLegacySpacesIfNeeded({ homeDir: tmpHome });
    expect(result.migrated).toBe(1);
    expect(result.defaultId).toBe("default");

    // Verify the space is in the registry
    const def = findSpaceById("default");
    expect(def?.path).toBe(fs.realpathSync(projDir));
    expect(def?.storageLayout).toBe("legacy");

    // chdir to somewhere NOT registered — resolver should fall back to default
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-"));
    try {
      process.chdir(elsewhere);

      // MCP call without explicit space arg
      const resolved = resolveSpace({});
      expect(resolved.space?.id).toBe("default");
      expect(resolved.source).toBe("default");
      expect(resolved.space?.path).toBe(fs.realpathSync(projDir));
      expect(resolved.space?.storageLayout).toBe("legacy");
    } finally {
      fs.rmSync(elsewhere, { recursive: true });
    }
  });

  it("multi-legacy: most-recent becomes default; others are CWD-resolvable", () => {
    const older = path.join(tmpHome, ".claude", "projects", "older-abc");
    const newer = path.join(tmpHome, ".claude", "projects", "newer-xyz");
    fs.mkdirSync(path.join(older, "canvas"), { recursive: true });
    fs.mkdirSync(path.join(newer, "canvas"), { recursive: true });
    fs.writeFileSync(path.join(older, "canvas", "r.json"), "{}");
    fs.writeFileSync(path.join(newer, "canvas", "r.json"), "{}");

    const now = new Date();
    fs.utimesSync(
      path.join(older, "canvas", "r.json"),
      now,
      new Date(now.getTime() - 100_000),
    );
    fs.utimesSync(path.join(newer, "canvas", "r.json"), now, now);

    migrateLegacySpacesIfNeeded({ homeDir: tmpHome });

    // Sanity: 2 spaces registered
    expect(listSpaces()).toHaveLength(2);

    // chdir to older — resolver finds it via CWD match (NOT default)
    process.chdir(older);
    const cwdMatch = resolveSpace({});
    expect(cwdMatch.source).toBe("cwd");
    expect(cwdMatch.space?.path).toBe(fs.realpathSync(older));
    expect(cwdMatch.space?.id).toMatch(/^legacy-/);

    // chdir elsewhere — falls back to default = newer
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "x-"));
    try {
      process.chdir(elsewhere);
      const defaultMatch = resolveSpace({});
      expect(defaultMatch.source).toBe("default");
      expect(defaultMatch.space?.id).toBe("default");
      expect(defaultMatch.space?.path).toBe(fs.realpathSync(newer));
    } finally {
      fs.rmSync(elsewhere, { recursive: true });
    }
  });
});
