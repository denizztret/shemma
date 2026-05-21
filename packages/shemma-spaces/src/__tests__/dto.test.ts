import { describe, it, expect } from "bun:test";
import { toPublicDTO, toLocalDTO } from "../dto.js";
import type { SpaceRecord } from "../types.js";

const rec: SpaceRecord = {
  id: "ios",
  path: "/Users/a/ios",
  storageLayout: "project",
  label: "iOS",
  createdAt: "2026-05-21T00:00:00Z",
  lastUsedAt: "2026-05-21T10:00:00Z",
  legacy: false,
};

describe("toPublicDTO", () => {
  it("omits path and storageLayout", () => {
    const dto = toPublicDTO(rec);
    expect(dto).not.toHaveProperty("path");
    expect(dto).not.toHaveProperty("storageLayout");
    expect(dto.id).toBe("ios");
    expect(dto.label).toBe("iOS");
  });
});

describe("toLocalDTO", () => {
  it("includes path and storageLayout", () => {
    const dto = toLocalDTO(rec);
    expect(dto.path).toBe("/Users/a/ios");
    expect(dto.storageLayout).toBe("project");
  });
});
