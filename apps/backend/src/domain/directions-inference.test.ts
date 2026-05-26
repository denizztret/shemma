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

  test("mixed sides → fallback to count-based heuristic", () => {
    // child A has top, child B has bottom — not parallel lanes; fall back
    // aggregate: top=1, bottom=1 — tie, default TB (TIE_PRIORITY prefers TB)
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

  test("single child with external edges → fallback", () => {
    // aggregate top=1 → TB
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

  test("child has edges to MULTIPLE sides → not parallel lanes; fallback", () => {
    // child A has top+bottom, child B has bottom.
    // A has 2 sides → not parallel lanes; aggregate: top=1, bottom=2 → BT
    const result = inferContainerDirection({
      container: { id: "S", meta: {} } as any,
      parentDirection: "TB",
      externalEdgesPerChild: new Map([
        ["A", [{ side: "top" }, { side: "bottom" }]],
        ["B", [{ side: "bottom" }]],
      ]),
    });
    expect(result).toBe("BT");
  });
});
