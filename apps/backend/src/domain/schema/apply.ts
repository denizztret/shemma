/**
 * Schema apply engine — DRW-134 Task 2.4 (2/2).
 *
 * `applySchemaActions(opts)` — атомарно применяет SchemaAction[] к существующему
 * schema-frame. Pure function (no I/O, no daemon calls). Caller (route handler)
 * несёт ответственность за persist'инг результата в room.store.
 *
 * Rollback discipline (spec §Write semantics §Rollback order):
 *   1. oldRaw + oldOverlays держатся до return.
 *   2. Валидация всех actions ПЕРЕД любыми мутациями (all-or-nothing).
 *   3. Parse новый RAW → AST до commit. Parse failure → return error, store не тронут.
 *   4. Diff строится в памяти (StoreChangeBatch).
 *   5. Batch + новый RAW/overlays возвращаются caller'у — он делает commit.
 *
 * Atomicity: если хоть один action не прошёл валидацию → `{ ok: false, errors[] }`.
 * Collect ALL errors, не bail на первой.
 */

import { randomBytes } from "node:crypto";
import {
  isValidRole,
  isValidConnectionKind,
  rolePreset,
  connectionPreset,
  slugify,
} from "@shemma/domain";
import type {
  SchemaAction,
  SchemaDefineAction,
  SchemaConnectAction,
  SchemaGroupAction,
  NodeId,
  OverlayEntry,
  SchemaActionError,
  Role,
  ConnectionKind,
} from "@shemma/domain";
import type { TLRecord, StoreChangeBatch } from "../../store-types";
import type { RoomState } from "../../types";
import { parseMermaidFlowchart } from "./mermaid-parser";
import type { ParseResult, MermaidDirection } from "./mermaid-parser";
import { generateMermaid } from "./mermaid-generator";
import { diffSchemas } from "./diff";
import { generateNodeIdServer } from "./identity";

// ---- Rich text helper (mirrors compile.ts) ----

function richText(label: string): unknown {
  return label
    ? {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: label }] },
        ],
      }
    : { type: "doc", content: [{ type: "paragraph" }] };
}

// ---- Random id helpers ----

function rand(): string {
  return randomBytes(5).toString("hex");
}

function shapeId(): string {
  return `shape:${rand()}`;
}

function bindingId(): string {
  return `binding:${rand()}`;
}

// ---- Arrow shape constructors (mirrored from compile.ts) ----

function makeArrowShape(opts: {
  id: string;
  dash: "draw" | "dashed";
  label: string;
  meta: Record<string, unknown>;
  parentId: string;
}): TLRecord {
  return {
    id: opts.id,
    typeName: "shape",
    type: "arrow",
    x: 0,
    y: 0,
    parentId: opts.parentId,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      kind: "arc",
      color: "black",
      labelColor: "black",
      fill: "none",
      dash: opts.dash,
      size: "m",
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
      font: "draw",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      bend: 0,
      elbowMidPoint: 0.5,
      labelPosition: 0.5,
      scale: 1,
      richText: richText(opts.label),
    },
    meta: opts.meta,
  } as TLRecord;
}

function makeArrowBindings(
  arrowId: string,
  fromShapeId: string,
  toShapeId: string,
): { start: TLRecord; end: TLRecord } {
  const mk = (terminal: "start" | "end", toId: string): TLRecord =>
    ({
      id: bindingId(),
      typeName: "binding",
      type: "arrow",
      fromId: arrowId,
      toId,
      props: {
        terminal,
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: "none",
      },
      meta: {},
    }) as TLRecord;
  return { start: mk("start", fromShapeId), end: mk("end", toShapeId) };
}

// ---- Geo shape constructor ----

