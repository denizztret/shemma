import { describe, expect, test } from "bun:test";
import { ALL_MODES, isValidLayoutMode, modeToElkOptions, type LayoutMode } from "../src/layout-modes";

describe("LayoutMode", () => {
  test("ALL_MODES contains 5 values", () => {
    expect(ALL_MODES).toEqual(["layered-lr", "layered-tb", "tree", "pack", "force"]);
  });
  test.each<LayoutMode>(["layered-lr", "layered-tb", "tree", "pack", "force"])(
    "isValidLayoutMode accepts %s",
    (m) => { expect(isValidLayoutMode(m)).toBe(true); },
  );
  test("isValidLayoutMode rejects unknown", () => {
    expect(isValidLayoutMode("circular")).toBe(false);
  });
});

describe("modeToElkOptions", () => {
  test("layered-lr → algorithm=layered, direction=RIGHT", () => {
    const o = modeToElkOptions("layered-lr", "normal");
    expect(o["elk.algorithm"]).toBe("layered");
    expect(o["elk.direction"]).toBe("RIGHT");
  });
  test("layered-tb → direction=DOWN", () => {
    expect(modeToElkOptions("layered-tb", "normal")["elk.direction"]).toBe("DOWN");
  });
  test("tree → algorithm=mrtree", () => {
    expect(modeToElkOptions("tree", "normal")["elk.algorithm"]).toBe("mrtree");
  });
  test("pack → algorithm=rectpacking", () => {
    expect(modeToElkOptions("pack", "normal")["elk.algorithm"]).toBe("rectpacking");
  });
  test("force → algorithm=force", () => {
    expect(modeToElkOptions("force", "normal")["elk.algorithm"]).toBe("force");
  });
  test("spacing presets — compact gives smaller node spacing than loose", () => {
    const compact = Number(modeToElkOptions("layered-lr", "compact")["elk.spacing.nodeNode"]);
    const normal = Number(modeToElkOptions("layered-lr", "normal")["elk.spacing.nodeNode"]);
    const loose = Number(modeToElkOptions("layered-lr", "loose")["elk.spacing.nodeNode"]);
    expect(compact).toBeLessThan(normal);
    expect(normal).toBeLessThan(loose);
  });
  test("orthogonal edge routing for layered modes", () => {
    expect(modeToElkOptions("layered-lr", "normal")["elk.edgeRouting"]).toBe("ORTHOGONAL");
    expect(modeToElkOptions("layered-tb", "normal")["elk.edgeRouting"]).toBe("ORTHOGONAL");
  });
});
