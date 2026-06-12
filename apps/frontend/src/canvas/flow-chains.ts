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
/**
 * Synthetic bridges between DISCONNECTED components of a container's internal
 * graph, chaining them along the container's Direction (DRW-218 follow-up).
 *
 * Without them elk-layered drops an isolated child into layer 0 NEXT TO the
 * wired component (a second column across the flow) — e.g. C1 holding A1→A2
 * plus a loose A3 renders A3 beside A1 instead of in the same lane. One edge
 * per adjacent pair, sink of the previous component → source of the next, so
 * each component starts in a fresh layer of the same flow lane. Components
 * arrive ranked (main first) — the caller uses rankComponents.
 *
 * Layout-only edges (`__bridge__` prefix), same contract as `__flow__` ones:
 * no shapes, ignored by the arrow-port pass, cycle-safe because they only ever
 * connect distinct components.
 */
export function buildComponentBridgeEdges(
  components: ReadonlyArray<ReadonlyArray<string>>,
  internalEdges: ReadonlyArray<{ from: string; to: string }>,
): ElkExtendedEdge[] {
  if (components.length < 2) return [];
  const hasOut = new Set(internalEdges.map((e) => e.from));
  const hasIn = new Set(internalEdges.map((e) => e.to));
  const out: ElkExtendedEdge[] = [];
  for (let i = 0; i < components.length - 1; i++) {
    const prev = components[i] ?? [];
    const next = components[i + 1] ?? [];
    const tail = prev.find((id) => !hasOut.has(id)) ?? prev[prev.length - 1];
    const head = next.find((id) => !hasIn.has(id)) ?? next[0];
    if (tail == null || head == null) continue;
    out.push({ id: `__bridge__${i}`, sources: [tail], targets: [head] });
  }
  return out;
}

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
