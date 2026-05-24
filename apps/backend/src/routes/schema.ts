/**
 * Schema HTTP routes — DRW-134 Task 2.5.
 *
 * POST /api/schema/create         — создаёт новый schema-frame (Mode A: raw mermaid | Mode B: actions).
 *                                   Side-effect: ставит room.meta.didrawProtocol = "v2" (auto-upgrade).
 * POST /api/schema/:frameId/patch  — apply SchemaAction[] к существующему frame.
 * POST /api/schema/:frameId/overlay — single-overlay write (user drag / color / label from frontend).
 *
 * Idempotency: LRU-1000 cache по clientOpId (паттерн из routes/domain.ts:24-53).
 *
 * Все write-path endpoints: bundleForRequest → rooms → scheduleSave → bus.publish.
 * Frame positioning: (100,100) если комната пустая; иначе — правее последнего frame + 40px.
 */

import { randomBytes } from "node:crypto";
import { connectionPreset } from "@shemma/domain";
import type { OverlayEntry, SchemaAction } from "@shemma/domain";
import type { NodeId } from "@shemma/domain";
import { Hono } from "hono";
import { config } from "../config";
import { applySchemaActions } from "../domain/schema/apply";
import { isV2Room, roomSuffixLength } from "../domain/schema/detect";
import { generateNodeIdServer, nodeIdFromLabel } from "../domain/schema/identity";
import { assignBatchIndices } from "../domain/schema/index-key";
import { parseMermaidFlowchart } from "../domain/schema/mermaid-parser";
import type { MermaidDirection } from "../domain/schema/mermaid-parser";
import { generateMermaid } from "../domain/schema/mermaid-generator";
import { buildCanvasView } from "../domain/schema/view";
import { runLayout } from "../domain/layout";
import { pushOpLog, resolveRoomId } from "../rooms";
import {
  applyStoreChanges,
  isEmptyBatch,
  rebuildDidrawIndex,
} from "../store-ops";
import type { StoreChangeBatch } from "../store-types";
import type { TLRecord } from "../store-types";
import type { RoomState, StoreChangeBus } from "../types";
import { bundleForRequest } from "./_space-context";

// ---- LRU cache (паттерн из routes/domain.ts:24-53) ----

const MAX_IDEMPOTENCY_ENTRIES = 1000;

function makeLruCache<K, V>(max: number) {
  const m = new Map<K, V>();
  return {
    get(k: K): V | undefined {
      const v = m.get(k);
      if (v !== undefined) {
        m.delete(k);
        m.set(k, v);
      }
      return v;
    },
    set(k: K, v: V): void {
      if (m.has(k)) m.delete(k);
      m.set(k, v);
      if (m.size > max) {
        const oldest = m.keys().next().value;
        if (oldest !== undefined) m.delete(oldest);
      }
    },
  };
}

// ---- Rich text helper (миррор из apply.ts) ----

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

function randHex(): string {
  return randomBytes(5).toString("hex");
}

function frameShapeId(): string {
  return `shape:f_${randHex()}`;
}

function childShapeId(): string {
  return `shape:${randHex()}`;
}

function arrowShapeId(): string {
  return `shape:${randHex()}`;
}

function bindingRecordId(): string {
  return `binding:${randHex()}`;
}

// ---- Build arrow shape ----

function makeArrowShapeLocal(opts: {
  id: string;
  dash: "draw" | "dashed";
  label: string;
  meta: Record<string, unknown>;
  parentId: string;
}): TLRecord {
  const richTextVal = opts.label
    ? {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: opts.label }] }],
      }
    : { type: "doc", content: [{ type: "paragraph" }] };
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
      richText: richTextVal,
    },
    meta: opts.meta,
  } as TLRecord;
}

// ---- Build arrow bindings ----

