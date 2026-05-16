import { describe, expect, test } from "bun:test";
import { slugifyProject } from "../src/config";

describe("slugifyProject — length cap (I1)", () => {
  test("caps body to 246 chars + 9-char hash suffix = <=255 total", () => {
    // basename of this path is 250 'a's (>246), should be capped.
    const longPath = "/home/user/" + "a".repeat(250);
    const slug = slugifyProject(longPath);
    expect(slug.length).toBeLessThanOrEqual(255);
    // 246-char body + "-" + 8 hex = 255
    expect(slug.length).toBe(255);
    expect(slug).toMatch(/-[0-9a-f]{8}$/);
  });

  test("very long basename (1000 chars) still <=255 total", () => {
    const slug = slugifyProject("/x/" + "b".repeat(1000));
    expect(slug.length).toBeLessThanOrEqual(255);
  });

  test("slug stays deterministic for same long input", () => {
    const p = "/home/user/" + "c".repeat(300);
    expect(slugifyProject(p)).toBe(slugifyProject(p));
  });

  test("short paths are unaffected by the cap", () => {
    const slug = slugifyProject("/home/user/proj");
    expect(slug).toMatch(/^proj-[0-9a-f]{8}$/);
    expect(slug.length).toBe("proj".length + 1 + 8);
  });

  test("body of exactly 246 chars is not truncated", () => {
    const basename = "d".repeat(246);
    const slug = slugifyProject("/x/" + basename);
    expect(slug.startsWith(basename + "-")).toBe(true);
    expect(slug.length).toBe(255);
  });
});
