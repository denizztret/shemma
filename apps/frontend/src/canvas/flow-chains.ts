import type { ElkExtendedEdge } from "elkjs";

/**
 * Synthetic "flow chain" ordering edges that make a container's UNCONNECTED
 * children line up along its Direction instead of clumping on the cross axis.
 *
 * elk-layered places edge-less siblings in the same layer → they stack
 * perpendicular to the flow (LR → vertical column, TB → horizontal row), which
 * reads as "Direction does nothing" for grouping containers. Linking consecutive
 * children `c[i] → c[i+1]` turns them into a single chain, so layered lays them
 * out along the container's flow direction with the normal layer spacing.
 *
 * Applied only to containers that have ≥2 children and NO real internal arrow
 * among them: a container whose children are already wired has its own structure
 * drive the flow, and injecting a chain there could introduce cycles.
 *
 * The edges are layout-only — the `__flow__` id prefix marks them synthetic,
 * they create no shapes, and the arrow-port pass ignores them (it keys off real
 * arrow bindings, not the elk edge list).
 *
 * This is the per-node building block reused by the future recursive layout:
 * "arrange a node's direct children along its Direction" = elk-layered + this
 * chain for the edge-less case.
 */
export function buildFlowChainEdges(
  containerChildren: Record<string, string[]>,
  containersWithInternalEdge: ReadonlySet<string>,
): ElkExtendedEdge[] {
  const edges: ElkExtendedEdge[] = [];
  for (const [containerId, childIds] of Object.entries(containerChildren)) {
    if (childIds.length < 2 || containersWithInternalEdge.has(containerId)) {
      continue;
    }
    for (let i = 0; i < childIds.length - 1; i++) {
      edges.push({
        id: `__flow__${containerId}__${i}`,
        sources: [childIds[i]!],
        targets: [childIds[i + 1]!],
      });
    }
  }
  return edges;
}
