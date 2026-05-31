import { describe, expect, it } from "bun:test";
import { buildFlowChainEdges } from "./flow-chains";

describe("buildFlowChainEdges", () => {
  it("chains consecutive children of an edge-less container", () => {
    const edges = buildFlowChainEdges(
      { cont: ["a", "b", "c"] },
      new Set(),
    );
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