function makeGeoShape(opts: {
  nodeId: NodeId;
  label: string;
  role: import("@shemma/domain").Role;
  parentId: string;
  overlayEntry?: OverlayEntry;
}): TLRecord {
  const preset = rolePreset(opts.role);
  const x = opts.overlayEntry?.position?.x ?? 0;
  const y = opts.overlayEntry?.position?.y ?? 0;
  const color = opts.overlayEntry?.color ?? preset.style.color ?? "black";
  const displayLabel = opts.overlayEntry?.label ?? opts.label;

  return {
    id: shapeId(),
    typeName: "shape",
    type: "geo",
    x,
    y,
    parentId: opts.parentId,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      w: preset.defaultW ?? 220,
      h: preset.defaultH ?? 80,
      geo: "rectangle",
      color,
      labelColor: "black",
      fill: preset.style.fill ?? "none",
      dash: "draw",
      size: "m",
      font: "draw",
      align: "middle",
      verticalAlign: "middle",
      growY: 0,
      url: "",
      scale: 1,
      richText: richText(displayLabel),
    },
    meta: {
      didrawId: opts.nodeId,
      didrawName: opts.nodeId,
      didrawLabel: opts.label,
      didrawSchemaParent: opts.parentId,
    },
  } as TLRecord;
}

// ---- State model for in-memory apply ----

type NodeInfo = {
  nodeId: NodeId;
  role: import("@shemma/domain").Role;
  label: string;
};

type EdgeInfo = {
  from: NodeId;
  to: NodeId;
  connectionKind?: import("@shemma/domain").ConnectionKind;
  label?: string;
};

function edgeKey(from: NodeId, to: NodeId): string {
  return `${from}→${to}`;
}

/** Extract node set and edge set from parsed actions */
function extractState(actions: SchemaAction[]): {
  nodes: Map<NodeId, NodeInfo>;
  edges: Map<string, EdgeInfo>;
} {
  const nodes = new Map<NodeId, NodeInfo>();
  const edges = new Map<string, EdgeInfo>();

  for (const a of actions) {
    if (a.kind === "schema-define" && a.nodeId) {
      const label = a.label !== undefined && a.label !== "" ? a.label : a.nodeId;
      nodes.set(a.nodeId, { nodeId: a.nodeId, role: a.role, label });
    }
    if (a.kind === "schema-connect") {
      edges.set(edgeKey(a.from, a.to), {
        from: a.from,
        to: a.to,
        connectionKind: a.connectionKind,
        label: a.label,
      });
    }
  }

  return { nodes, edges };
}

// ---- Validation ----

type ValidationContext = {
  currentNodes: Map<NodeId, NodeInfo>;
  currentEdges: Map<string, EdgeInfo>;
  /** Nodes being added in this batch (for duplicate detection) */
  pendingAdds: Set<NodeId>;
};


