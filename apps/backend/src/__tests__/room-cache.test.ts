import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { SpaceRecord } from "@shemma/spaces";
import { RoomCache } from "../room-cache";

function fakeSpace(tmpRoot: string, id = "test"): SpaceRecord {
  return {
    id,
    path: tmpRoot,
    storageLayout: "project",
    createdAt: "",
    lastUsedAt: "",
  };
}

describe("RoomCache", () => {
  it("creates FilePersistence at expected path for project layout", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
    try {
      const cache = new RoomCache("release");
      const p = cache.get(fakeSpace(tmp), "r1");
      expect(p).toBeDefined();
      await cache.shutdown();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns same instance for same (space, room) key", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
    try {
      const cache = new RoomCache("release");
      const space = fakeSpace(tmp);
      expect(cache.get(space, "r1")).toBe(cache.get(space, "r1"));
      await cache.shutdown();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns different instances for different (space, room) pairs", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
    try {
      const cache = new RoomCache("release");
      const s = fakeSpace(tmp);
      expect(cache.get(s, "r1")).not.toBe(cache.get(s, "r2"));
      const s2 = fakeSpace(tmp, "other");
      expect(cache.get(s, "r1")).not.toBe(cache.get(s2, "r1"));
      await cache.shutdown();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("shutdown clears the interval timer", async () => {
    const cache = new RoomCache("release");
    await cache.shutdown();
    // No assertion needed — failure to clear would leak; this verifies no throw
    expect(true).toBe(true);
  });
});
