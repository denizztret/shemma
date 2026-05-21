import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerSpace } from "@shemma/spaces";
import { resolveSpace } from "../space-resolver";

let tmpXdg: string;
let origXdg: string | undefined;
let origCwd: string;

beforeEach(() => {
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-integ-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpXdg;
  origCwd = process.cwd();
});

afterEach(() => {
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  try {
    process.chdir(origCwd);
  } catch {
    // ignore — cwd may have been removed
  }
  fs.rmSync(tmpXdg, { recursive: true, force: true });
});

describe("MCP end-to-end space resolution", () => {
  it("CWD match: tool call without space → resolver picks correct space", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const { space } = registerSpace(proj);
      process.chdir(proj);

      const resolved = resolveSpace({});
      expect(resolved.source).toBe("cwd");
      expect(resolved.space?.id).toBe(space.id);
    } finally {
      fs.rmSync(proj, { recursive: true });
    }
  });

  it("Default fallback: legacy migration scenario — 'default' space resolves when CWD doesn't match", () => {
    const defaultProj = fs.mkdtempSync(path.join(os.tmpdir(), "default-"));
    const otherProj = fs.mkdtempSync(path.join(os.tmpdir(), "other-"));
    try {
      registerSpace(defaultProj, { id: "default" });
      process.chdir(otherProj);

      const resolved = resolveSpace({});
      expect(resolved.source).toBe("default");
      expect(resolved.space?.id).toBe("default");
    } finally {
      fs.rmSync(defaultProj, { recursive: true });
      fs.rmSync(otherProj, { recursive: true });
    }
  });

  it("Explicit > CWD: passing space arg overrides CWD match", () => {
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), "a-"));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), "b-"));
    try {
      const { space: spaceA } = registerSpace(projA);
      const { space: spaceB } = registerSpace(projB);
      process.chdir(projA);

      // CWD-only resolves to A
      expect(resolveSpace({}).space?.id).toBe(spaceA.id);
      // Explicit B overrides
      expect(resolveSpace({ space: spaceB.id }).space?.id).toBe(spaceB.id);
    } finally {
      fs.rmSync(projA, { recursive: true });
      fs.rmSync(projB, { recursive: true });
    }
  });

  it("Ambiguous error when no CWD match, no default, multiple spaces", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "b-"));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "x-"));
    try {
      registerSpace(a);
      registerSpace(b);
      process.chdir(elsewhere);

      const resolved = resolveSpace({});
      expect(resolved.source).toBe("ambiguous");
      expect(resolved.error).toContain("Available spaces");
    } finally {
      fs.rmSync(a, { recursive: true });
      fs.rmSync(b, { recursive: true });
      fs.rmSync(elsewhere, { recursive: true });
    }
  });
});