function validateAction(
  action: SchemaAction,
  idx: number,
  ctx: ValidationContext,
): SchemaActionError | null {
  switch (action.kind) {
    case "schema-define": {
      const nodeId = action.nodeId;
      if (nodeId !== undefined) {
        // Validate nodeId format via regex (basic check: lowercase alphanumeric + dash).
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{3,12}$|^e-[0-9a-z]{3,12}$/.test(nodeId)) {
          return {
            actionIndex: idx,
            code: "invalid-id",
            message: `Invalid nodeId format: "${nodeId}"`,
          };
        }
        // Duplicate detection: already exists OR being added in same batch.
        if (ctx.currentNodes.has(nodeId) || ctx.pendingAdds.has(nodeId)) {
          return {
            actionIndex: idx,
            code: "duplicate-node",
            message: `Node "${nodeId}" already exists in schema`,
          };
        }
      }
      if (!isValidRole(action.role)) {
        return {
          actionIndex: idx,
          code: "invalid-role",
          message: `Invalid role: "${action.role}"`,
        };
      }
      // Register as pending add.
      if (nodeId !== undefined) {
        ctx.pendingAdds.add(nodeId);
      }
      return null;
    }

    case "schema-connect": {
      if (!ctx.currentNodes.has(action.from) && !ctx.pendingAdds.has(action.from)) {
        return {
          actionIndex: idx,
          code: "unknown-node",
          message: `Unknown node referenced in "from": "${action.from}"`,
        };
      }
      if (!ctx.currentNodes.has(action.to) && !ctx.pendingAdds.has(action.to)) {
        return {
          actionIndex: idx,
          code: "unknown-node",
          message: `Unknown node referenced in "to": "${action.to}"`,
        };
      }
      if (
        action.connectionKind !== undefined &&
        !isValidConnectionKind(action.connectionKind)
      ) {
        return {
          actionIndex: idx,
          code: "invalid-connection-kind",
          message: `Invalid connectionKind: "${action.connectionKind}"`,
        };
      }
      return null;
    }

    case "schema-rename": {
      if (
        !ctx.currentNodes.has(action.nodeId) &&
        !ctx.pendingAdds.has(action.nodeId)
      ) {
        return {
          actionIndex: idx,
          code: "unknown-node",
          message: `Unknown node "${action.nodeId}" in schema-rename`,
        };
      }
      return null;
    }

    case "schema-set-role": {
      if (
        !ctx.currentNodes.has(action.nodeId) &&
        !ctx.pendingAdds.has(action.nodeId)
      ) {
        return {
          actionIndex: idx,
          code: "unknown-node",
          message: `Unknown node "${action.nodeId}" in schema-set-role`,
        };
      }
      if (!isValidRole(action.role)) {
        return {
          actionIndex: idx,
          code: "invalid-role",
          message: `Invalid role: "${action.role}"`,
        };
      }
      return null;
    }

    case "schema-group": {
      for (const nid of action.nodeIds) {
        if (!ctx.currentNodes.has(nid) && !ctx.pendingAdds.has(nid)) {
          return {
            actionIndex: idx,
            code: "unknown-node",
            message: `Unknown node "${nid}" in schema-group.nodeIds`,
          };
        }
      }
      return null;
    }

    case "schema-disconnect": {
      if (!ctx.currentNodes.has(action.from) && !ctx.pendingAdds.has(action.from)) {
        return {
          actionIndex: idx,
          code: "unknown-node",
          message: `Unknown node "${action.from}" in schema-disconnect`,
        };
      }
      if (!ctx.currentNodes.has(action.to) && !ctx.pendingAdds.has(action.to)) {
        return {
          actionIndex: idx,
          code: "unknown-node",
          message: `Unknown node "${action.to}" in schema-disconnect`,
        };
      }
      return null;
    }

    case "schema-delete-node": {
      if (!ctx.currentNodes.has(action.nodeId) && !ctx.pendingAdds.has(action.nodeId)) {
        return {
          actionIndex: idx,
          code: "unknown-node",
          message: `Unknown node "${action.nodeId}" in schema-delete-node`,
        };
      }
      return null;
    }

    case "schema-set-overlay": {
      // Overlay write is always valid (nodeId may reference orphaned nodes per spec §Overlay model).
      return null;
    }

    default:
      return null;
  }
}

// ---- Apply actions to in-memory state ----

/**
 * Applies a validated action list to in-memory node/edge state.
 * Returns the resulting action list in canonical form (schema-define + schema-connect),
 * suitable for `generateMermaid()`.
 *
 * This is a pure mutation of working state — caller guarantees all actions are valid.
 */
