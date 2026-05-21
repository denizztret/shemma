import { describe, expect, it } from "bun:test";
import { applyBackToGallery, applyOpenRoom } from "../column-transitions";
import type { Column } from "../url-parser";

describe("applyOpenRoom", () => {
  it("converts a single gallery column to a room column", () => {
    const cols: Column[] = [{ kind: "gallery", spaceId: "A" }];
    expect(applyOpenRoom(cols, 0, "foo")).toEqual([
      { kind: "room", spaceId: "A", roomId: "foo" },
    ]);
  });

  it("preserves other columns when transforming column at index i", () => {
    const cols: Column[] = [
      { kind: "gallery", spaceId: "A" },
      { kind: "gallery", spaceId: "B" },
    ];
    expect(applyOpenRoom(cols, 1, "bar")).toEqual([
      { kind: "gallery", spaceId: "A" },
      { kind: "room", spaceId: "B", roomId: "bar" },
    ]);
  });

  it("does not mutate the input array", () => {
    const cols: Column[] = [{ kind: "gallery", spaceId: "A" }];
    const next = applyOpenRoom(cols, 0, "foo");
    expect(cols).toEqual([{ kind: "gallery", spaceId: "A" }]);
    expect(next).not.toBe(cols);
  });

  it("returns the original array when index is out of range", () => {
    const cols: Column[] = [{ kind: "gallery", spaceId: "A" }];
    expect(applyOpenRoom(cols, 5, "foo")).toBe(cols);
  });
});

describe("applyBackToGallery", () => {
  it("converts a room column back to gallery", () => {
    const cols: Column[] = [{ kind: "room", spaceId: "A", roomId: "foo" }];
    expect(applyBackToGallery(cols, 0)).toEqual([
      { kind: "gallery", spaceId: "A" },
    ]);
  });

  it("preserves siblings when reverting column at index i", () => {
    const cols: Column[] = [
      { kind: "gallery", spaceId: "A" },
      { kind: "room", spaceId: "B", roomId: "bar" },
    ];
    expect(applyBackToGallery(cols, 1)).toEqual([
      { kind: "gallery", spaceId: "A" },
      { kind: "gallery", spaceId: "B" },
    ]);
  });

  it("returns the original array when index is out of range", () => {
    const cols: Column[] = [{ kind: "room", spaceId: "A", roomId: "foo" }];
    expect(applyBackToGallery(cols, 5)).toBe(cols);
  });
});
