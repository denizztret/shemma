/**
 * Schema diff — compute structural difference between two SchemaAction[] snapshots.
 *
 * DRW-134 Task 2.4 (1/2).
 *
 * `diffSchemas(oldActions, newActions)` → `DiffResult` — pure function, no I/O.
 *
 * Nodes are matched by `nodeId` (stable identity across rename/role-change).
 * Edges are matched by `(from, to)` pair (direction-aware).
 * Groups are matched by `name` (group NodeId).
 *
 * `DiffResult` is consumed by `applySchemaActions` in apply.ts to construct
 * the `StoreChangeBatch` for tldraw store mutations.
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

// ---- Diff result types ----

export type NodeSnapshot = {
  nodeId: NodeId;
  role: Role;
  label: string;
};

export type EdgeSnapshot = {
  from: NodeId;
  to: NodeId;
  connectionKind?: ConnectionKind;
  label?: string;
};

export type DiffResult = {
  /** Nodes present in newActions but absent in oldActions (by nodeId). */
  added: NodeSnapshot[];
  /** NodeIds present in oldActions but absent in newActions. */
  removed: NodeId[];
  /** Nodes with same nodeId but different label. */
  renamed: Array<{ nodeId: NodeId; oldLabel: string; newLabel: string }>;
  /** Nodes with same nodeId but different role. */
  roleChanged: Array<{ nodeId: NodeId; oldRole: Role; newRole: Role }>;
  /** Edges present in newActions but absent in oldActions (matched by from+to). */
  edgesAdded: EdgeSnapshot[];
  /** Edges present in oldActions but absent in newActions. */
  edgesRemoved: Array<{ from: NodeId; to: NodeId }>;
};

// ---- Helper: extract node snapshots from actions ----

function extractNodes(actions: SchemaAction[]): Map<NodeId, NodeSnapshot> {
  const nodes = new Map<NodeId, NodeSnapshot>();
  for (const a of actions) {
    if (a.kind === "schema-define" && a.nodeId) {
      // Label: action.label if present, else nodeId as fallback display.
      const label = a.label !== undefined && a.label !== "" ? a.label : a.nodeId;
      nodes.set(a.nodeId, { nodeId: a.nodeId, role: a.role, label });
    }
  }
  // Apply rename actions on top of defines (later actions override earlier).
  for (const a of actions) {
    if (a.kind === "schema-rename") {
      const existing = nodes.get(a.nodeId);
      if (existing) {
        nodes.set(a.nodeId, { ...existing, label: a.label });
      }
    }
  }
  // Apply set-role actions.
  for (const a of actions) {
    if (a.kind === "schema-set-role") {
      const existing = nodes.get(a.nodeId);
      if (existing) {
        nodes.set(a.nodeId, { ...existing, role: a.role });
      }
    }
  }
  return nodes;
}

// ---- Helper: extract edge snapshots from actions ----

/** Edge key for deduplication: "from→to". */
function edgeKey(from: NodeId, to: NodeId): string {
  return `${from}→${to}`;
}

function extractEdges(actions: SchemaAction[]): Map<string, EdgeSnapshot> {
  const edges = new Map<string, EdgeSnapshot>();
  for (const a of actions) {
    if (a.kind === "schema-connect") {
      const key = edgeKey(a.from, a.to);
      edges.set(key, {
        from: a.from,
        to: a.to,
        connectionKind: a.connectionKind,
        label: a.label,
      });
    }
  }
  // Apply disconnect actions (remove edges).
  for (const a of actions) {
    if (a.kind === "schema-disconnect") {
      edges.delete(edgeKey(a.from, a.to));
    }
  }
  // Apply delete-node actions (remove all edges connected to deleted node).
  for (const a of actions) {
    if (a.kind === "schema-delete-node") {
      for (const [key, edge] of edges) {
        if (edge.from === a.nodeId || edge.to === a.nodeId) {
          edges.delete(key);
        }
      }
    }
  }
  return edges;
}

// ---- Main diff function ----

/**
 * Compute structural diff between two SchemaAction[] snapshots.
 * Pure function — no I/O, no side-effects.
 *
 * @param oldActions — current schema state as action list
 * @param newActions — desired schema state as action list
 * @returns DiffResult describing additions, removals, and mutations
 */
export function diffSchemas(
  oldActions: SchemaAction[],
  newActions: SchemaAction[],
): DiffResult {
  const oldNodes = extractNodes(oldActions);
  const newNodes = extractNodes(newActions);
  const oldEdges = extractEdges(oldActions);
  const newEdges = extractEdges(newActions);

  // ---- Node diff ----
  const added: NodeSnapshot[] = [];
  const removed: NodeId[] = [];
  const renamed: DiffResult["renamed"] = [];
  const roleChanged: DiffResult["roleChanged"] = [];

  // Added: present in new, absent in old.
  for (const [nodeId, newNode] of newNodes) {
    if (!oldNodes.has(nodeId)) {
      added.push(newNode);
    }
  }

  // Removed: present in old, absent in new.
  for (const [nodeId] of oldNodes) {
    if (!newNodes.has(nodeId)) {
      removed.push(nodeId);
    }
  }

  // Renamed + roleChanged: present in both, check differences.
  for (const [nodeId, oldNode] of oldNodes) {
    const newNode = newNodes.get(nodeId);
    if (!newNode) continue; // already in removed

    if (oldNode.label !== newNode.label) {
      renamed.push({
        nodeId,
        oldLabel: oldNode.label,
        newLabel: newNode.label,
      });
    }

    if (oldNode.role !== newNode.role) {
      roleChanged.push({
        nodeId,
        oldRole: oldNode.role,
        newRole: newNode.role,
      });
    }
  }

  // ---- Edge diff ----
  const edgesAdded: EdgeSnapshot[] = [];
  const edgesRemoved: DiffResult["edgesRemoved"] = [];

  // Added edges: present in new, absent in old.
  for (const [key, newEdge] of newEdges) {
    if (!oldEdges.has(key)) {
      edgesAdded.push(newEdge);
    }
  }

  // Removed edges: present in old, absent in new.
  for (const [key, oldEdge] of oldEdges) {
    if (!newEdges.has(key)) {
      edgesRemoved.push({ from: oldEdge.from, to: oldEdge.to });
    }
  }

  return { added, removed, renamed, roleChanged, edgesAdded, edgesRemoved };
}