function applyActionsToState(
  baseActions: SchemaAction[],
  newActions: SchemaAction[],
  suffixLen: number,
): SchemaAction[] {
  // Start with the base state.
  const nodes = new Map<NodeId, NodeInfo>();
  const edges = new Map<string, EdgeInfo>();
  const groups = new Map<string, SchemaGroupAction>();
  const existingIds = new Set<NodeId>();

  // Populate from base.
  for (const a of baseActions) {
    if (a.kind === "schema-define" && a.nodeId) {
      const label = a.label !== undefined && a.label !== "" ? a.label : a.nodeId;
      nodes.set(a.nodeId, { nodeId: a.nodeId, role: a.role, label });
      existingIds.add(a.nodeId);
    }
    if (a.kind === "schema-connect") {
      edges.set(edgeKey(a.from, a.to), {
        from: a.from,
        to: a.to,
        connectionKind: a.connectionKind,
        label: a.label,
      });
    }
    if (a.kind === "schema-group" && a.name) {
      groups.set(a.name, a);
    }
  }

  // Apply new actions sequentially.
  for (const a of newActions) {
    switch (a.kind) {
      case "schema-define": {
        let nodeId = a.nodeId;
        if (!nodeId) {
          // Generate new ID from label.
          const slug = a.label ? slugify(a.label) : "";
          nodeId = generateNodeIdServer({ slug, suffixLen, existingIds });
          existingIds.add(nodeId);
        }
        const label = a.label !== undefined && a.label !== "" ? a.label : nodeId;
        nodes.set(nodeId, { nodeId, role: a.role, label });
        break;
      }
      case "schema-connect": {
        edges.set(edgeKey(a.from, a.to), {
          from: a.from,
          to: a.to,
          connectionKind: a.connectionKind,
          label: a.label,
        });
        break;
      }
      case "schema-rename": {
        const n = nodes.get(a.nodeId);
        if (n) nodes.set(a.nodeId, { ...n, label: a.label });
        break;
      }
      case "schema-set-role": {
        const n = nodes.get(a.nodeId);
        if (n) nodes.set(a.nodeId, { ...n, role: a.role });
        break;
      }
      case "schema-group": {
        if (a.name) groups.set(a.name, a);
        break;
      }
      case "schema-disconnect": {
        edges.delete(edgeKey(a.from, a.to));
        break;
      }
      case "schema-delete-node": {
        nodes.delete(a.nodeId);
        // Remove all edges connected to deleted node.
        for (const [key, edge] of edges) {
          if (edge.from === a.nodeId || edge.to === a.nodeId) {
            edges.delete(key);
          }
        }
        // Remove from groups.
        for (const [gName, grp] of groups) {
          const newNodeIds = grp.nodeIds.filter((nid) => nid !== a.nodeId);
          groups.set(gName, { ...grp, nodeIds: newNodeIds });
        }
        break;
      }
      case "schema-set-overlay": {
        // Overlay is not stored in the action list (it's in frame.meta.didrawOverlays).
        // No-op here.
        break;
      }
    }
  }

  // Reconstruct canonical action list.
  const result: SchemaAction[] = [];

  for (const [, n] of nodes) {
    result.push({
      kind: "schema-define",
      nodeId: n.nodeId,
      role: n.role,
      label: n.label !== n.nodeId ? n.label : undefined,
    } as SchemaDefineAction);
  }
  for (const [, e] of edges) {
    const connectAction: SchemaConnectAction = {
      kind: "schema-connect",
      from: e.from,
      to: e.to,
    };
    if (e.connectionKind !== undefined) {
      connectAction.connectionKind = e.connectionKind;
    }
    if (e.label !== undefined) {
      connectAction.label = e.label;
    }
    result.push(connectAction);
  }
  for (const [, grp] of groups) {
    if (grp.nodeIds.length > 0) {
      result.push(grp);
    }
  }

  return result;
}

// ---- Extract NodeIds from frame children ----

function extractExistingNodeIds(
  frame: TLRecord,
  store: Record<string, TLRecord | undefined>,
): Set<NodeId> {
  const ids = new Set<NodeId>();
  for (const id in store) {
    const r = store[id];
    if (!r || r.typeName !== "shape") continue;
    if (r.parentId !== frame.id) continue;
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    if (typeof meta.didrawId === "string") {
      ids.add(meta.didrawId);
    }
  }
  return ids;
}

/** Find the tldraw shape id for a given nodeId within frame children. */
function findShapeByNodeId(
  nodeId: NodeId,
  frame: TLRecord,
  store: Record<string, TLRecord | undefined>,
): string | undefined {
  for (const id in store) {
    const r = store[id];
    if (!r || r.typeName !== "shape") continue;
    if (r.parentId !== frame.id) continue;
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    if (meta.didrawId === nodeId) return id;
  }
  return undefined;
}

/** Find all arrow shape ids between two node shapes (via bindings). */
function findArrowsBetween(
  fromShapeId: string,
  toShapeId: string,
  store: Record<string, TLRecord | undefined>,
): string[] {
  // Collect all arrow ids bound to fromShapeId as "start".
  const fromArrows = new Set<string>();
  for (const id in store) {
    const r = store[id];
    if (!r || r.typeName !== "binding") continue;
    const props = (r.props ?? {}) as Record<string, unknown>;
    if (props.terminal === "start" && r.toId === fromShapeId) {
      if (typeof r.fromId === "string") fromArrows.add(r.fromId);
    }
  }
  // Find arrows also bound to toShapeId as "end".
  const arrowIds: string[] = [];
  for (const id in store) {
    const r = store[id];
    if (!r || r.typeName !== "binding") continue;
    const props = (r.props ?? {}) as Record<string, unknown>;
    if (
      props.terminal === "end" &&
      r.toId === toShapeId &&
      typeof r.fromId === "string" &&
      fromArrows.has(r.fromId)
    ) {
      arrowIds.push(r.fromId);
    }
  }
  return arrowIds;
}

