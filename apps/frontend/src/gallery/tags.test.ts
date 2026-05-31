import { afterEach, describe, expect, test } from "bun:test";
import type { RoomTag, RoomTagColor } from "../transport/api";
import { setRoomTags } from "../transport/api";
import { TAG_COLORS, TAG_COLOR_ORDER } from "./tag-colors";
import {
  MAX_TAGS,
  roomMatchesTagFilter,
  validateNewTagName,
} from "./tag-filter";

const ALL_COLORS: RoomTagColor[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray",
];

describe("tag color map", () => {
  test("has an entry for every RoomTagColor (7 colors)", () => {
    for (const c of ALL_COLORS) {
      expect(TAG_COLORS[c]).toBeDefined();
      expect(typeof TAG_COLORS[c].bg).toBe("string");
      expect(typeof TAG_COLORS[c].text).toBe("string");
    }
    expect(Object.keys(TAG_COLORS).sort()).toEqual([...ALL_COLORS].sort());
  });

  test("TAG_COLOR_ORDER lists all 7 colors exactly once", () => {
    expect(TAG_COLOR_ORDER.length).toBe(7);
    expect([...TAG_COLOR_ORDER].sort()).toEqual([...ALL_COLORS].sort());
  });
});

describe("roomMatchesTagFilter (AND logic)", () => {
  const room = (...names: string[]) => ({
    tags: names.map((n) => ({ name: n, color: "blue" as RoomTagColor })),
  });

  test("empty filter matches every room", () => {
    expect(roomMatchesTagFilter(room(), [])).toBe(true);
    expect(roomMatchesTagFilter(room("a"), [])).toBe(true);
    expect(roomMatchesTagFilter({ tags: undefined }, [])).toBe(true);
  });

  test("matches only when ALL active tags present (AND)", () => {
    expect(roomMatchesTagFilter(room("a", "b", "c"), ["a", "b"])).toBe(true);
    expect(roomMatchesTagFilter(room("a"), ["a", "b"])).toBe(false);
  });

  test("untagged room never matches a non-empty filter", () => {
    expect(roomMatchesTagFilter({ tags: undefined }, ["a"])).toBe(false);
    expect(roomMatchesTagFilter(room(), ["a"])).toBe(false);
  });

  test("name match is case-insensitive + trimmed", () => {
    expect(roomMatchesTagFilter(room("Frontend"), [" frontend "])).toBe(true);
  });
});

describe("validateNewTagName", () => {
  test("rejects empty / whitespace", () => {
    expect(validateNewTagName("   ", [])).not.toBeNull();
  });

  test("rejects names over 24 chars", () => {
    expect(validateNewTagName("x".repeat(25), [])).not.toBeNull();
    expect(validateNewTagName("x".repeat(24), [])).toBeNull();
  });

  test("rejects duplicates (case-insensitive)", () => {
    const existing: RoomTag[] = [{ name: "Bug", color: "red" }];
    expect(validateNewTagName("bug", existing)).not.toBeNull();
    expect(validateNewTagName("feature", existing)).toBeNull();
  });

  test("rejects when at MAX_TAGS", () => {
    const full: RoomTag[] = Array.from({ length: MAX_TAGS }, (_, i) => ({
      name: `t${i}`,
      color: "gray",
    }));
    expect(validateNewTagName("more", full)).not.toBeNull();
  });
});

describe("setRoomTags client payload", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("PUTs {tags} body to /api/rooms/:id/tags with space query", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return {
        json: async () => ({ ok: true, tags: [] }),
      } as Response;
    }) as typeof fetch;

    const tags: RoomTag[] = [{ name: "bug", color: "red" }];
    await setRoomTags("my room", tags, "space-1");

    expect(capturedUrl).toBe("/api/rooms/my%20room/tags?space=space-1");
    expect(capturedInit?.method).toBe("PUT");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({ tags });
  });
});
