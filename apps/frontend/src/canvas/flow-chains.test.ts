import { describe, expect, it } from "bun:test";
import { buildComponentBridgeEdges, buildFlowChainEdges } from "./flow-chains";

describe("buildFlowChainEdges", () => {
  it("chains consecutive children of an edge-less container", () => {
    const edges = buildFlowChainEdges({ cont: ["a", "b", "c"] }, new Set());
    expect(edges).toEqual([
      { id: "__flow__cont__0", sources: ["a"], targets: ["b"] },
      { id: "__flow__cont__1", sources: ["b"], targets: ["c"] },
    ]);
  });

  it("skips containers that already have a real internal edge", () => {
    const edges = buildFlowChainEdges(
      { cont: ["a", "b", "c"] },
      new Set(["cont"]),
    );
    expect(edges).toEqual([]);
  });

  it("skips single-child containers (nothing to line up)", () => {
    expect(buildFlowChainEdges({ cont: ["only"] }, new Set())).toEqual([]);
  });

  it("skips empty containers", () => {
    expect(buildFlowChainEdges({ cont: [] }, new Set())).toEqual([]);
  });

  it("handles multiple containers independently", () => {
    const edges = buildFlowChainEdges(
      { wired: ["a", "b"], loose: ["x", "y"] },
      new Set(["wired"]),
    );
    expect(edges).toEqual([
      { id: "__flow__loose__0", sources: ["x"], targets: ["y"] },
    ]);
  });

  it("produces n-1 edges for n children", () => {
    const edges = buildFlowChainEdges(
      { c: ["1", "2", "3", "4", "5"] },
      new Set(),
    );
    expect(edges).toHaveLength(4);
    expect(edges.map((e) => e.id)).toEqual([
      "__flow__c__0",
      "__flow__c__1",
      "__flow__c__2",
      "__flow__c__3",
    ]);
  });
});

describe("buildComponentBridgeEdges", () => {
  it("bridges an isolated child onto the wired component (C1: A1→A2 + A3)", () => {
    const edges = buildComponentBridgeEdges(
      [["a1", "a2"], ["a3"]],
      [{ from: "a1", to: "a2" }],
    );
    // tail = sink of the wired component, head = the isolated node
    expect(edges).toEqual([
      { id: "__bridge__0", sources: ["a2"], targets: ["a3"] },
    ]);
  });

  it("bridges two wired chains sink→source", () => {
    const edges = buildComponentBridgeEdges(
      [
        ["a", "b"],
        ["c", "d"],
      ],
      [
        { from: "a", to: "b" },
        { from: "c", to: "d" },
      ],
    );
    expect(edges).toEqual([
      { id: "__bridge__0", sources: ["b"], targets: ["c"] },
    ]);
  });

  it("chains three components with n-1 bridges", () => {
    const edges = buildComponentBridgeEdges(
      [["a", "b"], ["c"], ["d"]],
      [{ from: "a", to: "b" }],
    );
    expect(edges).toEqual([
      { id: "__bridge__0", sources: ["b"], targets: ["c"] },
      { id: "__bridge__1", sources: ["c"], targets: ["d"] },
    ]);
  });

  it("falls back to the last/first id when a component is a cycle", () => {
    const edges = buildComponentBridgeEdges(
      [["a", "b"], ["c"]],
      [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    );
    // no sink in the cycle → last id of the component
    expect(edges).toEqual([
      { id: "__bridge__0", sources: ["b"], targets: ["c"] },
    ]);
  });

  it("returns nothing for a single component", () => {
    expect(
      buildComponentBridgeEdges([["a", "b"]], [{ from: "a", to: "b" }]),
    ).toEqual([]);
  });

  it("returns nothing for an empty component list", () => {
    expect(buildComponentBridgeEdges([], [])).toEqual([]);
  });
});
