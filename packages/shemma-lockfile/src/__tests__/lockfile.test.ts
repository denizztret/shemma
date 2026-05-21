import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLock,
  releaseLock,
  isLockAlive,
  readLockMetadata,
  writeLockMetadata,
} from "../index.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shemma-lock-"));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("creates lock dir atomically", () => {
    const lockDir = path.join(tmpRoot, "lock");
    expect(acquireLock(lockDir)).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(true);
  });
  it("returns false on EEXIST", () => {
    const lockDir = path.join(tmpRoot, "lock");
    fs.mkdirSync(lockDir);
    expect(acquireLock(lockDir)).toBe(false);
  });
});

describe("isLockAlive", () => {
  it("returns false on empty lock dir (acquire-in-progress or stale)", () => {
    const lockDir = path.join(tmpRoot, "lock");
    fs.mkdirSync(lockDir);
    expect(isLockAlive(lockDir)).toBe(false);
  });
  it("returns true on alive PID", () => {
    const lockDir = path.join(tmpRoot, "lock");
    fs.mkdirSync(lockDir);
    writeLockMetadata(lockDir, {
      pid: process.pid,
      port: 9999,
      startedAt: "x",
      profile: "release",
    });
    expect(isLockAlive(lockDir)).toBe(true);
  });
});

describe("readLockMetadata", () => {
  it("returns undefined when daemon.pid missing", () => {
    const lockDir = path.join(tmpRoot, "lock");
    fs.mkdirSync(lockDir);
    expect(readLockMetadata(lockDir)).toBeUndefined();
  });
  it("returns parsed metadata when present", () => {
    const lockDir = path.join(tmpRoot, "lock");
    fs.mkdirSync(lockDir);
    writeLockMetadata(lockDir, {
      pid: 42,
      port: 8787,
      startedAt: "2026-05-21T00:00:00Z",
      profile: "release",
    });
    const m = readLockMetadata(lockDir);
    expect(m?.pid).toBe(42);
    expect(m?.port).toBe(8787);
  });
});

describe("releaseLock", () => {
  it("removes lock dir recursively", () => {
    const lockDir = path.join(tmpRoot, "lock");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "daemon.pid"), "{}");
    releaseLock(lockDir);
    expect(fs.existsSync(lockDir)).toBe(false);
  });
  it("no-op if lock dir already gone", () => {
    releaseLock(path.join(tmpRoot, "nonexistent"));
    // no throw expected
  });
});
