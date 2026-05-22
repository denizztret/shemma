/**
 * Mermaid generator — inverse of mermaid-parser.ts.
 *
 * Converts SchemaAction[] → canonical mermaid `graph <DIR>` string.
 * Supports the same subset as the storage-mode parser (Task 2.2):
 *   - Nodes with role → shape syntax per mapping table
 *   - Edges with connectionKind → arrow syntax
 *   - schema-group → subgraph blocks (edges between group children emitted inside the block)
 *   - Sorted by nodeId/from+to for deterministic output
 *
 * Round-trip property: parse(generate(actions)) ≈ actions (modulo normalization of nodeIds).
 * NodeIds are not bit-perfectly preserved on round-trip because the parser re-derives them
 * from slug+RNG; structural equality (counts, labels, edge kinds) IS preserved.
 */

import type {
  SchemaAction,
  SchemaDefineAction,
  SchemaConnectAction,
  SchemaGroupAction,
} from "@shemma/domain";
import type { NodeId } from "@shemma/domain";
import type { Role } from "@shemma/domain";
import type { ConnectionKind } from "@shemma/domain";
import type { MermaidDirection } from "./mermaid-parser";

// ---- Role → mermaid shape syntax ----

/**
 * Map a role + label to mermaid node declaration syntax.
 * Label must be sanitized before passing.
 */
function roleToNodeSyntax(nodeId: NodeId, role: Role, label: string): string {
  const safeLabel = sanitizeLabel(label);
  switch (role) {
    case "datastore":
      return `${nodeId}[(${safeLabel})]`;
    case "actor":
      return `${nodeId}((${safeLabel}))`;
    case "external":
      return `${nodeId}>${safeLabel}]`;
    case "service":
    case "queue":
    case "note":
    case "network":
    case "boundary":
    default:
      // Rect as default shape for service and anything without specific mapping
      return `${nodeId}[${safeLabel}]`;
  }
}

/**
 * Sanitize label for embedding in mermaid shape syntax.
 * Replaces problematic delimiter chars to avoid syntax breakage.
 * Round-trip precision on labels containing replaced chars is degraded (known limitation per spec §Out of scope).
 */
function sanitizeLabel(label: string): string {
  return (
    label
      .replace(/\]/g, "⁠]") // word-joiner before ] to prevent premature close of rect/cylinder
      .replace(/\)/g, "⁠)") // prevent close of round/circle/cylinder
      .replace(/\}/g, "⁠}") // prevent close of diamond/hex
  );
}

// ---- ConnectionKind → mermaid edge arrow ----

function connectionKindToArrow(
  kind: ConnectionKind | undefined,
  label?: string,
): string {
  const effectiveKind: ConnectionKind = kind ?? "sync";

  if (label !== undefined && label !== "") {
    // Labeled edges use -->|label| notation (spec AC-12).
    // Non-sync kinds lose their kind in labeled form — mermaid syntax limitation.
    const safeLbl = label.replace(/\|/g, "/"); // pipes inside label would break |label| syntax
    return `-->|${safeLbl}|`;
  }

  switch (effectiveKind) {
    case "dep":
      return "-.->"; // matches parser regex /^-\.->/
    case "data":
      return "==>";
    case "async":
      return "--x";
    case "sync":
    default:
      return "-->";
  }
}

// ---- Generator ----

export type GenerateOptions = {
  actions: SchemaAction[];
  direction: MermaidDirection;
  /**
   * Resolved label per nodeId. Overrides the label from the define action.
   * If a nodeId is absent from this map, the action label is used (or nodeId if no action label).
   */
  labels?: Record<NodeId, string>;
  /**
   * Resolved role per nodeId. Overrides the role from the define action.
   * If a nodeId is absent from this map, the action role is used (or "service" as default).
   */
  roles?: Record<NodeId, Role>;
};

/**
 * Generate a canonical mermaid flowchart string from SchemaAction[].
 *
 * Output structure:
 *   graph <DIR>
 *     <standalone node declarations — sorted by nodeId>
 *     <top-level edges — sorted by from+to>
 *     <subgraph blocks — sorted by group name>
 *       <child node declarations — sorted by nodeId>
 *       <intra-subgraph edges — sorted by from+to>
 *     end
 *
 * Subgraph membership: nodes listed in schema-group.nodeIds are emitted inside
 * the subgraph block. Edges between two nodes of the same subgraph are also emitted
 * inside the block so the parser can detect subgraph children correctly on round-trip.
 * Cross-subgraph edges are emitted at top level.
 *
 * Deterministic: same input → same output bytes.
 */
