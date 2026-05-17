import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveProjectSlug, slugifyProject } from "../src/config";

describe("slugifyProject", () => {
  test("collision-resistant: same basename different paths → different slugs", () => {
    const a = slugifyProject("/home/u1/proj");
    const b = slugifyProject("/home/u2/proj");
    expect(a).not.toBe(b);
    expect(a).toMatch(/-[0-9a-f]{8}$/);                // 8-char hex hash suffix
    expect(b).toMatch(/-[0-9a-f]{8}$/);
    expect(a.startsWith("proj-")).toBe(true);          // body preserved
    expect(b.startsWith("proj-")).toBe(true);
  });

  test("lowercase + slashes to dashes + no leading/trailing dash", () => {
    const s = slugifyProject("/Some/Path/With Caps");
    expect(s).toMatch(/^[a-z0-9_-]+$/);
    expect(s.startsWith("-")).toBe(false);
    expect(s.endsWith("-")).toBe(false);
  });

  test("collapse runs of dashes", () => {
    const s = slugifyProject("///deep////path");
    expect(s).not.toMatch(/--/);
  });

  test("empty / undefined → default", () => {
    expect(slugifyProject("")).toBe("default-project");
    expect(slugifyProject(undefined)).toBe("default-project");
  });

  test("non-empty input whose body collapses to empty → default", () => {
    expect(slugifyProject("***")).toBe("default-project");
    expect(slugifyProject("/проект")).toBe("default-project");
  });

  test("deterministic", () => {
    expect(slugifyProject("/some/path")).toBe(slugifyProject("/some/path"));
  });
});

describe("resolveProjectSlug", () => {
  const ORIG = {
    DIDRAW: process.env.SHEMMA_PROJECT_DIR,
    CLAUDE: process.env.CLAUDE_PROJECT_DIR,
  };
  beforeEach(() => {
    delete process.env.SHEMMA_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });
  afterEach(() => {
    if (ORIG.DIDRAW !== undefined) process.env.SHEMMA_PROJECT_DIR = ORIG.DIDRAW;
    if (ORIG.CLAUDE !== undefined) process.env.CLAUDE_PROJECT_DIR = ORIG.CLAUDE;
  });

  test("SHEMMA_PROJECT_DIR wins over CLAUDE_PROJECT_DIR", () => {
    process.env.SHEMMA_PROJECT_DIR = "/explicit/path";
    process.env.CLAUDE_PROJECT_DIR = "/claude/path";
    expect(resolveProjectSlug()).toBe(slugifyProject("/explicit/path"));
  });

  test("CLAUDE_PROJECT_DIR wins over cwd", () => {
    process.env.CLAUDE_PROJECT_DIR = "/claude/path";
    expect(resolveProjectSlug()).toBe(slugifyProject("/claude/path"));
  });

  test("cwd as fallback", () => {
    expect(resolveProjectSlug()).toBe(slugifyProject(process.cwd()));
  });
});
