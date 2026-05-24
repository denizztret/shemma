// apps/backend/src/migrate-v2.ts
// Lossless v2 → v3 envelope migrator. Spec §9.
//
// V2 канва (nodes/edges/groups) маппится в tldraw 5.x records:
//   node(rect|ellipse|diamond) → shape (geo, with props.geo)
//   node(sticky) → shape (note)
//   node(text) → shape (text)
//   group → shape (frame); children получают parentId = frame.id
//   edge → shape (arrow) + 2 binding records (start/end)
//
// `didrawName / role / connectionKind / pinned / position / styleOwnedBy`
// переезжают из старого meta в новый meta (с переименованием `name → didrawName`).
//
// Backend без tldraw runtime (spec §12): все TLRecord конструируются как `as any`,
// валидируются frontend'ом при `loadSnapshot()`.

import type { EnvelopeV3 } from "./envelope";
import type { TLRecord, TLStoreSnapshot } from "./store-types";
import type { Prompt } from "./types";

type V2Node = {
  id: string;
  kind: "rect" | "ellipse" | "diamond" | "sticky" | "text";
  label?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  style?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

type V2Endpoint =
  | { kind: "node"; id: string }
  | { kind: "point"; x: number; y: number };

type V2Edge = {
  id: string;
  from: V2Endpoint;
  to: V2Endpoint;
  label?: string;
  style?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

type V2Group = {
  id: string;
  kind: "frame" | "group";
  children: string[];
  label?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  style?: Record<string, unknown>;
};

type V2Canvas = {
  version: 1;
  nodes: V2Node[];
  edges: V2Edge[];
  groups: V2Group[];
};

export type V2Envelope = {
  schemaVersion: 2 | 1;
  roomId: string;
  version: number;
  lastTouched: string;
  elementCount: number;
  canvas: V2Canvas;
  prompts: Prompt[];
  opLog?: unknown[];
};

// ─── id helpers ────────────────────────────────────────────────────────────

function rand(): string {
  return Math.random().toString(36).slice(2, 12);
}

function shapeId(): string {
  return `shape:${rand()}`;
}

function bindingId(): string {
  return `binding:${rand()}`;
}

// ─── defaults (re-exported для makeRoomState() в Task 11) ──────────────────

export function defaultDocument(): TLRecord {
  return {
    id: "document:document",
    typeName: "document",
    gridSize: 10,
    name: "",
    meta: {},
  } as any;
}

export function defaultPage(): TLRecord {
  return {
    id: "page:page",
    typeName: "page",
    name: "Page 1",
    index: "a1",
    meta: {},
  } as any;
}

export function defaultSchema() {
  return {
    schemaVersion: 1,
    storeVersion: 4,
    recordVersions: {
      shape: {
        version: 4,
        subTypeVersions: {
          geo: 9,
          arrow: 5,
          note: 7,
          text: 2,
          frame: 0,
          draw: 2,
          line: 4,
          image: 4,
          video: 2,
          embed: 4,
          bookmark: 2,
          highlight: 1,
        },
      },
      binding: { version: 0, subTypeVersions: { arrow: 0 } },
      page: { version: 1 },
      document: { version: 2 },
      asset: {
        version: 1,
        subTypeVersions: { image: 5, video: 5, bookmark: 2 },
      },
      instance: { version: 25 },
      pointer: { version: 1 },
      camera: { version: 1 },
      instance_page_state: { version: 5 },
      instance_presence: { version: 6 },
    },
  };
}

// ─── kind mapping ──────────────────────────────────────────────────────────

const KIND_TO_GEO: Record<string, "rectangle" | "ellipse" | "diamond"> = {
  rect: "rectangle",
  ellipse: "ellipse",
  diamond: "diamond",
};

// ─── text → richText (tldraw 5.x ProseMirror doc shape) ───────────────────

function textToRichText(label: string): unknown {
  if (!label) return { type: "doc", content: [{ type: "paragraph" }] };
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: label }] },
    ],
  };
}

// ─── record converters ────────────────────────────────────────────────────

