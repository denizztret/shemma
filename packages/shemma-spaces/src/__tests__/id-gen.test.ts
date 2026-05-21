import { describe, it, expect } from "bun:test";
import { generateSpaceId, slugify } from "../id-gen.js";

describe("slugify", () => {
  it("lowercases alnum, replaces non-alnum with hyphen", () => {
    expect(slugify("My App")).toBe("my-app");
    expect(slugify("foo_bar.baz")).toBe("foo-bar-baz");
    expect(slugify("--Hi--")).toBe("hi");
  });
  it("returns 'space' for empty input", () => {
    expect(slugify("")).toBe("space");
    expect(slugify("---")).toBe("space");
  });
});

describe("generateSpaceId", () => {
  it("returns slugified basename when free", () => {
    expect(generateSpaceId("/Users/a/ios", new Set())).toBe("ios");
  });
  it("appends -2 on collision", () => {
    expect(generateSpaceId("/Users/a/ios", new Set(["ios"]))).toBe("ios-2");
    expect(generateSpaceId("/Users/a/ios", new Set(["ios", "ios-2"]))).toBe("ios-3");
  });
  it("truncates base to 32 chars before suffix", () => {
    const long = "/a/" + "x".repeat(50);
    expect(generateSpaceId(long, new Set()).length).toBeLessThanOrEqual(32);
  });
  it("bumps reserved 'default' when path differs", () => {
    expect(generateSpaceId("/Users/a/default", new Set(["default"]))).toBe("default-2");
  });
});