export function generateMermaid(opts: GenerateOptions): string {
  const { actions, direction, labels = {}, roles = {} } = opts;

  // ---- Collect action groups ----
  const defineActions = actions.filter(
    (a): a is SchemaDefineAction => a.kind === "schema-define",
  );
  const connectActions = actions.filter(
    (a): a is SchemaConnectAction => a.kind === "schema-connect",
  );
  const groupActions = actions.filter(
    (a): a is SchemaGroupAction => a.kind === "schema-group",
  );

  // ---- Build lookup helpers ----

  function resolveLabel(nodeId: NodeId, actionLabel?: string): string {
    if (labels[nodeId] !== undefined) return labels[nodeId] as string;
    if (actionLabel !== undefined && actionLabel !== "") return actionLabel;
    return nodeId; // fallback: use nodeId itself as display label
  }

  function resolveRole(nodeId: NodeId, actionRole?: Role): Role {
    if (roles[nodeId] !== undefined) return roles[nodeId] as Role;
    if (actionRole !== undefined) return actionRole;
    return "service";
  }

  // Build define lookup by nodeId for quick access
  const defineByNodeId = new Map<NodeId, SchemaDefineAction>();
  for (const def of defineActions) {
    if (def.nodeId) defineByNodeId.set(def.nodeId, def);
  }

  // Build subgraph membership: nodeId → group
  const nodeToGroup = new Map<NodeId, SchemaGroupAction>();
  for (const grp of groupActions) {
    for (const nid of grp.nodeIds) {
      nodeToGroup.set(nid, grp);
    }
  }

  // Classify edges: intra-subgraph (both ends in same group) vs cross-subgraph / top-level
  const edgesInSubgraph = new Map<SchemaGroupAction, SchemaConnectAction[]>();
  const topLevelEdges: SchemaConnectAction[] = [];

  for (const grp of groupActions) {
    edgesInSubgraph.set(grp, []);
  }

  for (const edge of connectActions) {
    const fromGrp = nodeToGroup.get(edge.from);
    const toGrp = nodeToGroup.get(edge.to);
    if (fromGrp !== undefined && fromGrp === toGrp) {
      // Both ends are in the same subgraph — emit inside
      edgesInSubgraph.get(fromGrp)!.push(edge);
    } else {
      topLevelEdges.push(edge);
    }
  }

  // ---- Emit header ----
  const lines: string[] = [`graph ${direction}`];

  // ---- Emit standalone node declarations (not inside any subgraph) ----
  const sortedDefines = [...defineActions].sort((a, b) =>
    (a.nodeId ?? "").localeCompare(b.nodeId ?? ""),
  );

  for (const def of sortedDefines) {
    const nodeId = def.nodeId;
    if (!nodeId) continue;
    if (nodeToGroup.has(nodeId)) continue; // Will be emitted inside subgraph block

    const label = resolveLabel(nodeId, def.label);
    const role = resolveRole(nodeId, def.role);
    lines.push(`  ${roleToNodeSyntax(nodeId, role, label)}`);
  }

  // ---- Emit top-level edges (sorted by from then to) ----
  const sortedTopEdges = [...topLevelEdges].sort((a, b) => {
    const fromCmp = a.from.localeCompare(b.from);
    if (fromCmp !== 0) return fromCmp;
    return a.to.localeCompare(b.to);
  });

  for (const edge of sortedTopEdges) {
    const arrow = connectionKindToArrow(edge.connectionKind, edge.label);
    lines.push(`  ${edge.from} ${arrow} ${edge.to}`);
  }

  // ---- Emit subgraph blocks (sorted by group name) ----
  const sortedGroups = [...groupActions].sort((a, b) =>
    (a.name ?? "").localeCompare(b.name ?? ""),
  );

  for (const grp of sortedGroups) {
    const grpLabel = grp.label ?? grp.name ?? "";
    const safeGrpLabel = sanitizeLabel(grpLabel);
    const nameId = grp.name ?? "";

    lines.push(`  subgraph ${nameId} [${safeGrpLabel}]`);

    // Emit child node declarations (sorted by nodeId)
    const childDefines = grp.nodeIds
      .map((nid) => defineByNodeId.get(nid))
      .filter((d): d is SchemaDefineAction => d !== undefined)
      .sort((a, b) => (a.nodeId ?? "").localeCompare(b.nodeId ?? ""));

    for (const def of childDefines) {
      const nodeId = def.nodeId as NodeId;
      const label = resolveLabel(nodeId, def.label);
      const role = resolveRole(nodeId, def.role);
      lines.push(`    ${roleToNodeSyntax(nodeId, role, label)}`);
    }

    // Emit intra-subgraph edges (sorted by from then to)
    const innerEdges = (edgesInSubgraph.get(grp) ?? []).sort((a, b) => {
      const fromCmp = a.from.localeCompare(b.from);
      if (fromCmp !== 0) return fromCmp;
      return a.to.localeCompare(b.to);
    });

    for (const edge of innerEdges) {
      const arrow = connectionKindToArrow(edge.connectionKind, edge.label);
      lines.push(`    ${edge.from} ${arrow} ${edge.to}`);
    }

    lines.push(`  end`);
  }

  return lines.join("\n");
}
