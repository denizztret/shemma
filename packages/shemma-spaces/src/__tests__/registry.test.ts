import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry, loadAndModify, registerSpace, forgetSpace, listSpaces, findSpaceById } from "../registry.js";

let tmpDir: string;
let origXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shemma-spaces-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
});
afterEach(() => {
  process.env.XDG_CONFIG_HOME = origXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadRegistry", () => {
  it("returns empty schema-v1 when file missing", () => {
    const r = loadRegistry();
    expect(r.schemaVersion).toBe(1);
    expect(r.spaces).toEqual([]);
  });
});

describe("registerSpace", () => {
  it("creates new record on first call", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    const { space, created } = registerSpace(project);
    expect(created).toBe(true);
    expect(space.path).toBe(fs.realpathSync(project));
    expect(space.storageLayout).toBe("project");
    fs.rmSync(project, { recursive: true });
  });

  it("is idempotent on same realpath", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    const a = registerSpace(project);
    const b = registerSpace(project);
    expect(b.created).toBe(false);
    expect(b.space.id).toBe(a.space.id);
    fs.rmSync(project, { recursive: true });
  });
});

describe("listSpaces", () => {
  it("returns spaces sorted by lastUsedAt desc", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "b-"));
    registerSpace(a);
    loadAndModify(reg => {
      reg.spaces[0]!.lastUsedAt = "2020-01-01T00:00:00Z";
      return reg;
    });
    registerSpace(b);
    const sorted = listSpaces();
    expect(sorted[0]!.path).toBe(fs.realpathSync(b));
    fs.rmSync(a, { recursive: true });
    fs.rmSync(b, { recursive: true });
  });
});

describe("forgetSpace", () => {
  it("removes from registry", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "a-"));
    const { space } = registerSpace(a);
    forgetSpace(space.id);
    expect(findSpaceById(space.id)).toBeUndefined();
    fs.rmSync(a, { recursive: true });
  });
});