function makeArrowBindingsLocal(
  arrowId: string,
  fromShapeId: string,
  toShapeId: string,
): { start: TLRecord; end: TLRecord } {
  const mk = (terminal: "start" | "end", toId: string): TLRecord =>
    ({
      id: bindingRecordId(),
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

// ---- Build boundary (group) shape for subgraph ----

function makeGroupBoundaryShape(opts: {
  id?: string;
  name: string;
  parentId: string;
  direction?: "TB" | "LR" | "BT" | "RL";
}): TLRecord {
  const id = opts.id ?? childShapeId();
  const richTextVal = opts.name
    ? {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: opts.name }] }],
      }
    : { type: "doc", content: [{ type: "paragraph" }] };
  return {
    id,
    typeName: "shape",
    type: "geo",
    x: 0,
    y: 0,
    parentId: opts.parentId,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      w: 300,
      h: 200,
      geo: "rectangle",
      color: "grey",
      labelColor: "black",
      fill: "semi",
      dash: "dashed",
      size: "m",
      font: "draw",
      align: "middle",
      verticalAlign: "start",
      growY: 0,
      url: "",
      scale: 1,
      richText: richTextVal,
    },
    meta: {
      role: "boundary",
      didrawSubgraph: true,
      didrawSubgraphName: opts.name,
      didrawSchemaParent: opts.parentId,
      ...(opts.direction !== undefined ? { didrawSubgraphDirection: opts.direction } : {}),
    },
  } as TLRecord;
}

// ---- Frame positioning helper ----

/**
 * Вычисляет позицию нового schema-frame.
 * Если есть существующие frames — располагаем правее последнего + 40px gap.
 * Иначе — (100, 100).
 */
function computeFramePosition(
  store: Record<string, TLRecord | undefined>,
): { x: number; y: number } {
  let maxRight = -Infinity;
  let firstY = 100;
  let found = false;

  for (const id in store) {
    const r = store[id];
    if (!r || r.typeName !== "shape") continue;
    if (r.meta?.didrawSchemaFrame !== true) continue;
    const x = typeof r.x === "number" ? r.x : 0;
    const props = (r.props ?? {}) as { w?: unknown };
    const w = typeof props.w === "number" ? props.w : 640;
    const right = x + w;
    if (!found || right > maxRight) {
      maxRight = right;
      firstY = typeof r.y === "number" ? r.y : 100;
      found = true;
    }
  }

  if (!found) return { x: 100, y: 100 };
  return { x: maxRight + 40, y: firstY };
}

// ---- Build schema-frame shape ----

function makeFrameShape(opts: {
  frameId: string;
  label: string;
  raw: string;
  position: { x: number; y: number };
  parentId: string;
}): TLRecord {
  return {
    id: opts.frameId,
    typeName: "shape",
    type: "frame",
    x: opts.position.x,
    y: opts.position.y,
    parentId: opts.parentId,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      name: opts.label,
      w: 640,
      h: 480,
      // DRW-159: tldraw v5 TLFrameShape.props.color стал required (TLDefaultColorStyle).
      // Без него mergeRemoteChanges/applyDiff на frontend бросает ValidationError
      // и блокирует apply всего WS batch'а — schema-frame import не виден на канвасе.
      color: "black",
    },
    meta: {
      didrawSchemaFrame: true,
      didrawProtocol: "v2",
      schemaProtocolVersion: "1.0",
      mermaidSource: opts.raw,
      didrawOverlays: {},
    },
  } as TLRecord;
}

// ---- Build child geo shape ----

import { rolePreset } from "@shemma/domain";
import type { Role } from "@shemma/domain";
import type { MermaidNodeStyle } from "../domain/schema/mermaid-parser";
import { hexToTldrawColor } from "../export/miro/color-mapping";

/**
 * Resolve mermaid style fill/stroke/color fields to tldraw shape props.
 *
 * Mapping rationale:
 *   - fill  → `fill` style (solid/semi) + `color` (border/foreground tldraw color nearest to fill hex).
 *             When a fill is set: use "solid" fill mode to show the background color visibly.
 *   - stroke → `color` (border/foreground tldraw color) — only used when fill is absent.
 *   - color (text) → `labelColor` (tldraw labelColor prop) nearest-neighbor mapped.
 */
