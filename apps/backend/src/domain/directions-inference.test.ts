// apps/backend/src/domain/directions-inference.test.ts
//
// DRW-178 Task 2.6: focused tests for inferContainerDirection — parallel-lanes rule.

import { describe, expect, test } from "bun:test";
import { inferContainerDirection } from "./directions";

describe("inferContainerDirection — parallel lanes", () => {
  test("two children both with external edges going DOWN (parent TB) → LR (lanes)", () => {
    const result = inferContainerDirection({
      container: { id: "S1", meta: {} } as any,
      parentDirection: "TB",
      externalEdgesPerChild: new Map([
        ["A", [{ side: "bottom" }]],
        ["B", [{ side: "bottom" }]],
      ]),
    });
    expect(result).toBe("LR");
  });

  test("two children both with external edges going UP (parent TB) → LR (lanes)", () => {
    const result = inferContainerDirection({
      container: { id: "S2", meta: {} } as any,
      parentDirection: "TB",
      externalEdgesPerChild: new Map([
        ["C", [{ side: "top" }]],
        ["D", [{ side: "top" }]],
      ]),
    });
    expect(result).toBe("LR");
  });

  test("two children with external edges going RIGHT (parent LR) → TB (vertical lanes)", () => {
    const result = inferContainerDirection({
      container: { id: "S", meta: {} } as any,
      parentDirection: "LR",
      externalEdgesPerChild: new Map([
        ["A", [{ side: "right" }]],
        ["B", [{ side: "right" }]],
      ]),
    });
    expect(result).toBe("TB");
  });

  test("mixed sides → inherit parent direction (safe default)", () => {
    // child A has top, child B has bottom — not parallel lanes.
    // High-confidence rule doesn't apply → inherit parent (TB).
    const result = inferContainerDirection({
      container: { id: "S", meta: {} } as any,
      parentDirection: "TB",
      externalEdgesPerChild: new Map([
        ["A", [{ side: "top" }]],
        ["B", [{ side: "bottom" }]],
      ]),
    });
    expect(result).toBe("TB");
  });

  test("mixed sides with parent LR → inherit LR (not TB default)", () => {
    const result = inferContainerDirection({
      container: { id: "S", meta: {} } as any,
      parentDirection: "LR",
      externalEdgesPerChild: new Map([
        ["A", [{ side: "left" }]],
        ["B", [{ side: "right" }]],
      ]),
    });
    expect(result).toBe("LR");
  });

  test("single child with external edges → inherit parent (no parallel lanes match)", () => {
    const result = inferContainerDirection({
      container: { id: "S", meta: {} } as any,
      parentDirection: "TB",
      externalEdgesPerChild: new Map([
        ["A", [{ side: "top" }]],
      ]),
    });
    expect(result).toBe("TB");
  });

  test("explicit meta.didrawDirection respected", () => {
    const result = inferContainerDirection({
      container: { id: "S", meta: { didrawDirection: "RL" } } as any,
      parentDirection: "TB",
      externalEdgesPerChild: new Map([
        ["A", [{ side: "bottom" }]],
        ["B", [{ side: "bottom" }]],
      ]),
    });
    expect(result).toBe("RL");
  });

  test("no external edges → returns parent default fallback (TB)", () => {
    const result = inferContainerDirection({
      container: { id: "S", meta: {} } as any,
      parentDirection: "TB",
      externalEdgesPerChild: new Map(),
    });
    expect(result).toBe("TB");
  });

  test("child has edges to MULTIPLE sides → inherit parent (no parallel lanes match)", () => {
    // child A has top+bottom → not parallel lanes; inherit parent direction.
    const result = inferContainerDirection({
      container: { id: "S", meta: {} } as any,
      parentDirection: "TB",
      externalEdgesPerChild: new Map([
        ["A", [{ side: "top" }, { side: "bottom" }]],
        ["B", [{ side: "bottom" }]],
      ]),
    });
    expect(result).toBe("TB");
  });
});