/** Collect all bindings for an arrow shape. */
function findBindingsForArrow(
  arrowShapeId: string,
  store: Record<string, TLRecord | undefined>,
): string[] {
  const bindingIds: string[] = [];
  for (const id in store) {
    const r = store[id];
    if (!r || r.typeName !== "binding") continue;
    if (r.fromId === arrowShapeId) {
      bindingIds.push(id);
    }
  }
  return bindingIds;
}

// ---- Result types ----

export type ApplyResult =
  | {
      ok: true;
      newRaw: string;
      newOverlays: Record<NodeId, OverlayEntry>;
      batch: StoreChangeBatch;
      addedNodeIds: NodeId[];
      removedNodeIds: NodeId[];
      orphanedOverlays: number;
      destructiveScore: number;
    }
  | { ok: false; errors: SchemaActionError[] };

// ---- Main apply function ----

/**
 * Apply SchemaAction[] to an existing schema-frame.
 *
 * Pure function — takes current RoomState + frame record + actions + suffixLen.
 * Returns new RAW + new overlays + StoreChangeBatch. Does NOT mutate room.store.
 *
 * Spec §Write semantics §Apply flow (10 steps):
 *  1. Parse frame.meta.mermaidSource → oldActions.
 *  2. Validate each action against current state. If any errors → {ok:false}.
 *  3. Apply actions sequentially to in-memory state → newActions.
 *  4. Generate new RAW via generateMermaid().
 *  5. Re-parse new RAW (sanity check). If fails → {ok:false}.
 *  6. Build diff via diffSchemas().
 *  7. Translate diff → StoreChangeBatch.
 *  8. Apply existing overlays to new shapes.
 *  9. Count orphanedOverlays (overlays for removed NodeIds).
 * 10. Compute destructiveScore. Return result.
 */
