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
import { computeExpansion, findEmptySlot, type Rect } from "../empty-space";
import { diffSchemas } from "./diff";
import { generateNodeIdServer } from "./identity";
import { assignBatchIndices } from "./index-key";

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
      kind: "elbow",
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
      labelColor: opts.overlayEntry?.labelColor ?? "black",
      fill: opts.overlayEntry?.fill ?? preset.style.fill ?? "none",
      dash: opts.overlayEntry?.dash ?? "draw",
      size: opts.overlayEntry?.size ?? "m",
      font: opts.overlayEntry?.font ?? "draw",
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
      didrawRole: opts.role,
      didrawSchemaParent: opts.parentId,
    },
  } as TLRecord;
}

// Conservative label metrics for our geo shapes (size "m", font "draw",
// scale 1 — fixed by makeGeoShape). Calibrated as UPPER bounds against live
// tldraw renders: 2 lines rendered 91.4px, 4 lines 150.8px.
const LABEL_CHAR_W = 13;
const LABEL_H_INSET = 32;
const LABEL_LINE_H = 42;
const LABEL_V_INSET = 16;

/**
 * Conservative estimate of a node's rendered height: tldraw grows geo shapes
 * vertically (growY) when the label wraps. Backend can't measure fonts, so we
 * overestimate — a sparser placement is safe, an overlapping one is not.
 */
export function estimateEffectiveHeight(label: string, w: number, baseH: number): number {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return baseH;

  const charsPerLine = Math.max(1, Math.floor((w - LABEL_H_INSET) / LABEL_CHAR_W));
  let lines = 0;
  let lineLen = 0;
  for (const word of words) {
    if (word.length > charsPerLine) {
      // Overlong word hard-wraps across multiple lines.
      lines += Math.ceil(word.length / charsPerLine);
      lineLen = word.length % charsPerLine || charsPerLine;
      continue;
    }
    if (lineLen === 0 || lineLen + 1 + word.length > charsPerLine) {
      lines += 1;
      lineLen = word.length;
    } else {
      lineLen += 1 + word.length;
    }
  }
  if (lines <= 1) return baseH;
  return Math.max(baseH, LABEL_V_INSET + lines * LABEL_LINE_H);
}

// ---- Schema-container constructor + group reconciliation (DRW-210) ----

// Паддинги контейнера вокруг членов — согласованы с layout.ts
// (CONTAINER_PAD_TOP/LR/BOT): верх крупнее под label контейнера.
const GROUP_PAD_TOP = 72;
const GROUP_PAD_LR = 20;
const GROUP_PAD_BOT = 20;

function makeContainerShape(opts: {
  groupName: string;
  label: string;
  parentId: string;
  direction?: "TB" | "LR" | "BT" | "RL";
  x: number;
  y: number;
  w: number;
  h: number;
}): TLRecord {
  return {
    id: shapeId(),
    typeName: "shape",
    type: "schema-container",
    x: opts.x,
    y: opts.y,
    parentId: opts.parentId,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      w: opts.w,
      h: opts.h,
      name: opts.label,
      // Frontend schema требует cardinal direction; inherited-маркер говорит
      // инференсу, что "TB" — структурный дефолт, не выбор пользователя
      // (зеркало routes/schema.ts makeSchemaContainerShape).
      direction: opts.direction ?? "TB",
      titlePosition: "inside-center",
      color: "grey",
      fill: "solid",
      dash: "dashed",
    },
    meta: {
      didrawSubgraph: true,
      didrawSubgraphId: opts.groupName,
      didrawSubgraphName: opts.label,
      didrawSchemaParent: opts.parentId,
      ...(opts.direction === undefined ? { didrawDirectionInherited: true } : {}),
    },
  } as TLRecord;
}

type GroupReconcileOpts = {
  store: Record<string, TLRecord | undefined>;
  frame: TLRecord;
  oldActions: SchemaAction[];
  newActions: SchemaAction[];
  batch: StoreChangeBatch;
  resolveShapeId: (nodeId: NodeId) => string | undefined;
};