function nodeToShape(n: V2Node, id: string): TLRecord {
  // Извлекаем didrawName: prefer meta.name; fallback — strip "shape:e_" prefix.
  const didrawName: string =
    (typeof n.meta?.name === "string" ? (n.meta.name as string) : undefined) ??
    (n.id.startsWith("shape:e_") ? n.id.slice("shape:e_".length) : n.id);

  const meta: Record<string, unknown> = { didrawName, ...(n.meta ?? {}) };
  delete (meta as any).name; // унифицируем имя поля

  if (n.kind === "sticky") {
    return {
      id,
      typeName: "shape",
      type: "note",
      x: n.x,
      y: n.y,
      parentId: "page:page",
      index: "a1",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: {
        color: "yellow",
        size: "m",
        font: "draw",
        align: "middle",
        verticalAlign: "middle",
        growY: 0,
        fontSizeAdjustment: 0,
        url: "",
        scale: 1,
        richText: textToRichText(n.label ?? ""),
      },
      meta,
    } as any;
  }

  if (n.kind === "text") {
    return {
      id,
      typeName: "shape",
      type: "text",
      x: n.x,
      y: n.y,
      parentId: "page:page",
      index: "a1",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: {
        color: "black",
        size: "m",
        font: "draw",
        textAlign: "start",
        w: n.w ?? 100,
        autoSize: true,
        scale: 1,
        richText: textToRichText(n.label ?? ""),
      },
      meta,
    } as any;
  }

  // rect | ellipse | diamond → geo
  return {
    id,
    typeName: "shape",
    type: "geo",
    x: n.x,
    y: n.y,
    parentId: "page:page",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      w: n.w ?? 100,
      h: n.h ?? 60,
      geo: KIND_TO_GEO[n.kind] ?? "rectangle",
      color: "black",
      labelColor: "black",
      fill: "none",
      dash: "draw",
      size: "m",
      font: "draw",
      align: "middle",
      verticalAlign: "middle",
      growY: 0,
      url: "",
      scale: 1,
      richText: textToRichText(n.label ?? ""),
    },
    meta,
  } as any;
}

function groupToFrame(g: V2Group, id: string): TLRecord {
  const didrawName: string = g.id.startsWith("shape:e_")
    ? g.id.slice("shape:e_".length)
    : g.id;
  return {
    id,
    typeName: "shape",
    type: "frame",
    x: g.x ?? 0,
    y: g.y ?? 0,
    parentId: "page:page",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      w: g.w ?? 400,
      h: g.h ?? 300,
      name: g.label ?? "",
    },
    meta: { didrawName },
  } as any;
}

function edgeToArrow(e: V2Edge, id: string): TLRecord {
  const kind = (e.meta as any)?.kind ?? "sync";
  return {
    id,
    typeName: "shape",
    type: "arrow",
    x: 0,
    y: 0,
    parentId: "page:page",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      kind: "arc",
      color: "black",
      labelColor: "black",
      fill: "none",
      dash: (e.style as any)?.dashed ? "dashed" : "draw",
      size: "m",
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
      font: "draw",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      bend: 0,
      text: "",
      labelPosition: 0.5,
      scale: 1,
      richText: textToRichText(e.label ?? ""),
    },
    meta: { connectionKind: kind, ...(e.meta ?? {}) },
  } as any;
}

function arrowBinding(
  arrowId: string,
  toShape: string,
  terminal: "start" | "end",
): TLRecord {
  return {
    id: bindingId(),
    typeName: "binding",
    type: "arrow",
    fromId: arrowId,
    toId: toShape,
    props: {
      terminal,
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: false,
    },
    meta: {},
  } as any;
}

// ─── main entry ───────────────────────────────────────────────────────────

export function migrateV2ToV3(v2: V2Envelope): EnvelopeV3 {
  const store: Record<string, TLRecord> = {};
  store["document:document"] = defaultDocument();
  store["page:page"] = defaultPage();

  // Map старого id → новый id (для разрешения ссылок в groups/edges).
  const oldIdToNewId = new Map<string, string>();

  // 1. nodes → shapes
  for (const n of v2.canvas.nodes ?? []) {
    const id = shapeId();
    oldIdToNewId.set(n.id, id);
    store[id] = nodeToShape(n, id);
  }

  // 2. groups → frames + reparent children
  for (const g of v2.canvas.groups ?? []) {
    const id = shapeId();
    oldIdToNewId.set(g.id, id);
    store[id] = groupToFrame(g, id);
    for (const childOldId of g.children) {
      const childNewId = oldIdToNewId.get(childOldId);
      if (childNewId && store[childNewId]) {
        store[childNewId] = { ...store[childNewId], parentId: id };
      }
    }
  }

  // 3. edges → arrows + bindings
  for (const e of v2.canvas.edges ?? []) {
    const id = shapeId();
    oldIdToNewId.set(e.id, id);
    store[id] = edgeToArrow(e, id);
    if (e.from.kind === "node") {
      const toId = oldIdToNewId.get(e.from.id);
      if (toId) {
        const b = arrowBinding(id, toId, "start");
        store[b.id] = b;
      }
    }
    if (e.to.kind === "node") {
      const toId = oldIdToNewId.get(e.to.id);
      if (toId) {
        const b = arrowBinding(id, toId, "end");
        store[b.id] = b;
      }
    }
  }

  const snapshot: TLStoreSnapshot = {
    schema: defaultSchema() as any,
    store,
  };

  return {
    schemaVersion: 3,
    roomId: v2.roomId,
    version: v2.version,
    lastTouched: v2.lastTouched,
    elementCount: Object.values(store).filter((r) => r.typeName === "shape").length,
    shemma: {
      didrawVersion: "0.4.0",
      createdAt: new Date().toISOString(),
    },
    store: snapshot,
    prompts: v2.prompts,
    opLog: [],
  };
}