function resolveMermaidStyle(
  mermaidStyle: MermaidNodeStyle,
  presetColor: string,
  presetFill: string,
): { color: string; fill: string; labelColor: string } {
  // Start with preset defaults
  let color = presetColor;
  let fill = presetFill;
  let labelColor = "black";

  if (mermaidStyle.fill !== undefined) {
    // fill hex → nearest tldraw named color for border/fg color
    const mapped = hexToTldrawColor(mermaidStyle.fill);
    if (mapped !== undefined) {
      color = mapped;
      // Use "solid" fill mode to render the background color
      fill = "solid";
    }
  } else if (mermaidStyle.stroke !== undefined) {
    // stroke without fill → just change border color
    const mapped = hexToTldrawColor(mermaidStyle.stroke);
    if (mapped !== undefined) {
      color = mapped;
    }
  }

  if (mermaidStyle.color !== undefined) {
    const mapped = hexToTldrawColor(mermaidStyle.color);
    if (mapped !== undefined) {
      labelColor = mapped;
    }
  }

  return { color, fill, labelColor };
}

function makeChildShape(opts: {
  nodeId: NodeId;
  label: string;
  role: Role;
  parentId: string;
  overlay?: OverlayEntry;
  mermaidStyle?: MermaidNodeStyle;
}): TLRecord {
  const preset = rolePreset(opts.role) ?? { style: { color: "black", fill: "none" }, defaultW: 220, defaultH: 80 };
  const x = opts.overlay?.position?.x ?? 0;
  const y = opts.overlay?.position?.y ?? 0;

  const presetColor = preset.style?.color ?? "black";
  const presetFill = preset.style?.fill ?? "none";

  // Apply mermaid style if provided (overrides preset defaults)
  const resolved = opts.mermaidStyle
    ? resolveMermaidStyle(opts.mermaidStyle, presetColor, presetFill)
    : { color: presetColor, fill: presetFill, labelColor: "black" };

  // Overlay color overrides everything (user-owned)
  const color = opts.overlay?.color ?? resolved.color;

  return {
    id: childShapeId(),
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
      labelColor: resolved.labelColor,
      fill: resolved.fill,
      dash: "draw",
      size: "m",
      font: "draw",
      align: "middle",
      verticalAlign: "middle",
      growY: 0,
      url: "",
      scale: 1,
      richText: richText(opts.label),
    },
    meta: {
      didrawId: opts.nodeId,
      didrawName: opts.nodeId,
      didrawLabel: opts.label,
      didrawRole: opts.role,
      didrawSchemaParent: opts.parentId,
    },
  } as TLRecord;
}

// ---- Extract nodes from parsed actions ----

type NodeDef = {
  nodeId: NodeId;
  label: string;
  role: Role;
};

function extractNodeDefs(actions: SchemaAction[]): NodeDef[] {
  const defs: NodeDef[] = [];
  for (const a of actions) {
    if (a.kind === "schema-define" && a.nodeId) {
      defs.push({
        nodeId: a.nodeId,
        label: a.label !== undefined && a.label !== "" ? a.label : a.nodeId,
        role: a.role as Role,
      });
    }
  }
  return defs;
}

// ---- Default page id detection ----

function findDefaultPageId(store: Record<string, TLRecord | undefined>): string {
  // Ищем первую запись с typeName === "page". Fallback — "page:page".
  for (const id in store) {
    const r = store[id];
    if (r?.typeName === "page") return id;
  }
  return "page:page";
}

// ---- Response types ----

type SchemaCreateResponse = {
  ok: true;
  frameId: string;
  nodeIds: NodeId[];
  version: number;
};

type SchemaErrorEntry = { code: string; message: string; actionIndex?: number };

type SchemaCreateErrorResponse = {
  ok: false;
  errors: SchemaErrorEntry[];
};

type SchemaPatchResponse = {
  ok: true;
  frameId: string;
  version: number;
  orphanedOverlays: number;
  addedNodeIds: NodeId[];
  removedNodeIds: NodeId[];
  destructiveScore: number;
};