/**
 * DRW-210: материализация schema-group на доске. Реконсиляция по ВСЕМ группам
 * нового состояния (а не только по диффу) — лечит legacy-комнаты, где группы
 * уже есть в raw, а контейнеров на доске нет. Контейнеры исчезнувших групп
 * удаляются (дети возвращаются во фрейм). Узлы визуально НЕ двигаются:
 * меняются только parentId + относительные координаты.
 *
 * Возвращает новые parent-relative позиции репарентнутых didraw-узлов — их
 * нужно отразить в didrawOverlays, иначе reload-hydrate вернёт узел на stale
 * координаты в чужом координатном пространстве.
 */
function reconcileGroups(
  opts: GroupReconcileOpts,
): Map<NodeId, { x: number; y: number }> {
  const { store, frame, oldActions, newActions, batch, resolveShapeId } = opts;
  const repositioned = new Map<NodeId, { x: number; y: number }>();

  const oldGroups = new Map<string, SchemaGroupAction>();
  for (const a of oldActions) {
    if (a.kind === "schema-group" && a.name) oldGroups.set(a.name, a);
  }
  const newGroups = new Map<string, SchemaGroupAction>();
  for (const a of newActions) {
    if (a.kind === "schema-group" && a.name) newGroups.set(a.name, a);
  }
  if (oldGroups.size === 0 && newGroups.size === 0) return repositioned;

  // Текущая (с учётом батча) версия записи.
  const cur = (sid: string): TLRecord | undefined =>
    batch.added[sid] ?? batch.updated[sid]?.[1] ?? store[sid];

  // Точечный патч: added-запись правится на месте, store-запись — через updated.
  const setShape = (
    sid: string,
    patch: Partial<TLRecord> & { props?: Record<string, unknown> },
  ): void => {
    const rec = cur(sid);
    if (!rec) return;
    const next = { ...rec, ...patch } as TLRecord;
    if (batch.added[sid]) {
      batch.added[sid] = next;
    } else {
      const orig = batch.updated[sid]?.[0] ?? store[sid];
      if (!orig) return;
      batch.updated[sid] = [orig, next];
    }
  };

  // Frame-space top-left записи (walk по parent-цепочке с учётом батча).
  const framePos = (sid: string): { x: number; y: number } | null => {
    let rec = cur(sid);
    if (!rec || rec.typeName !== "shape") return null;
    let x = typeof rec.x === "number" ? rec.x : 0;
    let y = typeof rec.y === "number" ? rec.y : 0;
    let hops = 0;
    while (rec.parentId !== frame.id && hops < MAX_FRAME_ANCESTRY_HOPS) {
      const parent = cur(rec.parentId as string);
      if (!parent || parent.typeName !== "shape") return null;
      x += typeof parent.x === "number" ? parent.x : 0;
      y += typeof parent.y === "number" ? parent.y : 0;
      rec = parent;
      hops++;
    }
    return rec.parentId === frame.id ? { x, y } : null;
  };

  const isSubgraphContainer = (rec: TLRecord | undefined): boolean =>
    !!rec &&
    (rec.meta as Record<string, unknown> | undefined)?.didrawSubgraph === true;

  // Контейнер группы: didrawSubgraphId (стабильный) или legacy-имя/label.
  const findContainerSid = (g: SchemaGroupAction): string | undefined => {
    const label = g.label ?? g.name ?? "";
    const match = (rec: TLRecord | undefined): boolean => {
      if (!isSubgraphContainer(rec)) return false;
      const m = (rec as TLRecord).meta as Record<string, unknown>;
      return (
        m.didrawSubgraphId === g.name ||
        m.didrawSubgraphName === g.name ||
        m.didrawSubgraphName === label
      );
    };
    for (const sid in batch.added) {
      if (match(batch.added[sid])) return sid;
    }
    for (const sid in store) {
      const rec = store[sid];
      if (!rec || rec.typeName !== "shape" || batch.removed[sid]) continue;
      if (!isWithinFrameSubtree(rec, frame.id, store)) continue;
      if (match(rec)) return sid;
    }
    return undefined;
  };

  const childrenOf = (contSid: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const sid in batch.added) {
      if (cur(sid)?.parentId === contSid) {
        out.push(sid);
        seen.add(sid);
      }
    }
    for (const sid in store) {
      if (seen.has(sid) || batch.removed[sid]) continue;
      const rec = cur(sid);
      if (rec?.typeName === "shape" && rec.parentId === contSid) out.push(sid);
    }
    return out;
  };

  const nodeIdOf = (sid: string): NodeId | undefined => {
    const m = cur(sid)?.meta as Record<string, unknown> | undefined;
    return typeof m?.didrawId === "string" ? (m.didrawId as NodeId) : undefined;
  };

  // ---- Создание/membership по всем группам нового состояния ----
  const memberOfNewGroup = new Set<NodeId>();
  for (const g of newGroups.values()) {
    for (const nid of g.nodeIds) memberOfNewGroup.add(nid);
  }

  for (const g of newGroups.values()) {
    // Члены с реальными шейпами и frame-space габаритами.
    const members: Array<{
      sid: string;
      nid: NodeId;
      x: number;
      y: number;
      w: number;
      h: number;
    }> = [];
    for (const nid of g.nodeIds) {
      const sid = resolveShapeId(nid);
      if (!sid || batch.removed[sid]) continue;
      const rec = cur(sid);
      if (!rec) continue;
      const pos = framePos(sid);
      if (!pos) continue;
      const p = (rec.props ?? {}) as { w?: number; h?: number; growY?: number };
      const w = typeof p.w === "number" ? p.w : 220;
      const h =
        (typeof p.h === "number" ? p.h : 80) +
        (typeof p.growY === "number" ? p.growY : 0);
      members.push({ sid, nid, x: pos.x, y: pos.y, w, h });
    }
    if (members.length === 0) continue;

    // Clamp у нуля: контейнер не должен вылезать за верх/лево фрейма — tldraw
    // клипует детей фрейма, и label контейнера срезался бы (live-находка rc9).
    const minX = Math.max(0, Math.min(...members.map((m) => m.x)) - GROUP_PAD_LR);
    const minY = Math.max(0, Math.min(...members.map((m) => m.y)) - GROUP_PAD_TOP);
    const maxX = Math.max(...members.map((m) => m.x + m.w)) + GROUP_PAD_LR;
    const maxY = Math.max(...members.map((m) => m.y + m.h)) + GROUP_PAD_BOT;

    let contSid = findContainerSid(g);
    let contX: number;
    let contY: number;
    if (!contSid) {
      const rec = makeContainerShape({
        groupName: g.name as string,
        label: g.label ?? (g.name as string),
        parentId: frame.id,
        direction: g.direction,
        x: minX,
        y: minY,
        w: maxX - minX,
        h: maxY - minY,
      });
      batch.added[rec.id] = rec;
      contSid = rec.id;
      contX = minX;
      contY = minY;
    } else {
      // Grow-only покрытие членов; рост влево/вверх сдвигает origin и
      // компенсирует относительные координаты СУЩЕСТВУЮЩИХ детей.
      const contRec = cur(contSid);
      if (!contRec) continue;
      const cpos = framePos(contSid);
      if (!cpos) continue;
      const p = (contRec.props ?? {}) as { w?: number; h?: number };
      const curW = typeof p.w === "number" ? p.w : 300;
      const curH = typeof p.h === "number" ? p.h : 200;
      const newX = Math.min(cpos.x, minX);
      const newY = Math.min(cpos.y, minY);
      const newW = Math.max(cpos.x + curW, maxX) - newX;
      const newH = Math.max(cpos.y + curH, maxY) - newY;
      const dx = newX - cpos.x; // ≤ 0
      const dy = newY - cpos.y;
      if (dx !== 0 || dy !== 0 || newW !== curW || newH !== curH) {
        if (dx !== 0 || dy !== 0) {
          for (const childSid of childrenOf(contSid)) {
            const childRec = cur(childSid);
            if (!childRec) continue;
            const nx = (typeof childRec.x === "number" ? childRec.x : 0) - dx;
            const ny = (typeof childRec.y === "number" ? childRec.y : 0) - dy;
            setShape(childSid, { x: nx, y: ny });
            const cnid = nodeIdOf(childSid);
            if (cnid) repositioned.set(cnid, { x: nx, y: ny });
          }
        }
        // Контейнер группы — прямой ребёнок фрейма: его x/y уже в frame-space.
        setShape(contSid, {
          x: (typeof contRec.x === "number" ? contRec.x : 0) + dx,
          y: (typeof contRec.y === "number" ? contRec.y : 0) + dy,
          props: { ...(contRec.props ?? {}), w: newW, h: newH },
        });
      }
      contX = newX;
      contY = newY;
    }

    // Репарент членов: меняем только parentId + относительные координаты —
    // абсолютная позиция на доске сохраняется.
    for (const m of members) {
      const rec = cur(m.sid);
      if (!rec || rec.parentId === contSid) continue; // уже внутри
      const relX = m.x - contX;
      const relY = m.y - contY;
      setShape(m.sid, { parentId: contSid, x: relX, y: relY });
      repositioned.set(m.nid, { x: relX, y: relY });
    }
  }

  // ---- Узлы, покинувшие группы: возврат во фрейм ----
  for (const g of oldGroups.values()) {
    for (const nid of g.nodeIds) {
      if (memberOfNewGroup.has(nid)) continue; // переехал в другую группу — выше
      const sid = resolveShapeId(nid);
      if (!sid || batch.removed[sid]) continue;
      const rec = cur(sid);
      if (!rec || rec.parentId === frame.id) continue;
      // Не трогаем ручные вложения — возвращаем только из subgraph-контейнеров.
      if (!isSubgraphContainer(cur(rec.parentId as string))) continue;
      const pos = framePos(sid);
      if (!pos) continue;
      setShape(sid, { parentId: frame.id, x: pos.x, y: pos.y });
      repositioned.set(nid, { x: pos.x, y: pos.y });
    }
  }

  // ---- Контейнеры исчезнувших групп: удалить, детей вернуть во фрейм ----
  for (const [name, g] of oldGroups) {
    if (newGroups.has(name)) continue;
    const contSid = findContainerSid(g);
    if (!contSid || batch.added[contSid]) continue;
    const contRec = store[contSid];
    if (!contRec) continue;
    for (const childSid of childrenOf(contSid)) {
      const pos = framePos(childSid);
      if (!pos) continue;
      setShape(childSid, { parentId: frame.id, x: pos.x, y: pos.y });
      const cnid = nodeIdOf(childSid);
      if (cnid) repositioned.set(cnid, { x: pos.x, y: pos.y });
    }
    batch.removed[contSid] = contRec;
    delete batch.updated[contSid];
  }

  return repositioned;
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

