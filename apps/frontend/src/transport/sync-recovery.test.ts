/**
 * DRW-137 — sync-recovery pure helper tests.
 */
import { describe, expect, test } from "bun:test";
import { TRUNCATED_BACKOFF_MAX_MS, computeTruncatedBackoff } from "./sync-recovery";

describe("computeTruncatedBackoff", () => {
  test("retry 0 → 0 (no wait on first attempt)", () => {
    expect(computeTruncatedBackoff(0)).toBe(0);
  });

  test("retry < 0 → 0 (defensive)", () => {
    expect(computeTruncatedBackoff(-1)).toBe(0);
    expect(computeTruncatedBackoff(-100)).toBe(0);
  });

  test("retry 1 → 1000ms", () => {
    expect(computeTruncatedBackoff(1)).toBe(1_000);
  });

  test("retry 2 → 2000ms", () => {
    expect(computeTruncatedBackoff(2)).toBe(2_000);
  });

  test("retry 3 → 4000ms", () => {
    expect(computeTruncatedBackoff(3)).toBe(4_000);
  });

  test("retry 4 → 8000ms", () => {
    expect(computeTruncatedBackoff(4)).toBe(8_000);
  });

  test("retry 5 → 16000ms", () => {
    expect(computeTruncatedBackoff(5)).toBe(16_000);
  });

  test("retry 6 → 30000ms (capped)", () => {
    expect(computeTruncatedBackoff(6)).toBe(TRUNCATED_BACKOFF_MAX_MS);
  });

  test("retry 10 → 30000ms (still capped)", () => {
    expect(computeTruncatedBackoff(10)).toBe(TRUNCATED_BACKOFF_MAX_MS);
  });

  test("retry 100 → 30000ms (still capped — no overflow)", () => {
    expect(computeTruncatedBackoff(100)).toBe(TRUNCATED_BACKOFF_MAX_MS);
  });

  test("strictly non-decreasing for retry ≥ 0", () => {
    let prev = computeTruncatedBackoff(0);
    for (let r = 1; r <= 20; r++) {
      const cur = computeTruncatedBackoff(r);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});