export function applySchemaActions(opts: {
  room: RoomState;
  frame: TLRecord;
  actions: SchemaAction[];
  suffixLen: number;
}): ApplyResult {
  const { room, frame, actions, suffixLen } = opts;

  const store = room.store.store as Record<string, TLRecord | undefined>;

  // Step 1: Parse current RAW → oldActions.
  const frameMeta = (frame.meta ?? {}) as Record<string, unknown>;
  const oldRaw =
    typeof frameMeta.mermaidSource === "string" ? frameMeta.mermaidSource : "";
  const oldOverlays =
    (frameMeta.didrawOverlays as Record<NodeId, OverlayEntry> | undefined) ?? {};
  const oldDirection: MermaidDirection = "LR"; // default

  let oldActions: SchemaAction[] = [];
  let direction: MermaidDirection = oldDirection;

  if (oldRaw.trim().length > 0) {
    const existingIds = extractExistingNodeIds(frame, store);

    /**
     * Storage-mode parse: mermaid identifiers in our generated RAW ARE NodeIds
     * (e.g. "api-aaaaaa[API]"). The parser derives slug from label ("API" → "api"),
     * not from the mermaid identifier directly.
     *
     * Strategy: build slug-prefix → NodeId lookup from frame's existing children.
     * When slug matches a known prefix, return that NodeId directly (identity preservation).
     * This ensures parse(generate(actions)) round-trips correctly.
     *
     * We pass empty existingIds to parseMermaidFlowchart so that the "known" IDs
     * are not treated as collisions (they are not collisions — they ARE the IDs).
     */
    const knownBySlugPrefix = new Map<string, NodeId>();
    for (const nodeId of existingIds) {
      const lastDash = nodeId.lastIndexOf("-");
      if (lastDash > 0) {
        const prefix = nodeId.slice(0, lastDash);
        // Multiple nodes could share same slug prefix — map is not guaranteed unique.
        // We skip collision in that case; parser will generate a fresh ID for ambiguous slugs.
        if (!knownBySlugPrefix.has(prefix)) {
          knownBySlugPrefix.set(prefix, nodeId);
        }
      }
    }

    const parseResult = parseMermaidFlowchart(oldRaw, {
      suffixLen,
      existingIds: new Set<NodeId>(),
      /**
       * Storage-mode identity recovery:
       * 1. If mermaidId itself is a valid NodeId format, return it directly.
       *    This handles the common case where `api-aaaaaa[API]` → mermaidId = "api-aaaaaa".
       * 2. Else fall back to slug-prefix lookup from known children.
       * 3. Otherwise generate a fresh server-side NodeId.
       */
      generateId: (slug, _existing, mermaidId) => {
        // Primary: mermaidId looks like a NodeId → return it directly.
        if (/^(?:[a-z0-9]+(?:-[a-z0-9]+)*|e)-[0-9a-z]{3,12}$/.test(mermaidId)) {
          return mermaidId;
        }
        // Secondary: slug-prefix lookup from frame's known children.
        const known = knownBySlugPrefix.get(slug);
        if (known !== undefined) {
          return known;
        }
        // Fallback: fresh ID.
        return generateNodeIdServer({ slug, suffixLen, existingIds });
      },
    });
    if (!parseResult.ok) {
      // Current RAW is invalid — treat as empty (frame may be new/corrupt).
      oldActions = [];
    } else {
      oldActions = parseResult.actions;
      direction = parseResult.direction;
    }
  }

  // Build current node set from parsed old actions.
  const { nodes: currentNodes, edges: currentEdges } = extractState(oldActions);

  // Step 2: Validate ALL actions before any mutation.
  const errors: SchemaActionError[] = [];
  const validationCtx: ValidationContext = {
    currentNodes,
    currentEdges,
    pendingAdds: new Set(),
  };

  for (let i = 0; i < actions.length; i++) {
    const err = validateAction(actions[i]!, i, validationCtx);
    if (err) errors.push(err);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Step 3: Apply actions to in-memory state → newActions (canonical form).
  const newActions = applyActionsToState(oldActions, actions, suffixLen);

  // Step 4: Generate new RAW.
  const newRaw = generateMermaid({ actions: newActions, direction });

  // Step 5: Re-parse new RAW (sanity check).
  // Use storage-mode generateId: mermaid identifiers in generated RAW are already NodeIds.
  const reparseResult = parseMermaidFlowchart(newRaw, {
    suffixLen,
    existingIds: new Set(),
    generateId: (slug, existing, mermaidId) => {
      if (/^(?:[a-z0-9]+(?:-[a-z0-9]+)*|e)-[0-9a-z]{3,12}$/.test(mermaidId)) {
        return mermaidId;
      }
      return generateNodeIdServer({ slug, suffixLen, existingIds: existing });
    },
  });
  if (!reparseResult.ok) {
    return {
      ok: false,
      errors: [
        {
          actionIndex: -1,
          code: "invalid-mermaid",
          message: `Generated RAW failed reparse: ${reparseResult.message}`,
        },
      ],
    };
  }

  // Step 6: Build diff.
  const diff = diffSchemas(oldActions, newActions);

  // Step 7: Translate diff → StoreChangeBatch.
  const batch: StoreChangeBatch = {
    added: {},
    updated: {},
    removed: {},
  };

  const { nodes: newNodes } = extractState(newActions);

  // Added nodes → create geo shapes.
  for (const addedNode of diff.added) {
    const overlayEntry = oldOverlays[addedNode.nodeId];
    const shape = makeGeoShape({
      nodeId: addedNode.nodeId,
      label: addedNode.label,
      role: addedNode.role,
      parentId: frame.id,
      overlayEntry,
    });
    batch.added[shape.id] = shape;
  }

  // Removed nodes → delete their tldraw shapes.
  for (const removedNodeId of diff.removed) {
    const shapeId = findShapeByNodeId(removedNodeId, frame, store);
    if (shapeId) {
      const existingShape = store[shapeId];
      if (existingShape) {
        batch.removed[shapeId] = existingShape;
      }
    }
  }

  // Renamed nodes → update richText props.
  for (const renamed of diff.renamed) {
    const shapeId = findShapeByNodeId(renamed.nodeId, frame, store);
    if (shapeId) {
      const old = store[shapeId];
      if (old) {
        const newShape: TLRecord = {
          ...old,
          props: {
            ...(old.props ?? {}),
            richText: richText(renamed.newLabel),
          },
          meta: {
            ...(old.meta ?? {}),
            didrawLabel: renamed.newLabel,
          },
        };
        batch.updated[shapeId] = [old, newShape];
      }
    }
  }

  // Role changed → update shape props (color/style via preset).
  for (const rc of diff.roleChanged) {
    const shapeId = findShapeByNodeId(rc.nodeId, frame, store);
    if (shapeId && !batch.updated[shapeId]) {
      const old = store[shapeId];
      if (old) {
        const preset = rolePreset(rc.newRole);
        const newShape: TLRecord = {
          ...old,
          props: {
            ...(old.props ?? {}),
            color: preset.style.color ?? "black",
            fill: preset.style.fill ?? "none",
            w: preset.defaultW ?? 220,
            h: preset.defaultH ?? 80,
          },
          meta: {
            ...(old.meta ?? {}),
          },
        };
        batch.updated[shapeId] = [old, newShape];
      }
    }
  }

  // Added edges → create arrow shapes.
  // We need tldraw shape ids for both endpoints.
  // For newly added nodes (in batch.added), we need to find them.
  function resolveShapeId(nodeId: NodeId): string | undefined {
    // First check if it's a newly added shape in this batch.
    for (const [sid, shape] of Object.entries(batch.added)) {
      const meta = (shape.meta ?? {}) as Record<string, unknown>;
      if (meta.didrawId === nodeId) return sid;
    }
    // Check existing store.
    return findShapeByNodeId(nodeId, frame, store);
  }

  for (const edgeAdded of diff.edgesAdded) {
    const fromShapeId = resolveShapeId(edgeAdded.from);
    const toShapeId = resolveShapeId(edgeAdded.to);
    if (!fromShapeId || !toShapeId) continue;

    const ck = edgeAdded.connectionKind ?? "sync";
    const preset = connectionPreset(ck);
    const aid = `shape:${rand()}`;
    const arrow = makeArrowShape({
      id: aid,
      dash: preset.dashed ? "dashed" : "draw",
      label: edgeAdded.label ?? preset.defaultLabel ?? "",
      meta: { connectionKind: ck },
      parentId: frame.id,
    });
    const { start, end } = makeArrowBindings(aid, fromShapeId, toShapeId);
    batch.added[aid] = arrow;
    batch.added[start.id] = start;
    batch.added[end.id] = end;
  }

  // Removed edges → delete arrow shapes + their bindings.
  for (const edgeRemoved of diff.edgesRemoved) {
    const fromShapeId = findShapeByNodeId(edgeRemoved.from, frame, store);
    const toShapeId = findShapeByNodeId(edgeRemoved.to, frame, store);
    if (!fromShapeId || !toShapeId) continue;

    const arrowIds = findArrowsBetween(fromShapeId, toShapeId, store);
    for (const aid of arrowIds) {
      const arrowShape = store[aid];
      if (arrowShape) {
        batch.removed[aid] = arrowShape;
      }
      // Remove bindings.
      const bids = findBindingsForArrow(aid, store);
      for (const bid of bids) {
        const binding = store[bid];
        if (binding) {
          batch.removed[bid] = binding;
        }
      }
    }
  }

  // Step 8: Apply overlays to added shapes (positions, colors).
  // (Already applied in makeGeoShape via overlayEntry parameter above.)

  // Step 9: Count orphaned overlays (overlays for removed NodeIds).
  let orphanedOverlays = 0;
  const newOverlays: Record<NodeId, OverlayEntry> = { ...oldOverlays };

  for (const removedNodeId of diff.removed) {
    if (oldOverlays[removedNodeId] !== undefined) {
      orphanedOverlays++;
      // Per spec §Overlay model: "keep dead" — orphan entries stay in newOverlays.
    }
  }

  // Apply schema-set-overlay actions to newOverlays.
  for (const a of actions) {
    if (a.kind === "schema-set-overlay") {
      const existingOverlay = newOverlays[a.nodeId] ?? {};
      // Deep merge (not replace) per spec §User overlay write flow step 5.
      newOverlays[a.nodeId] = { ...existingOverlay, ...a.overlay };
    }
  }

  // Step 10: Compute destructiveScore.
  const oldNodeCount = currentNodes.size;
  const removedCount = diff.removed.length;
  const destructiveScore =
    oldNodeCount > 0 ? removedCount / oldNodeCount : 0;

  const addedNodeIds = diff.added.map((n) => n.nodeId);
  const removedNodeIds = [...diff.removed];

  return {
    ok: true,
    newRaw,
    newOverlays,
    batch,
    addedNodeIds,
    removedNodeIds,
    orphanedOverlays,
    destructiveScore,
  };
}