// ---- Extract NodeIds from frame subtree ----

/** Max ancestry hops when walking the parentId chain (cycle guard). */
const MAX_FRAME_ANCESTRY_HOPS = 64;

/**
 * True if `shape` is a direct OR indirect child of `frameId`.
 *
 * Nodes nested inside schema-containers (mermaid subgraphs) have
 * `parentId === <container id>`, not the frame — yet they ARE part of the
 * frame's schema. We must resolve them too, otherwise edges touching a
 * container-nested endpoint silently fail to materialize an arrow.
 */
function isWithinFrameSubtree(
  shape: TLRecord,
  frameId: string,
  store: Record<string, TLRecord | undefined>,
): boolean {
  let currentParent: string | undefined = shape.parentId;
  let hops = 0;
  while (currentParent && hops < MAX_FRAME_ANCESTRY_HOPS) {
    if (currentParent === frameId) return true;
    const parent = store[currentParent];
    if (!parent) return false;
    currentParent = parent.parentId;
    hops++;
  }
  return false;
}

function extractExistingNodeIds(
  frame: TLRecord,
  store: Record<string, TLRecord | undefined>,
): Set<NodeId> {
  const ids = new Set<NodeId>();
  for (const id in store) {
    const r = store[id];
    if (!r || r.typeName !== "shape") continue;
    if (!isWithinFrameSubtree(r, frame.id, store)) continue;
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    if (typeof meta.didrawId === "string") {
      ids.add(meta.didrawId);
    }
  }
  return ids;
}

