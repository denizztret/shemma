import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  ensureStorageDir,
  parseStorageArg,
  resolveStorageDirForProfile,
  resolveStorageForOpen,
} from "../src/storage";

describe("parseStorageArg", () => {
  test("returns undefined when --storage not present", () => {
    const r = parseStorageArg(["start"], "/tmp");
    expect(r.storage).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.rest).toEqual(["start"]);
  });

  test("resolves absolute path as-is", () => {
    const r = parseStorageArg(["start", "--storage", "/abs/path"], "/tmp/cwd");
    expect(r.storage).toBe("/abs/path");
    expect(r.errors).toEqual([]);
    expect(r.rest).toEqual(["start"]);
  });

  test("resolves relative path against cwd", () => {
    const r = parseStorageArg(
      ["start", "--storage", "./local"],
      "/tmp/projects/foo",
    );
    expect(r.storage).toBe(`/tmp/projects/foo${sep}local`);
  });

  test("strips --storage and value from rest", () => {
    const r = parseStorageArg(
      ["start", "--storage", "/p", "--profile", "dev"],
      "/tmp",
    );
    expect(r.rest).toEqual(["start", "--profile", "dev"]);
  });

  test("reports error when --storage missing value (next is a flag)", () => {
    const r = parseStorageArg(["start", "--storage", "--profile"], "/tmp");
    expect(r.storage).toBeUndefined();
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain("--storage requires");
    // --profile not consumed — caller still sees it
    expect(r.rest).toEqual(["start", "--profile"]);
  });

  test("reports error when --storage at end without value", () => {
    const r = parseStorageArg(["start", "--storage"], "/tmp");
    expect(r.storage).toBeUndefined();
    expect(r.errors.length).toBe(1);
  });
});

describe("resolveStorageDirForProfile", () => {
  test("dev → <base>/canvas-dev", () => {
    expect(resolveStorageDirForProfile("/foo", "dev")).toBe(`/foo${sep}canvas-dev`);
  });

  test("release → <base>/canvas", () => {
    expect(resolveStorageDirForProfile("/foo", "release")).toBe(`/foo${sep}canvas`);
  });

  test("debug → <base>/canvas (shares with release)", () => {
    expect(resolveStorageDirForProfile("/foo", "debug")).toBe(`/foo${sep}canvas`);
  });
});

describe("ensureStorageDir", () => {
  test("creates missing dir (recursive)", () => {
    const base = mkdtempSync(join(tmpdir(), "didraw-storage-test-"));
    try {
      const target = join(base, "deep", "canvas-dev");
      expect(existsSync(target)).toBe(false);
      const err = ensureStorageDir(target);
      expect(err).toBeNull();
      expect(statSync(target).isDirectory()).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("idempotent — no error if dir already exists", () => {
    const base = mkdtempSync(join(tmpdir(), "didraw-storage-test-"));
    try {
      const err1 = ensureStorageDir(base);
      const err2 = ensureStorageDir(base);
      expect(err1).toBeNull();
      expect(err2).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("returns error message when path is not creatable", () => {
    // /dev/null/x — нельзя создать subdir под device-файлом
    const err = ensureStorageDir("/dev/null/nope/child");
    expect(err).not.toBeNull();
    expect(err).toContain("cannot create storage dir");
  });
});

describe("resolveStorageForOpen (DRW-052 precedence)", () => {
  const cwd = "/tmp/project-a";

  test("explicit --storage wins over env and cwd-default", () => {
    const r = resolveStorageForOpen(
      { explicit: "/abs/explicit" },
      cwd,
      { DIDRAW_STORAGE_DIR: "/env/path" },
      "dev",
    );
    expect(r.source).toBe("explicit");
    expect(r.base).toBe("/abs/explicit");
    expect(r.storageDir).toBe(`/abs/explicit${sep}canvas-dev`);
  });

  test("explicit relative path resolved against cwd", () => {
    const r = resolveStorageForOpen(
      { explicit: "./local" },
      cwd,
      {},
      "release",
    );
    expect(r.source).toBe("explicit");
    expect(r.base).toBe(`${cwd}${sep}local`);
    expect(r.storageDir).toBe(`${cwd}${sep}local${sep}canvas`);
  });

  test("env DIDRAW_STORAGE_DIR wins when no explicit", () => {
    const r = resolveStorageForOpen(
      {},
      cwd,
      { DIDRAW_STORAGE_DIR: "/env/path" },
      "release",
    );
    expect(r.source).toBe("env");
    expect(r.base).toBe("/env/path");
    expect(r.storageDir).toBe(`/env/path${sep}canvas`);
  });

  test("auto-cwd default = <cwd>/.didraw", () => {
    const r = resolveStorageForOpen({}, cwd, {}, "dev");
    expect(r.source).toBe("auto-cwd");
    expect(r.base).toBe(`${cwd}${sep}.didraw`);
    expect(r.storageDir).toBe(`${cwd}${sep}.didraw${sep}canvas-dev`);
  });

  test("debug profile shares canvas/ subdir with release", () => {
    const r = resolveStorageForOpen({}, cwd, {}, "debug");
    expect(r.storageDir).toBe(`${cwd}${sep}.didraw${sep}canvas`);
  });

  test("empty-string env is treated as set (string type), not unset", () => {
    // Defensive: process.env.X === "" is a valid (but odd) state.
    const r = resolveStorageForOpen({}, cwd, { DIDRAW_STORAGE_DIR: "" }, "dev");
    // Empty string resolves to cwd (path.resolve(cwd, "") === cwd).
    expect(r.source).toBe("env");
    expect(r.base).toBe(cwd);
  });
});
