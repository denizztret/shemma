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
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "msr-"));
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
    // ignore — cwd might have been removed
  }
  fs.rmSync(tmpXdg, { recursive: true, force: true });
});

describe("resolveSpace — explicit id", () => {
  it("returns the space when id matches", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "exp-"));
    const { space } = registerSpace(proj);
    const r = resolveSpace({ space: space.id });
    expect(r.space?.id).toBe(space.id);
    expect(r.source).toBe("explicit");
    fs.rmSync(proj, { recursive: true });
  });

  it("returns not_found error for unknown id", () => {
    const r = resolveSpace({ space: "nonexistent" });
    expect(r.space).toBeUndefined();
    expect(r.source).toBe("not_found");
    expect(r.error).toMatch(/space_not_found/);
  });
});

describe("resolveSpace — CWD match", () => {
  it("returns the only matching space", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "cwd-"));
    const { space } = registerSpace(proj);
    process.chdir(proj);
    const r = resolveSpace({});
    expect(r.space?.id).toBe(space.id);
    expect(r.source).toBe("cwd");
    fs.rmSync(proj, { recursive: true });
  });

  it("returns longest prefix match when nested", () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "outer-"));
    const inner = path.join(outer, "inner");
    fs.mkdirSync(inner);
    registerSpace(outer);
    const { space: innerSpace } = registerSpace(inner);
    process.chdir(inner);
    const r = resolveSpace({});
    expect(r.space?.id).toBe(innerSpace.id); // longest match wins
    expect(r.source).toBe("cwd");
    fs.rmSync(outer, { recursive: true });
  });

  it("returns ambiguous when CWD matches nothing and no default exists", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "nomatch-"));
    const someOther = fs.mkdtempSync(path.join(os.tmpdir(), "other-"));
    registerSpace(someOther); // not "default"
    process.chdir(proj);
    const r = resolveSpace({});
    expect(r.space).toBeUndefined();
    expect(r.source).toBe("ambiguous");
    expect(r.error).toMatch(/space_ambiguous/);
    fs.rmSync(proj, { recursive: true });
    fs.rmSync(someOther, { recursive: true });
  });

  it("honours explicit cwd argument over process.cwd()", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "argcwd-"));
    const { space } = registerSpace(proj);
    // Stay in origCwd; pass proj as explicit cwd arg.
    const r = resolveSpace({ cwd: proj });
    expect(r.space?.id).toBe(space.id);
    expect(r.source).toBe("cwd");
    fs.rmSync(proj, { recursive: true });
  });
});

describe("resolveSpace — default fallback", () => {
  it("returns 'default' space when CWD doesn't match and default exists", () => {
    const defaultProj = fs.mkdtempSync(path.join(os.tmpdir(), "def-"));
    const otherProj = fs.mkdtempSync(path.join(os.tmpdir(), "other-"));
    registerSpace(defaultProj, { id: "default" });
    process.chdir(otherProj);
    const r = resolveSpace({});
    expect(r.space?.id).toBe("default");
    expect(r.source).toBe("default");
    fs.rmSync(defaultProj, { recursive: true });
    fs.rmSync(otherProj, { recursive: true });
  });
});

describe("resolveSpace — ambiguity", () => {
  it("returns ambiguous with helpful message when 0 matches and no default", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "b-"));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "x-"));
    registerSpace(a);
    registerSpace(b);
    process.chdir(elsewhere);
    const r = resolveSpace({});
    expect(r.space).toBeUndefined();
    expect(r.source).toBe("ambiguous");
    expect(r.error).toContain("space_ambiguous");
    expect(r.error).toContain("Available spaces:");
    fs.rmSync(a, { recursive: true });
    fs.rmSync(b, { recursive: true });
    fs.rmSync(elsewhere, { recursive: true });
  });

  it("returns ambiguous with 'no spaces registered' hint when registry empty", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "empty-"));
    process.chdir(elsewhere);
    const r = resolveSpace({});
    expect(r.space).toBeUndefined();
    expect(r.source).toBe("ambiguous");
    expect(r.error).toContain("no spaces registered");
    fs.rmSync(elsewhere, { recursive: true });
  });
});
