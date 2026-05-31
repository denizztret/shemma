import { describe, expect, it } from "bun:test";
import type { TLShape } from "tldraw";
import {
  isFlipEligible,
  resolveContainerDir,
  segmentIntersectsRect,
} from "./elk-layout";

// Minimal shape-like factory: isFlipEligible only reads props.direction and the
// meta direction/inherited markers.
const container = (
  props: { direction?: string },
  meta: { didrawDirection?: string; didrawDirectionInherited?: boolean } = {},
): TLShape =>
  ({ type: "schema-container", props, meta }) as unknown as TLShape;

describe("isFlipEligible", () => {
  it("inherit placeholder (marker set) IS flippable — engine optimises sense", () => {
    expect(
      isFlipEligible(
        container({ direction: "TB" }, { didrawDirectionInherited: true }),
        false,
      ),
    ).toBe(true);
  });

  it('"custom" (auto/inherit) IS flippable', () => {
    expect(isFlipEligible(container({ direction: "custom" }), false)).toBe(true);
  });

  it("explicit cardinal direction is NOT flippable — user sense honoured", () => {
    expect(isFlipEligible(container({ direction: "LR" }), false)).toBe(false);
    expect(isFlipEligible(container({ direction: "RL" }), false)).toBe(false);
    expect(isFlipEligible(container({ direction: "TB" }), false)).toBe(false);
    expect(isFlipEligible(container({ direction: "BT" }), false)).toBe(false);
  });

  it("inherited marker wins over a structural props.direction default", () => {
    expect(
      isFlipEligible(
        container({ direction: "LR" }, { didrawDirectionInherited: true }),
        false,
      ),
    ).toBe(true);
  });

  it("explicit direction via meta fallback (no props) is NOT flippable", () => {
    expect(isFlipEligible(container({}, { didrawDirection: "LR" }), false)).toBe(
      false,
    );
  });

  it("forceDirections (⌘⌥⇧L clean-slate) re-enables flipping for explicit too", () => {
    expect(isFlipEligible(container({ direction: "LR" }), true)).toBe(true);
  });
});

describe("segmentIntersectsRect", () => {
  const rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it("detects a segment passing through the box", () => {
    expect(
      segmentIntersectsRect({ x: -50, y: 50 }, { x: 150, y: 50 }, rect, 0),
    ).toBe(true);
  });

  it("detects a segment ending inside the box", () => {
    expect(
      segmentIntersectsRect({ x: -50, y: 50 }, { x: 50, y: 50 }, rect, 0),
    ).toBe(true);
  });

  it("misses a segment clearly outside", () => {
    expect(
      segmentIntersectsRect({ x: -50, y: 200 }, { x: 150, y: 200 }, rect, 0),
    ).toBe(false);
  });

  it("negative pad ignores a segment that only grazes the edge", () => {
    // runs exactly along the top edge (y=0); a -3 inset shrinks the box so the
    // grazing line no longer counts as biting in.
    expect(
      segmentIntersectsRect({ x: -50, y: 0 }, { x: 150, y: 0 }, rect, -3),
    ).toBe(false);
    // 2px inside the edge still counts as a real clip under the same inset.
    expect(
      segmentIntersectsRect({ x: -50, y: 5 }, { x: 150, y: 5 }, rect, -3),
    ).toBe(true);
  });

  it("positive pad flags a near-touch just outside the box", () => {
    expect(
      segmentIntersectsRect({ x: -50, y: -4 }, { x: 150, y: -4 }, rect, 6),
    ).toBe(true);
  });
});

describe("resolveContainerDir (inheritMode)", () => {
  const inherit = container({ direction: "custom" }, { didrawDirectionInherited: true });
  const explicit = container({ direction: "RL" });
  const kids = new Set(["a", "b"]);
  const flowEdges = [{ from: "a", to: "b" }]; // internal flow between own kids
  const noEdges: Array<{ from: string; to: string }> = [];

  it('"perp" forces an inherit container perpendicular to the frame', () => {
    expect(resolveContainerDir(inherit, kids, "LR", flowEdges, false, "perp")).toBe("TB");
    expect(resolveContainerDir(inherit, kids, "TB", flowEdges, false, "perp")).toBe("LR");
  });

  it('"auto" uses the internal-flow rule (flow→along, bundle→perp)', () => {
    expect(resolveContainerDir(inherit, kids, "LR", flowEdges, false, "auto")).toBe("LR");
    expect(resolveContainerDir(inherit, kids, "LR", noEdges, false, "auto")).toBe("TB");
  });

  it("explicit direction wins over every inheritMode (unless forceDirections)", () => {
    expect(resolveContainerDir(explicit, kids, "LR", flowEdges, false, "perp")).toBe("RL");
    // forceDirections re-infers — the explicit "RL" is ignored, mode applies.
    expect(resolveContainerDir(explicit, kids, "LR", flowEdges, true, "perp")).toBe("TB");
  });
});
