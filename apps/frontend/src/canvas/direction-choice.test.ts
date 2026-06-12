import { describe, expect, it } from "bun:test";
import {
  type PlanMetrics,
  countBoxOverlaps,
  perpModeWins,
  pickDirectionCandidate,
  planScore,
} from "./direction-choice";

const m = (over: Partial<PlanMetrics>): PlanMetrics => ({
  contentW: 100,
  contentH: 100,
  crossings: 0,
  overlaps: 0,
  ...over,
});

describe("planScore", () => {
  it("balanced plan scores its aspect extremity (1.0)", () => {
    expect(planScore(m({}))).toBe(1);
  });
  it("crossings add 0.15 each, overlaps add 0.5 each", () => {
    expect(planScore(m({ crossings: 2 }))).toBeCloseTo(1.3);
    expect(planScore(m({ overlaps: 1 }))).toBeCloseTo(1.5);
  });
  it("aspect extremity is orientation-agnostic (3:1 == 1:3)", () => {
    expect(planScore(m({ contentW: 300 }))).toBe(
      planScore(m({ contentH: 300 })),
    );
  });
});

describe("countBoxOverlaps", () => {
  it("counts intersecting pairs, ignores touching boxes", () => {
    const boxes = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 50, y: 50, w: 100, h: 100 }, // overlaps #0
      { x: 100, y: 0, w: 50, h: 50 }, // touches #0 → no overlap
    ];
    expect(countBoxOverlaps(boxes)).toBe(1);
  });

  it("no boxes → zero overlaps", () => {
    expect(countBoxOverlaps([])).toBe(0);
  });
});

describe("pickDirectionCandidate", () => {
  it("keeps the incumbent on equal score (no drift)", () => {
    const winner = pickDirectionCandidate({ value: "TB", metrics: m({}) }, [
      { value: "LR", metrics: m({}) },
    ]);
    expect(winner).toBe("TB");
  });
  it("switches only on STRICT improvement", () => {
    const winner = pickDirectionCandidate(
      { value: "TB", metrics: m({ contentW: 300 }) },
      [{ value: "LR", metrics: m({}) }],
    );
    expect(winner).toBe("LR");
  });
  it("a candidate colliding with pins loses despite better aspect", () => {
    const winner = pickDirectionCandidate(
      { value: "TB", metrics: m({ contentW: 220 }) }, // ratio 2.2
      [{ value: "LR", metrics: m({ overlaps: 4 }) }], // 1 + 2.0 = 3.0
    );
    expect(winner).toBe("TB");
  });

  it("no candidates → the incumbent wins by default", () => {
    expect(pickDirectionCandidate({ value: "TB", metrics: m({}) }, [])).toBe(
      "TB",
    );
  });
});

describe("perpModeWins (DRW-235, inheritMode при фиксированном направлении)", () => {
  const m = (
    contentW: number,
    contentH: number,
    crossings = 0,
    overlaps = 0,
  ) => ({ contentW, contentH, crossings, overlaps });

  it("perp побеждает: строго компактнее и не хуже по рёбрам (кейс CI-схемы)", () => {
    expect(perpModeWins(m(4402, 1650, 3), m(3698, 1150, 3))).toBe(true);
  });

  it("идентичные планы — действующий auto остаётся", () => {
    expect(perpModeWins(m(2000, 1000, 2), m(2000, 1000, 2))).toBe(false);
  });

  it("компактнее, но меньше 10% маржи — auto остаётся (анти-дрейф)", () => {
    expect(perpModeWins(m(2000, 1000), m(1950, 1000))).toBe(false);
  });

  it("компактнее, но больше пересечений — auto остаётся", () => {
    expect(perpModeWins(m(2000, 1000, 1), m(1000, 1000, 2))).toBe(false);
  });

  it("компактнее, но появились наезды на пины — auto остаётся", () => {
    expect(perpModeWins(m(2000, 1000, 0, 0), m(1000, 1000, 0, 1))).toBe(false);
  });
});
