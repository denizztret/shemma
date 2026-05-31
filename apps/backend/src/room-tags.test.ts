import { describe, expect, it } from "bun:test";
import { normalizeRoomTags } from "./room-tags";

describe("normalizeRoomTags", () => {
  it("accepts a valid tag array", () => {
    const r = normalizeRoomTags([
      { name: "infra", color: "blue" },
      { name: "wip", color: "orange" },
    ]);
    expect(r).toEqual({
      ok: true,
      tags: [
        { name: "infra", color: "blue" },
        { name: "wip", color: "orange" },
      ],
    });
  });

  it("accepts an empty array", () => {
    expect(normalizeRoomTags([])).toEqual({ ok: true, tags: [] });
  });

  it("trims whitespace from names", () => {
    const r = normalizeRoomTags([{ name: "  x  ", color: "green" }]);
    expect(r).toEqual({ ok: true, tags: [{ name: "x", color: "green" }] });
  });

  it("dedupes by name (case-insensitive, first wins)", () => {
    const r = normalizeRoomTags([
      { name: "Infra", color: "blue" },
      { name: "infra", color: "red" },
      { name: "INFRA", color: "green" },
    ]);
    expect(r).toEqual({ ok: true, tags: [{ name: "Infra", color: "blue" }] });
  });

  it("rejects non-array input", () => {
    const r = normalizeRoomTags({ name: "x", color: "blue" });
    expect(r.ok).toBe(false);
  });

  it("rejects empty name", () => {
    const r = normalizeRoomTags([{ name: "   ", color: "blue" }]);
    expect(r).toEqual({ ok: false, error: "tag.name must be non-empty" });
  });

  it("rejects name over 24 chars", () => {
    const r = normalizeRoomTags([{ name: "y".repeat(25), color: "blue" }]);
    expect(r.ok).toBe(false);
  });

  it("rejects invalid color", () => {
    const r = normalizeRoomTags([{ name: "x", color: "fuchsia" }]);
    expect(r.ok).toBe(false);
  });

  it("rejects more than 12 tags", () => {
    const tags = Array.from({ length: 13 }, (_, i) => ({
      name: `t${i}`,
      color: "blue",
    }));
    const r = normalizeRoomTags(tags);
    expect(r).toEqual({ ok: false, error: "at most 12 tags allowed" });
  });

  it("accepts exactly 12 tags", () => {
    const tags = Array.from({ length: 12 }, (_, i) => ({
      name: `t${i}`,
      color: "blue" as const,
    }));
    const r = normalizeRoomTags(tags);
    expect(r.ok).toBe(true);
  });

  it("rejects entries that are not objects", () => {
    const r = normalizeRoomTags(["not-an-object"]);
    expect(r.ok).toBe(false);
  });
});