type SchemaPatchErrorResponse = {
  ok: false;
  errors: SchemaErrorEntry[];
};

// ---- Route factory ----

export function schemaRoutes(bus: StoreChangeBus) {
  // Idempotency cache — паттерн из domain.ts:24-53.
  const idempotencyCache = makeLruCache<string, SchemaPatchResponse>(
    MAX_IDEMPOTENCY_ENTRIES,
  );

  return new Hono()

    // =========================================================================
    // POST /api/schema/create
    // Mode A: { label, raw }   — parse mermaid → генерируем actions → frame.
    // Mode B: { label, actions } — используем actions напрямую.
    // Side-effect: ставит room.meta.didrawProtocol = "v2" если ещё не v2.
    // =========================================================================
    .post("/api/schema/create", async (c) => {
      const rv = resolveRoomId(c.req.query("room"));
      if (!rv.ok) return c.json({ ok: false, errors: [{ code: "invalid-room", message: rv.reason }] } satisfies SchemaCreateErrorResponse, 422);
      const id = rv.id;

      const body = (await c.req.json().catch(() => null)) as {
        label?: string;
        raw?: string;
        actions?: SchemaAction[];
        clientOpId?: string;
      } | null;

      if (!body) {
        return c.json(
          { ok: false, errors: [{ code: "bad-request", message: "expected JSON body {label, raw?} or {label, actions?}" }] } satisfies SchemaCreateErrorResponse,
          400,
        );
      }

      const { rooms, scheduleSave, space } = bundleForRequest(c);
      const spaceId = space.id;
      const room = await rooms.get(id);

      const store = room.store.store as Record<string, TLRecord | undefined>;
      const suffixLen = roomSuffixLength(room);

      const label = typeof body.label === "string" ? body.label : "Schema";

      let parsedActions: SchemaAction[];
      let direction: MermaidDirection = "LR";

      let nodeStylesByNodeId: Map<NodeId, import("../domain/schema/mermaid-parser").MermaidNodeStyle> = new Map();

      if (body.raw !== undefined) {
        // Mode A: parse mermaid RAW.
        if (typeof body.raw !== "string" || body.raw.trim().length === 0) {
          return c.json(
            { ok: false, errors: [{ code: "bad-request", message: "field 'raw' must be a non-empty mermaid string" }] } satisfies SchemaCreateErrorResponse,
            400,
          );
        }

        const existingIds = new Set<NodeId>();
        const parseResult = parseMermaidFlowchart(body.raw, {
          suffixLen,
          existingIds,
          generateId: (slug, existing) =>
            generateNodeIdServer({ slug, suffixLen, existingIds: existing }),
        });

        if (!parseResult.ok) {
          return c.json(
            {
              ok: false,
              errors: [
                {
                  actionIndex: -1,
                  code: parseResult.code,
                  message: parseResult.message,
                },
              ],
            } satisfies SchemaCreateErrorResponse,
            422,
          );
        }

        parsedActions = parseResult.actions;
        direction = parseResult.direction;
        nodeStylesByNodeId = parseResult.nodeStylesByNodeId;
      } else if (body.actions !== undefined) {
        // Mode B: caller-provided actions.
        if (!Array.isArray(body.actions)) {
          return c.json(
            { ok: false, errors: [{ code: "bad-request", message: "field 'actions' must be an array" }] } satisfies SchemaCreateErrorResponse,
            400,
          );
        }

        // Assign IDs to schema-define actions that don't have one.
        const existingIds = new Set<NodeId>();
        parsedActions = body.actions.map((a) => {
          if (a.kind === "schema-define" && !a.nodeId) {
            const slug = a.label ? a.label : "";
            const nodeId = nodeIdFromLabel(slug, existingIds, suffixLen);
            existingIds.add(nodeId);
            return { ...a, nodeId };
          }
          return a;
        });
      } else {
        return c.json(
          { ok: false, errors: [{ code: "bad-request", message: "body must contain either 'raw' (mermaid string) or 'actions' array" }] } satisfies SchemaCreateErrorResponse,
          400,
        );
      }

      // Generate canonical RAW.
      const raw = generateMermaid({ actions: parsedActions, direction });

      // Create frame + child shapes batch.
      const pageId = findDefaultPageId(store);
      const position = computeFramePosition(store);
      const frameId = frameShapeId();

      const batch: StoreChangeBatch = { added: {}, updated: {}, removed: {} };

      const frameShape = makeFrameShape({ frameId, label, raw, position, parentId: pageId });
      batch.added[frameId] = frameShape;

      // DRW-156: Pre-process schema-group actions to build a lookup map so that
      // child shapes are parented to their subgraph wrapper shape, not the frame.
      //
      // Step 1: allocate group shape IDs eagerly and build:
      //   nodeIdToGroupShapeId — member NodeId → group's tldraw shape id
      //
      // NOTE: nested subgraphs are handled at the flat level — each group shape
      // is always parented to frameId regardless of nesting depth. Full nested
      // group support (inner group parented to outer group) is deferred.
      const nodeIdToGroupShapeId = new Map<NodeId, string>();
      const groupActionToShapeId = new Map<string, string>(); // action.name → shape id

      for (const action of parsedActions) {
        if (action.kind !== "schema-group") continue;
        if (!action.name) continue;
        const groupShapeId = childShapeId();
        groupActionToShapeId.set(action.name, groupShapeId);
        for (const memberId of action.nodeIds) {
          nodeIdToGroupShapeId.set(memberId, groupShapeId);
        }
      }

      // Step 2: Create boundary (group) shapes before child shapes so tldraw
      // parent shapes exist when children reference them.
      for (const action of parsedActions) {
        if (action.kind !== "schema-group") continue;
        if (!action.name) continue;
        const groupShapeId = groupActionToShapeId.get(action.name);
        if (!groupShapeId) continue;
        const groupShape = makeGroupBoundaryShape({
          id: groupShapeId,
          name: action.label ?? action.name,
          parentId: frameId,
          direction: action.direction,
        });
        batch.added[groupShapeId] = groupShape;
      }

      // Step 3: Create child shapes for each node, parenting to group wrapper if applicable.
      const nodeIds: NodeId[] = [];
      const nodeDefs = extractNodeDefs(parsedActions);

      // nodeId → tldraw shape id map (for arrow binding resolution).
      const nodeIdToShapeId = new Map<NodeId, string>();

      for (const def of nodeDefs) {
        const groupShapeId = nodeIdToGroupShapeId.get(def.nodeId);
        const childShape = makeChildShape({
          nodeId: def.nodeId,
          label: def.label,
          role: def.role,
          parentId: groupShapeId ?? frameId,
          mermaidStyle: nodeStylesByNodeId.get(def.nodeId),
        });
        batch.added[childShape.id] = childShape;
        nodeIds.push(def.nodeId);
        nodeIdToShapeId.set(def.nodeId, childShape.id);
      }

      // Create arrow shapes for each schema-connect action.
      for (const action of parsedActions) {
        if (action.kind !== "schema-connect") continue;
        const fromShapeId = nodeIdToShapeId.get(action.from);
        const toShapeId = nodeIdToShapeId.get(action.to);
        if (!fromShapeId || !toShapeId) continue;

        const ck = action.connectionKind ?? "sync";
        const preset = connectionPreset(ck);
        const aid = arrowShapeId();
        const arrow = makeArrowShapeLocal({
          id: aid,
          dash: preset.dashed ? "dashed" : "draw",
          label: action.label ?? preset.defaultLabel ?? "",
          meta: { connectionKind: ck },
          parentId: frameId,
        });
        const { start, end } = makeArrowBindingsLocal(aid, fromShapeId, toShapeId);
        batch.added[aid] = arrow;
        batch.added[start.id] = start;
        batch.added[end.id] = end;
      }

      // Auto-upgrade: set room.meta.didrawProtocol = "v2" if not already v2.
      // This is the key side-effect that makes v2 auto-upgrade work per plan.
      if (!isV2Room(room)) {
        room.meta = { ...(room.meta ?? {}), didrawProtocol: "v2" };
      }

      // DRW-141: assign unique fractional indices to all newly added shapes
      // so native tldraw `Cmd+D` doesn't collide on shared "a1" sibling index.
      assignBatchIndices(batch, room.store.store as Record<string, TLRecord | undefined>);

      // Persist batch.
      if (!isEmptyBatch(batch)) {
        room.store = applyStoreChanges(room.store, batch);
        room.didrawIndex = rebuildDidrawIndex(room.store);
        room.version += 1;
        pushOpLog(
          room,
          { ops: batch, source: "ai", version: room.version, at: Date.now(), clientOpId: body.clientOpId },
          config.opLogMaxSize,
        );
        room.dirty = true;
        scheduleSave(id, room);
        bus.publish(spaceId, id, {
          changes: batch,
          source: "ai",
          version: room.version,
          originClientId: body.clientOpId,
        });
      }

      // Run layout post-apply (spec §Write semantics step 9).
      // DRW-160: используем direction из mermaid header (или Mode B fallback на LR).
      // TB → layered-tb, LR → layered-lr, BT → layered-bt, RL → layered-rl.
      // Раньше hardcoded layered-lr игнорировал `flowchart TB` и переворачивал графы.
      try {
        const affectedIds = new Set<string>(Object.keys(batch.added).filter((k) => {
          const r = room.store.store[k];
          return r?.typeName === "shape";
        }));
        const dirToMode = {
          TB: "layered-tb",
          LR: "layered-lr",
          BT: "layered-bt",
          RL: "layered-rl",
        } as const;
        const layoutMode = dirToMode[direction];
        const lr = await runLayout(
          room.store,
          { mode: layoutMode, scope: "affected", affectedIds },
          room.didrawIndex,
        );
        if (!isEmptyBatch(lr.batch)) {
          room.store = applyStoreChanges(room.store, lr.batch);
          room.didrawIndex = rebuildDidrawIndex(room.store);
          room.version += 1;
          pushOpLog(
            room,
            { ops: lr.batch, source: "ai", version: room.version, at: Date.now() },
            config.opLogMaxSize,
          );
          room.dirty = true;
          scheduleSave(id, room);
          bus.publish(spaceId, id, {
            changes: lr.batch,
            source: "ai",
            version: room.version,
          });
        }
      } catch {
        // Layout failure is non-fatal; shapes remain at (0,0).
      }

      return c.json({
        ok: true,
        frameId,
        nodeIds,
        version: room.version,
      } satisfies SchemaCreateResponse);
    })

    // =========================================================================
    // POST /api/schema/:frameId/patch
    // Apply SchemaAction[] к существующему schema-frame.
    // Idempotent по clientOpId.
    // =========================================================================
    .post("/api/schema/:frameId/patch", async (c) => {
      const rv = resolveRoomId(c.req.query("room"));
      if (!rv.ok) return c.json({ ok: false, errors: [{ code: "invalid-room", message: rv.reason }] } satisfies SchemaPatchErrorResponse, 422);
      const id = rv.id;
      const frameId = c.req.param("frameId");

      const body = (await c.req.json().catch(() => null)) as {
        actions?: SchemaAction[];
        clientOpId?: string;
      } | null;

      if (!body || !Array.isArray(body.actions)) {
        return c.json(
          { ok: false, errors: [{ code: "bad-request", message: "expected {actions: SchemaAction[], clientOpId?}" }] } satisfies SchemaPatchErrorResponse,
          400,
        );
      }

      // Idempotency check.
      if (body.clientOpId) {
        const cached = idempotencyCache.get(`${id}:${body.clientOpId}`);
        if (cached) return c.json({ ...cached, idempotent: true });
      }

      const { rooms, scheduleSave, space } = bundleForRequest(c);
      const spaceId = space.id;
      const room = await rooms.get(id);

      // v2 check.
      if (!isV2Room(room)) {
        return c.json(
          { ok: false, errors: [{ code: "legacy-room-not-v2", message: "room is not a v2 schema room; create a schema-frame first" }] } satisfies SchemaPatchErrorResponse,
          422,
        );
      }

      // Lookup frame.
      const store = room.store.store as Record<string, TLRecord | undefined>;
      const frame = store[frameId];
      if (!frame || frame.typeName !== "shape") {
        return c.json(
          { ok: false, errors: [{ code: "frame-not-found", message: `schema-frame '${frameId}' not found` }] } satisfies SchemaPatchErrorResponse,
          404,
        );
      }
      if (frame.meta?.didrawSchemaFrame !== true) {
        return c.json(
          { ok: false, errors: [{ code: "not-schema-frame", message: `shape '${frameId}' exists but is not a schema-frame` }] } satisfies SchemaPatchErrorResponse,
          422,
        );
      }

      const suffixLen = roomSuffixLength(room);

      // Apply schema actions (pure function, no I/O).
      const result = applySchemaActions({
        room,
        frame,
        actions: body.actions,
        suffixLen,
      });

      if (!result.ok) {
        return c.json(
          { ok: false, errors: result.errors } satisfies SchemaPatchErrorResponse,
          422,
        );
      }

      const {
        newRaw,
        newOverlays,
        batch,
        addedNodeIds,
        removedNodeIds,
        orphanedOverlays,
        destructiveScore,
      } = result;

      // Update frame meta in the batch.
      const updatedFrame: TLRecord = {
        ...frame,
        meta: {
          ...(frame.meta ?? {}),
          mermaidSource: newRaw,
          didrawOverlays: newOverlays,
        },
      };
      const frameBatch: StoreChangeBatch = {
        added: { ...batch.added },
        updated: { ...batch.updated, [frameId]: [frame, updatedFrame] },
        removed: { ...batch.removed },
      };

      // Persist.
      if (!isEmptyBatch(frameBatch)) {
        room.store = applyStoreChanges(room.store, frameBatch);
        room.didrawIndex = rebuildDidrawIndex(room.store);
        room.version += 1;
        pushOpLog(
          room,
          { ops: frameBatch, source: "ai", version: room.version, at: Date.now(), clientOpId: body.clientOpId },
          config.opLogMaxSize,
        );
        room.dirty = true;
        scheduleSave(id, room);
        bus.publish(spaceId, id, {
          changes: frameBatch,
          source: "ai",
          version: room.version,
          originClientId: body.clientOpId,
        });
      }

      // Run layout post-apply (spec §Write semantics step 9).
      // Re-use prior frame's layout mode from meta if available, else default layered-lr.
      try {
        const frameMeta = (frame.meta ?? {}) as Record<string, unknown>;
        const layoutMode = (typeof frameMeta.layoutMode === "string"
          ? frameMeta.layoutMode
          : "layered-lr") as import("@shemma/domain").LayoutMode;
        const affectedIds = new Set<string>(Object.keys(frameBatch.added).filter((k) => {
          const r = room.store.store[k];
          return r?.typeName === "shape";
        }));
        if (affectedIds.size > 0) {
          const lr = await runLayout(
            room.store,
            { mode: layoutMode, scope: "affected", affectedIds },
            room.didrawIndex,
          );
          if (!isEmptyBatch(lr.batch)) {
            room.store = applyStoreChanges(room.store, lr.batch);
            room.didrawIndex = rebuildDidrawIndex(room.store);
            room.version += 1;
            pushOpLog(
              room,
              { ops: lr.batch, source: "ai", version: room.version, at: Date.now() },
              config.opLogMaxSize,
            );
            room.dirty = true;
            scheduleSave(id, room);
            bus.publish(spaceId, id, {
              changes: lr.batch,
              source: "ai",
              version: room.version,
            });
          }
        }
      } catch {
        // Layout failure is non-fatal; shapes remain at their computed positions.
      }

      const resp: SchemaPatchResponse = {
        ok: true,
        frameId,
        version: room.version,
        orphanedOverlays,
        addedNodeIds,
        removedNodeIds,
        destructiveScore,
      };

      if (body.clientOpId) {
        idempotencyCache.set(`${id}:${body.clientOpId}`, resp);
      }

      return c.json(resp);
    })

    // =========================================================================
    // POST /api/schema/:frameId/overlay
    // Single-overlay write: { nodeId, overlay, clientOpId? }.
    // Ownership guard: user-owned overlay защищена от AI override.
    // Deep-merge (не replace) per spec §User overlay write flow.
    // =========================================================================
    .post("/api/schema/:frameId/overlay", async (c) => {
      const rv = resolveRoomId(c.req.query("room"));
      if (!rv.ok) return c.json({ ok: false, errors: [{ code: "invalid-room", message: rv.reason }] }, 422);
      const id = rv.id;
      const frameId = c.req.param("frameId");

      const body = (await c.req.json().catch(() => null)) as {
        nodeId?: string;
        overlay?: OverlayEntry;
        clientOpId?: string;
      } | null;

      if (!body || typeof body.nodeId !== "string" || !body.overlay || typeof body.overlay !== "object") {
        return c.json({ ok: false, errors: [{ code: "bad-request", message: "expected {nodeId: string, overlay: OverlayEntry, clientOpId?}" }] }, 400);
      }

      const { nodeId, overlay, clientOpId } = body;

      const { rooms, scheduleSave, space } = bundleForRequest(c);
      const spaceId = space.id;
      const room = await rooms.get(id);

      // v2 check.
      if (!isV2Room(room)) {
        return c.json({ ok: false, errors: [{ code: "legacy-room-not-v2", message: "room is not a v2 schema room" }] }, 422);
      }

      // Lookup frame.
      const store = room.store.store as Record<string, TLRecord | undefined>;
      const frame = store[frameId];
      if (!frame || frame.typeName !== "shape") {
        return c.json({ ok: false, errors: [{ code: "frame-not-found", message: `schema-frame '${frameId}' not found` }] }, 404);
      }
      if (frame.meta?.didrawSchemaFrame !== true) {
        return c.json({ ok: false, errors: [{ code: "not-schema-frame", message: `shape '${frameId}' is not a schema-frame` }] }, 422);
      }

      // Get current overlays.
      const currentOverlays = (frame.meta?.didrawOverlays ?? {}) as Record<NodeId, OverlayEntry>;

      // Ownership guard: если существующий overlay user-owned и входящий — нет, блокируем.
      const existing = currentOverlays[nodeId];
      if (
        existing?.styleOwnedBy === "user" &&
        (overlay as OverlayEntry).styleOwnedBy !== "user"
      ) {
        return c.json({ ok: false, errors: [{ code: "overlay-user-owned", message: `overlay for node '${nodeId}' is user-owned; pass styleOwnedBy:"user" to override` }] }, 422);
      }

      // Deep-merge overlay.
      const newOverlay: OverlayEntry = { ...existing, ...overlay };
      const newOverlays: Record<NodeId, OverlayEntry> = {
        ...currentOverlays,
        [nodeId]: newOverlay,
      };

      // Update frame meta.
      const updatedFrame: TLRecord = {
        ...frame,
        meta: {
          ...(frame.meta ?? {}),
          didrawOverlays: newOverlays,
        },
      };

      const batch: StoreChangeBatch = {
        added: {},
        updated: { [frameId]: [frame, updatedFrame] },
        removed: {},
      };

      room.store = applyStoreChanges(room.store, batch);
      room.didrawIndex = rebuildDidrawIndex(room.store);
      room.version += 1;
      pushOpLog(
        room,
        { ops: batch, source: "user", version: room.version, at: Date.now(), clientOpId },
        config.opLogMaxSize,
      );
      room.dirty = true;
      scheduleSave(id, room);
      bus.publish(spaceId, id, {
        changes: batch,
        source: "user",
        version: room.version,
        originClientId: clientOpId,
      });

      return c.json({ ok: true });
    });
}
