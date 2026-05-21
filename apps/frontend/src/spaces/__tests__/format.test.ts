import { describe, expect, it } from "bun:test";
import { relativeTime, truncatePath } from "../format";

describe("truncatePath", () => {
  it("returns path unchanged when ≤ 50 chars", () => {
    expect(truncatePath("/Users/me/Projects/short")).toBe(
      "/Users/me/Projects/short",
    );
  });
  it("truncates with head + ... + last 3 segments", () => {
    const long =
      "/Users/me/Projects/sandbox/deeply/nested/folder/structure/some-project-name";
    const out = truncatePath(long);
    // segments[0] is "" because the path is absolute → head collapses to ""
    expect(out.startsWith("/.../")).toBe(true);
    expect(out.endsWith("/structure/some-project-name")).toBe(true);
  });
  it("preserves a non-empty first segment as the head", () => {
    const long =
      "Users/me/Projects/sandbox/deeply/nested/folder/structure/some-project-name";
    const out = truncatePath(long);
    expect(out.startsWith("Users/.../")).toBe(true);
  });
  it("does not truncate when fewer than 4 segments even if long", () => {
    const p = `/${"a".repeat(60)}`;
    expect(truncatePath(p)).toBe(p);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-05-21T12:00:00Z");
  it("returns 'just now' under 30s", () => {
    expect(relativeTime("2026-05-21T11:59:50Z", now)).toBe("just now");
  });
  it("returns N seconds ago when < 60s", () => {
    expect(relativeTime("2026-05-21T11:59:15Z", now)).toBe("45 seconds ago");
  });
  it("returns minutes ago", () => {
    expect(relativeTime("2026-05-21T11:55:00Z", now)).toBe("5 minutes ago");
    expect(relativeTime("2026-05-21T11:59:00Z", now)).toBe("1 minute ago");
  });
  it("returns hours ago", () => {
    expect(relativeTime("2026-05-21T10:00:00Z", now)).toBe("2 hours ago");
    expect(relativeTime("2026-05-21T11:00:00Z", now)).toBe("1 hour ago");
  });
  it("returns days ago", () => {
    expect(relativeTime("2026-05-18T12:00:00Z", now)).toBe("3 days ago");
    expect(relativeTime("2026-05-20T12:00:00Z", now)).toBe("1 day ago");
  });
  it("falls back to input on unparseable ISO", () => {
    expect(relativeTime("not-a-date", now)).toBe("not-a-date");
  });
});
