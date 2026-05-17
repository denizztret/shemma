import { describe, expect, test } from "bun:test";
import { humanize } from "./humanize";

describe("humanize", () => {
  const NOW = 1_700_000_000_000; // fixed reference point

  test("seconds ago", () => {
    expect(humanize(NOW - 30_000, NOW)).toBe("30s ago");
  });

  test("0 seconds (now)", () => {
    expect(humanize(NOW, NOW)).toBe("0s ago");
  });

  test("1 minute ago (exactly 60s)", () => {
    expect(humanize(NOW - 60_000, NOW)).toBe("1m ago");
  });

  test("minutes ago", () => {
    expect(humanize(NOW - 5 * 60_000, NOW)).toBe("5m ago");
  });

  test("59 minutes ago", () => {
    expect(humanize(NOW - 59 * 60_000, NOW)).toBe("59m ago");
  });

  test("1 hour ago (exactly 60m)", () => {
    expect(humanize(NOW - 3_600_000, NOW)).toBe("1h ago");
  });

  test("hours ago", () => {
    expect(humanize(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  });

  test("23 hours ago", () => {
    expect(humanize(NOW - 23 * 3_600_000, NOW)).toBe("23h ago");
  });

  test("1 day ago", () => {
    expect(humanize(NOW - 86_400_000, NOW)).toBe("1d ago");
  });

  test("multiple days ago", () => {
    expect(humanize(NOW - 7 * 86_400_000, NOW)).toBe("7d ago");
  });

  test("accepts ISO string", () => {
    const iso = new Date(NOW - 2 * 60_000).toISOString();
    expect(humanize(iso, NOW)).toBe("2m ago");
  });

  test("invalid input returns 'unknown'", () => {
    expect(humanize("not-a-date", NOW)).toBe("unknown");
  });

  test("future timestamp treated as 0s ago (no negative)", () => {
    expect(humanize(NOW + 10_000, NOW)).toBe("0s ago");
  });
});
