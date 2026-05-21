import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSpaces, findSpaceById, spacesJsonPath } from "@shemma/spaces";
import { migrateLegacySpacesIfNeeded, runStartupMigration } from "../legacy-spaces";

let tmpXdg: string;
let origXdg: string | undefined;
let tmpHome: string;

beforeEach(() => {
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "ls-xdg-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpXdg;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ls-home-"));
});

afterEach(() => {
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  fs.rmSync(tmpXdg, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("migrateLegacySpacesIfNeeded", () => {
  it("creates empty registry when home has no .claude/projects/", () => {
    const r = migrateLegacySpacesIfNeeded({ homeDir: tmpHome });
    expect(r.migrated).toBe(0);
    expect(listSpaces()).toEqual([]);
  });

  it("registers a single legacy project as 'default'", () => {
    const projDir = path.join(tmpHome, ".claude", "projects", "foo-abc");
    fs.mkdirSync(path.join(projDir, "canvas"), { recursive: true });
    fs.writeFileSync(path.join(projDir, "canvas", "test.json"), "{}");

    const r = migrateLegacySpacesIfNeeded({ homeDir: tmpHome });

    expect(r.migrated).toBe(1);
    expect(r.defaultId).toBe("default");
    const def = findSpaceById("default");
    expect(def?.path).toBe(fs.realpathSync(projDir));
    expect(def?.storageLayout).toBe("legacy");
    expect(def?.legacy).toBe(true);
    expect(def?.label).toBe("Default (migrated)");
  });

  it("registers multiple projects with most-recent as 'default'", () => {
    const a = path.join(tmpHome, ".claude", "projects", "older-abc");
    const b = path.join(tmpHome, ".claude", "projects", "newer-xyz");
    fs.mkdirSync(path.join(a, "canvas"), { recursive: true });
    fs.mkdirSync(path.join(b, "canvas"), { recursive: true });
    fs.writeFileSync(path.join(a, "canvas", "r1.json"), "{}");
    fs.writeFileSync(path.join(b, "canvas", "r1.json"), "{}");

    const now = new Date();
    fs.utimesSync(path.join(a, "canvas", "r1.json"), now, new Date(now.getTime() - 100_000));
    fs.utimesSync(path.join(b, "canvas", "r1.json"), now, now);

    const r = migrateLegacySpacesIfNeeded({ homeDir: tmpHome });

    expect(r.migrated).toBe(2);
    expect(r.defaultId).toBe("default");
    const def = findSpaceById("default");
    expect(def?.path).toBe(fs.realpathSync(b)); // newer becomes default

    const others = listSpaces().filter(s => s.id !== "default");
    expect(others).toHaveLength(1);
    expect(others[0].id).toMatch(/^legacy-/);
    expect(others[0].storageLayout).toBe("legacy");
    expect(others[0].legacy).toBe(true);
    expect(others[0].path).toBe(fs.realpathSync(a));
  });

  it("is idempotent — second call doesn't add duplicates", () => {
    const projDir = path.join(tmpHome, ".claude", "projects", "foo");
    fs.mkdirSync(path.join(projDir, "canvas"), { recursive: true });
    fs.writeFileSync(path.join(projDir, "canvas", "r.json"), "{}");

    migrateLegacySpacesIfNeeded({ homeDir: tmpHome });
    const before = listSpaces().length;
    const r2 = migrateLegacySpacesIfNeeded({ homeDir: tmpHome });

    expect(r2.migrated).toBe(0); // skipped — spaces.json already exists
    expect(listSpaces()).toHaveLength(before);
  });

  it("ignores directories without canvas/ subdir", () => {
    const projDir = path.join(tmpHome, ".claude", "projects", "no-canvas");
    fs.mkdirSync(projDir, { recursive: true });

    const r = migrateLegacySpacesIfNeeded({ homeDir: tmpHome });

    expect(r.migrated).toBe(0);
    expect(listSpaces()).toEqual([]);
  });
});

describe("runStartupMigration", () => {
  it("skip flag creates empty registry without scanning", () => {
    const projDir = path.join(tmpHome, ".claude", "projects", "foo");
    fs.mkdirSync(path.join(projDir, "canvas"), { recursive: true });

    const r = runStartupMigration({ skipFlag: true, homeDir: tmpHome });

    expect(r.skipped).toBe(true);
    expect(r.migrated).toBe(0);
    expect(listSpaces()).toEqual([]);
    expect(fs.existsSync(spacesJsonPath())).toBe(true);
  });

  it("no skip flag delegates to migrateLegacySpacesIfNeeded", () => {
    const projDir = path.join(tmpHome, ".claude", "projects", "foo");
    fs.mkdirSync(path.join(projDir, "canvas"), { recursive: true });
    fs.writeFileSync(path.join(projDir, "canvas", "r.json"), "{}");

    const r = runStartupMigration({ homeDir: tmpHome });

    expect(r.migrated).toBe(1);
    expect(r.skipped).toBeUndefined();
  });
});
