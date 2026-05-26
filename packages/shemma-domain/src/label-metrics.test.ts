import { describe, expect, test } from "bun:test";
import { measureLabelHeuristic } from "./label-metrics";

describe("measureLabelHeuristic", () => {
  test("empty label → zero dimensions", () => {
    expect(measureLabelHeuristic("", {})).toEqual({ width: 0, height: 0, lines: 0 });
  });

  test("short label fits in one line", () => {
    const r = measureLabelHeuristic("calls", {});
    expect(r.lines).toBe(1);
    expect(r.width).toBeGreaterThan(0);
    expect(r.width).toBeLessThan(60); // 5 chars × ~8px = ~40px
  });

  test("long label wraps within max width", () => {
    const r = measureLabelHeuristic(
      "A".repeat(60),
      { maxWidth: 200 }
    );
    expect(r.lines).toBeGreaterThan(1);
    expect(r.width).toBeLessThanOrEqual(200);
  });

  test("maxLines caps the wrapping", () => {
    const r = measureLabelHeuristic("A".repeat(200), { maxWidth: 100, maxLines: 3 });
    expect(r.lines).toBe(3);
  });

  test("cyrillic chars use same average width", () => {
    const latin = measureLabelHeuristic("aaaaa", {});
    const cyrillic = measureLabelHeuristic("ккккк", {});
    expect(cyrillic.width).toBe(latin.width);
  });
});
