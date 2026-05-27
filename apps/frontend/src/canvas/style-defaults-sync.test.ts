// apps/frontend/src/canvas/style-defaults-sync.test.ts
//
// Unit-тесты для pure helpers из style-defaults-sync.ts.

import { describe, expect, it } from "bun:test";
import { applyPartialToShape } from "./style-defaults-sync";

describe("applyPartialToShape", () => {
  it("returns same shape when partial is empty", () => {
    const shape = { type: "geo", props: { dash: "solid", font: "sans", size: "m" } } as any;
    expect(applyPartialToShape(shape, {})).toBe(shape);
  });

  it("applies font only, leaves dash and size untouched", () => {
    const shape = { type: "geo", props: { dash: "draw", font: "draw", size: "m" } } as any;
    const out = applyPartialToShape(shape, { font: "mono" });
    expect(out.props.dash).toBe("draw");
    expect(out.props.font).toBe("mono");
    expect(out.props.size).toBe("m");
  });

  it("skips font for frame (not in APPLY_FONT)", () => {
    const shape = { type: "frame", props: { name: "Frame" } } as any;
    const out = applyPartialToShape(shape, { font: "mono" });
    expect(out).toBe(shape); // no change, frame not in APPLY_FONT
  });

  it("skips dash for note (not in APPLY_DASH), applies font", () => {
    const shape = { type: "note", props: { font: "draw", size: "m" } } as any;
    const out = applyPartialToShape(shape, { dash: "solid", font: "sans" });
    expect(out.props.font).toBe("sans"); // applied
    expect("dash" in out.props).toBe(false); // not added — note не в APPLY_DASH
  });

  it("returns same shape when partial value equals current", () => {
    const shape = { type: "geo", props: { dash: "solid" } } as any;
    expect(applyPartialToShape(shape, { dash: "solid" })).toBe(shape);
  });
});