/** Find the tldraw shape id for a given nodeId within the frame subtree. */
function findShapeByNodeId(
  nodeId: NodeId,
  frame: TLRecord,
  store: Record<string, TLRecord | undefined>,
): string | undefined {
  for (const id in store) {
    const r = store[id];
    if (!r || r.typeName !== "shape") continue;
    if (!isWithinFrameSubtree(r, frame.id, store)) continue;
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

  // Smart placement (DRW-178 wiring): position newly-added nodes in free space
  // inside the frame WITHOUT repositioning existing children. If no slot fits,
  // grow the frame and place the node at the new (positive) edge. New-node-only,
  // so the user's arrangement is preserved — incremental inserts never trigger a
  // full re-layout.
  let groupRepositioned = new Map<NodeId, { x: number; y: number }>();
  {
    const PADDING = 24;
    const fProps = (frame.props ?? {}) as { w?: number; h?: number };
    let frameW = typeof fProps.w === "number" ? fProps.w : 0;
    let frameH = typeof fProps.h === "number" ? fProps.h : 0;

    if (frameW > 0 && frameH > 0) {
      // Occupants: existing direct children of the frame (non-arrow, with bounds).
      const occupants: Rect[] = [];
      for (const sid in store) {
        const s = store[sid];
        if (!s || s.typeName !== "shape") continue;
        if (s.parentId !== frame.id) continue;
        if (s.type === "arrow") continue;
        const p = (s.props ?? {}) as { w?: number; h?: number; growY?: number };
        const w = typeof p.w === "number" ? p.w : 0;
        // Effective footprint: tldraw grows text-bearing shapes via growY —
        // the declared h underestimates what's actually rendered (DRW-205).
        const h =
          (typeof p.h === "number" ? p.h : 0) + (typeof p.growY === "number" ? p.growY : 0);
        if (w <= 0 || h <= 0) continue;
        occupants.push({
          x: typeof s.x === "number" ? s.x : 0,
          y: typeof s.y === "number" ? s.y : 0,
          w,
          h,
        });
      }

      // Frame-space center of a shape: child coords are parent-relative, so a
      // container-nested neighbor needs its ancestors' offsets accumulated.
      const frameSpaceCenter = (sid: string): Slot | null => {
        let s = batch.added[sid] ?? store[sid];
        if (!s || s.typeName !== "shape") return null;
        const p = (s.props ?? {}) as { w?: number; h?: number; growY?: number };
        const w = typeof p.w === "number" ? p.w : 0;
        const h =
          (typeof p.h === "number" ? p.h : 0) + (typeof p.growY === "number" ? p.growY : 0);
        let x = typeof s.x === "number" ? s.x : 0;
        let y = typeof s.y === "number" ? s.y : 0;
        let hops = 0;
        while (s.parentId !== frame.id && hops < MAX_FRAME_ANCESTRY_HOPS) {
          const parent = batch.added[s.parentId] ?? store[s.parentId];
          if (!parent || parent.typeName !== "shape") return null;
          x += typeof parent.x === "number" ? parent.x : 0;
          y += typeof parent.y === "number" ? parent.y : 0;
          s = parent;
          hops++;
        }
        if (s.parentId !== frame.id) return null;
        return { x: x + w / 2, y: y + h / 2 };
      };

      let frameGrew = false;
      const positioned = new Set<string>();
      for (const addedNode of diff.added) {
        // A user-pinned overlay position always wins — never relocate it.
        if (oldOverlays[addedNode.nodeId]?.position) continue;
        const sid = resolveShapeId(addedNode.nodeId);
        if (!sid) continue;
        const shape = batch.added[sid];
        if (!shape || shape.parentId !== frame.id) continue;
        const sp = (shape.props ?? {}) as { w?: number; h?: number };
        const nominalW = typeof sp.w === "number" ? sp.w : 220;
        const nominalH = typeof sp.h === "number" ? sp.h : 80;
        // Reserve room for the rendered label: tldraw will grow the shape
        // (growY) when the label wraps, so the slot must fit the ESTIMATED
        // height, not the nominal one (DRW-205 S2 overlap repro).
        const displayLabel = oldOverlays[addedNode.nodeId]?.label ?? addedNode.label;
        const size = {
          w: nominalW,
          h: estimateEffectiveHeight(displayLabel, nominalW, nominalH),
        };

        // Anchor: centroid of linked neighbors that already have a concrete
        // position (existing shapes, or new ones placed earlier in this
        // batch) — pulls the node towards its connections (DRW-205).
        const neighborCenters: Slot[] = [];
        for (const e of diff.edgesAdded) {
          let otherId: NodeId | null = null;
          if (e.from === addedNode.nodeId) otherId = e.to;
          else if (e.to === addedNode.nodeId) otherId = e.from;
          if (!otherId) continue;
          const osid = resolveShapeId(otherId);
          if (!osid) continue;
          // Skip batch-new neighbors not yet positioned — their (0,0)
          // default would skew the centroid to the frame corner.
          if (batch.added[osid] && !positioned.has(osid)) continue;
          const center = frameSpaceCenter(osid);
          if (center) neighborCenters.push(center);
        }
        const anchor =
          neighborCenters.length > 0
            ? {
                x: neighborCenters.reduce((a, c) => a + c.x, 0) / neighborCenters.length,
                y: neighborCenters.reduce((a, c) => a + c.y, 0) / neighborCenters.length,
              }
            : undefined;

        const slot = findEmptySlot({ w: frameW, h: frameH }, occupants, size, PADDING, anchor);
        let pos: { x: number; y: number };
        if (slot) {
          pos = slot;
        } else {
          // Grow along the shorter side to keep the frame balanced; TB/LR both
          // place the node at a positive edge, so existing children don't move.
          const dir = frameW >= frameH ? "TB" : "LR";
          const exp = computeExpansion({ w: frameW, h: frameH }, size, PADDING, dir);
          pos = exp.position;
          frameW += exp.dw;
          frameH += exp.dh;
          frameGrew = true;
        }
        batch.added[sid] = { ...shape, x: pos.x, y: pos.y };
        occupants.push({ x: pos.x, y: pos.y, w: size.w, h: size.h });
        positioned.add(sid);
      }

      // DRW-210: материализация schema-group — контейнеры на доске, репарент
      // членов (raw-сторона уже согласована генератором). Бежит ПОСЛЕ
      // placement (новые члены уже расставлены в frame-space) и ДО frame-fit
      // (фрейм должен покрыть новые/выросшие контейнеры).
      groupRepositioned = reconcileGroups({
        store,
        frame,
        oldActions,
        newActions,
        batch,
        resolveShapeId,
      });

      // Frame-fit (grow-only, DRW-205 AC#3): every child's EFFECTIVE
      // footprint must stay inside the frame, else tldraw clips it at the
      // border. Text growth lands client-side AFTER apply (renames, new
      // nodes) — reserve the estimate for those; for untouched children the
      // persisted h+growY is ground truth. Children never move; the frame
      // only extends down/right.
      const renamedIds = new Set(diff.renamed.map((r) => r.nodeId));
      const childRecords: TLRecord[] = [];
      for (const sid in store) {
        const s = store[sid];
        if (!s || s.typeName !== "shape" || batch.removed[sid]) continue;
        childRecords.push(batch.updated[sid]?.[1] ?? s);
      }
      for (const sid in batch.added) {
        const s = batch.added[sid];
        if (s && s.typeName === "shape") childRecords.push(s);
      }
      let requiredW = frameW;
      let requiredH = frameH;
      for (const child of childRecords) {
        if (child.parentId !== frame.id || child.type === "arrow") continue;
        const p = (child.props ?? {}) as { w?: number; h?: number; growY?: number };
        const w = typeof p.w === "number" ? p.w : 0;
        const baseH = typeof p.h === "number" ? p.h : 0;
        if (w <= 0 || baseH <= 0) continue;
        let effH = baseH + (typeof p.growY === "number" ? p.growY : 0);
        const meta = (child.meta ?? {}) as Record<string, unknown>;
        const did = typeof meta.didrawId === "string" ? meta.didrawId : "";
        const label = typeof meta.didrawLabel === "string" ? meta.didrawLabel : "";
        if (renamedIds.has(did) || batch.added[child.id]) {
          effH = Math.max(effH, estimateEffectiveHeight(label, w, baseH));
        }
        const x = typeof child.x === "number" ? child.x : 0;
        const y = typeof child.y === "number" ? child.y : 0;
        requiredW = Math.max(requiredW, x + w + PADDING);
        requiredH = Math.max(requiredH, y + effH + PADDING);
      }
      if (requiredW > frameW || requiredH > frameH) {
        frameW = requiredW;
        frameH = requiredH;
        frameGrew = true;
      }

      if (frameGrew) {
        batch.updated[frame.id] = [
          frame,
          { ...frame, props: { ...(frame.props ?? {}), w: frameW, h: frameH } },
        ];
      }
    }
  }

  // Step 8: Apply overlays to added shapes (positions, colors).
  // (Already applied in makeGeoShape via overlayEntry parameter above.)

  // Step 9: Count orphaned overlays (overlays for removed NodeIds).
  let orphanedOverlays = 0;
  const newOverlays: Record<NodeId, OverlayEntry> = { ...oldOverlays };

  // DRW-210: позиции репарентнутых членов групп — в overlays (новое
  // parent-relative пространство; stale frame-координаты дали бы прыжок
  // узла на reload-hydrate).
  for (const [nid, pos] of groupRepositioned) {
    newOverlays[nid] = { ...(newOverlays[nid] ?? {}), position: pos };
  }

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

      // Restyle the live shape (DRW-205): historically overlay style landed
      // only in didrawOverlays and was consumed at shape CREATION — set-overlay
      // on an existing node silently changed nothing on the board. An explicit
      // set-overlay style is targeted user intent (expressed through the
      // agent) and always applies; styleOwnedBy protects only against
      // INCIDENTAL overwrites (role presets, re-imports). NB: the frontend
      // stamps styleOwnedBy:"user" even on position-only drags, so gating on
      // it here would block restyle of any node the user has ever moved.
      const stylePatch: Record<string, unknown> = {};
      if (a.overlay.color) stylePatch.color = a.overlay.color;
      if (a.overlay.labelColor) stylePatch.labelColor = a.overlay.labelColor;
      if (a.overlay.fill) stylePatch.fill = a.overlay.fill;
      if (a.overlay.dash) stylePatch.dash = a.overlay.dash;
      if (a.overlay.size) stylePatch.size = a.overlay.size;
      if (a.overlay.font) stylePatch.font = a.overlay.font;
      if (Object.keys(stylePatch).length > 0) {
        const sid = resolveShapeId(a.nodeId);
        const baseRec = sid ? (batch.added[sid] ?? batch.updated[sid]?.[1] ?? store[sid]) : undefined;
        if (sid && baseRec) {
          const next = {
            ...baseRec,
            props: { ...(baseRec.props ?? {}), ...stylePatch },
          } as TLRecord;
          if (batch.added[sid]) {
            batch.added[sid] = next;
          } else {
            const orig = batch.updated[sid]?.[0] ?? store[sid];
            if (orig) batch.updated[sid] = [orig, next];
          }
        }
      }
    }
  }

  // Step 10: Compute destructiveScore.
  const oldNodeCount = currentNodes.size;
  const removedCount = diff.removed.length;
  const destructiveScore =
    oldNodeCount > 0 ? removedCount / oldNodeCount : 0;

  const addedNodeIds = diff.added.map((n) => n.nodeId);
  const removedNodeIds = [...diff.removed];

  // DRW-141: assign unique fractional indices so newly added shapes don't all
  // collide on the hardcoded "a1" (which breaks native tldraw duplicate with
  // `Error: a1 >= a1`). Must run AFTER batch is fully built and BEFORE return.
  assignBatchIndices(batch, store);

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
