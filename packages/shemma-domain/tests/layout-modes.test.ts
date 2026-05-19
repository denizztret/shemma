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

  // DRW-079: layout spacing — `normal` was too tight for 220x80 default shapes,
  // arrow labels overlapped neighbors. Bumped presets + added layered-specific
  // between-layers spacing + edge-label spacing.
  test("layered modes include between-layers spacing", () => {
    const lr = modeToElkOptions("layered-lr", "normal");
    expect(lr["elk.layered.spacing.nodeNodeBetweenLayers"]).toBeDefined();
    expect(Number(lr["elk.layered.spacing.nodeNodeBetweenLayers"])).toBeGreaterThanOrEqual(100);
    expect(lr["elk.layered.spacing.edgeEdgeBetweenLayers"]).toBeDefined();
    expect(lr["elk.layered.spacing.edgeNodeBetweenLayers"]).toBeDefined();
  });
  test("non-layered modes do NOT include layered.* spacing (mrtree/rectpacking/force)", () => {
    for (const mode of ["tree", "pack", "force"] as const) {
      const o = modeToElkOptions(mode, "normal");
      expect(o["elk.layered.spacing.nodeNodeBetweenLayers"]).toBeUndefined();
    }
  });
  test("edge-label spacing scales with preset", () => {
    const compact = Number(modeToElkOptions("layered-lr", "compact")["elk.spacing.edgeLabel"]);
    const normal = Number(modeToElkOptions("layered-lr", "normal")["elk.spacing.edgeLabel"]);
    const loose = Number(modeToElkOptions("layered-lr", "loose")["elk.spacing.edgeLabel"]);
    expect(compact).toBeLessThan(normal);
    expect(normal).toBeLessThan(loose);
  });
  test("nodeNode normal ≥ 50 (was 40 — bumped for 220px default shapes)", () => {
    expect(Number(modeToElkOptions("layered-lr", "normal")["elk.spacing.nodeNode"])).toBeGreaterThanOrEqual(50);
  });
});
