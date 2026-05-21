import { describe, it, expect } from "bun:test";
import path from "node:path";
import { resolveRoomStorage, resolveStorageRoot } from "../storage-resolver.js";
import type { SpaceRecord } from "../types.js";

function fakeSpace(overrides: Partial<SpaceRecord>): SpaceRecord {
  return {
    id: "x",
    path: "/p",
    storageLayout: "project",
    createdAt: "",
    lastUsedAt: "",
    ...overrides,
  };
}

describe("resolveRoomStorage", () => {
  it("project layout uses .shemma/canvas", () => {
    const s = fakeSpace({ path: "/u/proj", storageLayout: "project" });
    expect(resolveRoomStorage(s, "release", "r1")).toBe(path.join("/u/proj", ".shemma", "canvas", "r1.json"));
  });
  it("project layout dev uses canvas-dev", () => {
    const s = fakeSpace({ path: "/u/proj", storageLayout: "project" });
    expect(resolveRoomStorage(s, "dev", "r1")).toBe(path.join("/u/proj", ".shemma", "canvas-dev", "r1.json"));
  });
  it("legacy layout has no .shemma wrapper", () => {
    const s = fakeSpace({ path: "/u/.claude/projects/foo", storageLayout: "legacy" });
    expect(resolveRoomStorage(s, "release", "r1")).toBe(path.join("/u/.claude/projects/foo", "canvas", "r1.json"));
  });
  it("direct layout has no subdir at all", () => {
    const s = fakeSpace({ path: "/x/storage", storageLayout: "direct" });
    expect(resolveRoomStorage(s, "release", "r1")).toBe(path.join("/x/storage", "r1.json"));
    expect(resolveRoomStorage(s, "dev", "r1")).toBe(path.join("/x/storage", "r1.json"));
  });
});
