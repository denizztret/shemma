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

import type { OverlayEntry, SchemaAction } from "@shemma/domain";
import type { NodeId } from "@shemma/domain";
import { Hono } from "hono";
import { config } from "../config";
import { applySchemaActions } from "../domain/schema/apply";
import { isV2Room, roomSuffixLength } from "../domain/schema/detect";
import { generateNodeIdServer, nodeIdFromLabel } from "../domain/schema/identity";
import { parseMermaidFlowchart } from "../domain/schema/mermaid-parser";
import type { MermaidDirection } from "../domain/schema/mermaid-parser";
import { generateMermaid } from "../domain/schema/mermaid-generator";
import { buildCanvasView } from "../domain/schema/view";
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
  try {
    const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
    return randomBytes(5).toString("hex");
  } catch {
    return Math.random().toString(36).slice(2, 12);
  }
}

function frameShapeId(): string {
  return `shape:f_${randHex()}`;
}

function childShapeId(): string {
  return `shape:${randHex()}`;
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
    const props = (r.props ?? {}) as { w?: unknown; y?: unknown };
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

function makeChildShape(opts: {
  nodeId: NodeId;
  label: string;
  role: Role;
  parentId: string;
  overlay?: OverlayEntry;
}): TLRecord {
  const preset = rolePreset(opts.role) ?? { style: { color: "black", fill: "none" }, defaultW: 220, defaultH: 80 };
  const x = opts.overlay?.position?.x ?? 0;
  const y = opts.overlay?.position?.y ?? 0;
  const color = opts.overlay?.color ?? preset.style?.color ?? "black";

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
      labelColor: "black",
      fill: preset.style?.fill ?? "none",
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
      didrawLabel: opts.label,
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

type SchemaCreateErrorResponse = {
  ok: false;
  error?: string;
  errors?: Array<{ actionIndex: number; code: string; message: string }>;
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
  error?: string;
  errors?: Array<{ actionIndex: number; code: string; message: string }>;
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
      if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
      const id = rv.id;

      const body = (await c.req.json().catch(() => null)) as {
        label?: string;
        raw?: string;
        actions?: SchemaAction[];
        clientOpId?: string;
      } | null;

      if (!body) {
        return c.json(
          { ok: false, error: "expected JSON body {label, raw?} or {label, actions?}" } satisfies SchemaCreateErrorResponse,
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

      if (body.raw !== undefined) {
        // Mode A: parse mermaid RAW.
        if (typeof body.raw !== "string" || body.raw.trim().length === 0) {
          return c.json(
            { ok: false, error: "field 'raw' must be a non-empty mermaid string" } satisfies SchemaCreateErrorResponse,
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
              error: parseResult.code,
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
      } else if (body.actions !== undefined) {
        // Mode B: caller-provided actions.
        if (!Array.isArray(body.actions)) {
          return c.json(
            { ok: false, error: "field 'actions' must be an array" } satisfies SchemaCreateErrorResponse,
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
          { ok: false, error: "body must contain either 'raw' (mermaid string) or 'actions' array" } satisfies SchemaCreateErrorResponse,
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

      // Create child shapes for each node.
      const nodeIds: NodeId[] = [];
      const nodeDefs = extractNodeDefs(parsedActions);

      for (const def of nodeDefs) {
        const childShape = makeChildShape({
          nodeId: def.nodeId,
          label: def.label,
          role: def.role,
          parentId: frameId,
        });
        batch.added[childShape.id] = childShape;
        nodeIds.push(def.nodeId);
      }

      // Auto-upgrade: set room.meta.didrawProtocol = "v2" if not already v2.
      // This is the key side-effect that makes v2 auto-upgrade work per plan.
      if (!isV2Room(room)) {
        room.meta = { ...(room.meta ?? {}), didrawProtocol: "v2" };
      }

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
      if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
      const id = rv.id;
      const frameId = c.req.param("frameId");

      const body = (await c.req.json().catch(() => null)) as {
        actions?: SchemaAction[];
        clientOpId?: string;
      } | null;

      if (!body || !Array.isArray(body.actions)) {
        return c.json(
          { ok: false, error: "expected {actions: SchemaAction[], clientOpId?}" } satisfies SchemaPatchErrorResponse,
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
          { ok: false, error: "legacy-room-not-v2" } satisfies SchemaPatchErrorResponse,
          422,
        );
      }

      // Lookup frame.
      const store = room.store.store as Record<string, TLRecord | undefined>;
      const frame = store[frameId];
      if (!frame || frame.typeName !== "shape") {
        return c.json(
          { ok: false, error: "frame-not-found" } satisfies SchemaPatchErrorResponse,
          404,
        );
      }
      if (frame.meta?.didrawSchemaFrame !== true) {
        return c.json(
          { ok: false, error: "not-schema-frame" } satisfies SchemaPatchErrorResponse,
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
      if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
      const id = rv.id;
      const frameId = c.req.param("frameId");

      const body = (await c.req.json().catch(() => null)) as {
        nodeId?: string;
        overlay?: OverlayEntry;
        clientOpId?: string;
      } | null;

      if (!body || typeof body.nodeId !== "string" || !body.overlay || typeof body.overlay !== "object") {
        return c.json({ ok: false, error: "expected {nodeId: string, overlay: OverlayEntry, clientOpId?}" }, 400);
      }

      const { nodeId, overlay, clientOpId } = body;

      const { rooms, scheduleSave, space } = bundleForRequest(c);
      const spaceId = space.id;
      const room = await rooms.get(id);

      // v2 check.
      if (!isV2Room(room)) {
        return c.json({ ok: false, error: "legacy-room-not-v2" }, 422);
      }

      // Lookup frame.
      const store = room.store.store as Record<string, TLRecord | undefined>;
      const frame = store[frameId];
      if (!frame || frame.typeName !== "shape") {
        return c.json({ ok: false, error: "frame-not-found" }, 404);
      }
      if (frame.meta?.didrawSchemaFrame !== true) {
        return c.json({ ok: false, error: "not-schema-frame" }, 422);
      }

      // Get current overlays.
      const currentOverlays = (frame.meta?.didrawOverlays ?? {}) as Record<NodeId, OverlayEntry>;

      // Ownership guard: если существующий overlay user-owned и входящий — нет, блокируем.
      const existing = currentOverlays[nodeId];
      if (
        existing?.styleOwnedBy === "user" &&
        (overlay as OverlayEntry).styleOwnedBy !== "user"
      ) {
        return c.json({ ok: false, error: "overlay-user-owned" }, 422);
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
