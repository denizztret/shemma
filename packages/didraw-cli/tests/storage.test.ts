import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  ensureStorageDir,
  parseStorageArg,
  resolveStorageDirForProfile,
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
