import { describe, expect, test } from "bun:test";
import { determineContainerDirection } from "./directions";

describe("determineContainerDirection (4-way)", () => {
  test("respects explicit meta.didrawDirection — TB", () => {
    expect(
      determineContainerDirection({
        container: { id: "c1", meta: { didrawDirection: "TB" } } as any,
        edgesIn: [],
        edgesOut: [],
      })
    ).toBe("TB");
  });

  test("respects explicit meta.didrawDirection — RL", () => {
    expect(
      determineContainerDirection({
        container: { id: "c1", meta: { didrawDirection: "RL" } } as any,
        edgesIn: [],
        edgesOut: [],
      })
    ).toBe("RL");
  });

  test("respects explicit BT and LR overrides", () => {
    expect(
      determineContainerDirection({
        container: { id: "c", meta: { didrawDirection: "BT" } } as any,
        edgesIn: [],
        edgesOut: [],
      })
    ).toBe("BT");
    expect(
      determineContainerDirection({
        container: { id: "c", meta: { didrawDirection: "LR" } } as any,
        edgesIn: [],
        edgesOut: [],
      })
    ).toBe("LR");
  });

  test("default TB when no edges and no explicit", () => {
    expect(
      determineContainerDirection({
        container: { id: "c1", meta: {} } as any,
        edgesIn: [],
        edgesOut: [],
      })
    ).toBe("TB");
  });

  test("majority on right → RL (matches DRW-173 Оркестрация case)", () => {
    expect(
      determineContainerDirection({
        container: { id: "c1", meta: {} } as any,
        edgesIn: [{ side: "right" }, { side: "right" }],
        edgesOut: [{ side: "left" }],
      })
    ).toBe("RL");
  });

  test("majority on left → LR", () => {
    expect(
      determineContainerDirection({
        container: { id: "c1", meta: {} } as any,
        edgesIn: [{ side: "left" }, { side: "left" }],
        edgesOut: [{ side: "right" }],
      })
    ).toBe("LR");
  });

  test("majority on top → TB", () => {
    expect(
      determineContainerDirection({
        container: { id: "c1", meta: {} } as any,
        edgesIn: [{ side: "top" }, { side: "top" }],
        edgesOut: [],
      })
    ).toBe("TB");
  });

  test("majority on bottom → BT", () => {
    expect(
      determineContainerDirection({
        container: { id: "c1", meta: {} } as any,
        edgesIn: [{ side: "bottom" }, { side: "bottom" }],
        edgesOut: [{ side: "top" }],
      })
    ).toBe("BT");
  });

  test("tie between top and left → TB (priority)", () => {
    expect(
      determineContainerDirection({
        container: { id: "c1", meta: {} } as any,
        edgesIn: [{ side: "top" }, { side: "left" }],
        edgesOut: [],
      })
    ).toBe("TB");
  });

  test("tie between bottom and right → BT (priority: TB>LR>BT>RL means BT beats RL)", () => {
    expect(
      determineContainerDirection({
        container: { id: "c1", meta: {} } as any,
        edgesIn: [{ side: "bottom" }, { side: "right" }],
        edgesOut: [],
      })
    ).toBe("BT");
  });
});

describe("determineContainerDirection — params control", () => {
  test("autoDirectionEnabled=false → returns params.defaultDirection regardless of edges", () => {
    const result = determineContainerDirection({
      container: { id: "c", meta: {} } as any,
      edgesIn: [{ side: "right" }, { side: "right" }],
      edgesOut: [],
    }, { defaultDirection: "TB", autoDirectionEnabled: false });
    expect(result).toBe("TB");
  });

  test("autoDirectionEnabled=true (default) → infers from edges (existing behavior)", () => {
    const result = determineContainerDirection({
      container: { id: "c", meta: {} } as any,
      edgesIn: [{ side: "right" }, { side: "right" }],
      edgesOut: [],
    }, { defaultDirection: "TB", autoDirectionEnabled: true });
    expect(result).toBe("RL");
  });
});
