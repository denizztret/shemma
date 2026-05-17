// apps/backend/src/domain/context.ts
// Phase 3.0: token-cheap view-builder поверх TLStoreSnapshot. AI-friendly
// snapshot БЕЗ геометрии по умолчанию (≤8KB на 100 элементов). Backend
// читает opaque TLRecord-структуры, никаких @tldraw/* импортов.

import type { ConnectionKind, Role } from "@shemma/domain";
import type { TLRecord, TLStoreSnapshot } from "../store-types";
import type { Prompt } from "../types";

export type DomainElementType = "shape" | "connection" | "group" | "note";

export type DomainElement = {
  id: string;
  type: DomainElementType;
  label?: string;
  role?: Role;
  connectionKind?: ConnectionKind;
  from?: string;
  to?: string;
  children?: string[];
  pinned?: boolean;
  bounds?: { x: number; y: number; w: number; h: number };
};

export type DomainView = {
  version: number;
  diffSince?: number;
  elements: DomainElement[];
  pendingPrompts?: Prompt[];
};

// ProseMirror doc → plain text. Walks doc.content[].content[].text and joins.
// Tolerant к null/undefined и неправильной структуре — НЕ кидает.
export function richTextToString(rt: unknown): string {
  if (!rt || typeof rt !== "object") return "";
  const root = rt as { content?: unknown };
  const blocks = Array.isArray(root.content) ? root.content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const inner = (block as { content?: unknown }).content;
    if (!Array.isArray(inner)) continue;
    for (const node of inner) {
      if (!node || typeof node !== "object") continue;
      const text = (node as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

function deriveType(shape: TLRecord): DomainElementType {
  const t = shape.type;
  if (t === "frame") return "group";
  if (t === "arrow") return "connection";
  if (t === "note") return "note";
  return "shape";
}

function elementIdOf(shape: TLRecord): string {
  const name = shape.meta?.didrawName;
  return typeof name === "string" && name.length > 0 ? name : shape.id;
}

export type BuildContextOpts = {
  since?: number;
  includeGeometry?: boolean;
};

export function buildContext(
  snapshot: TLStoreSnapshot,
  opts: BuildContextOpts = {},
  version = 0,
): DomainView {
  const records = snapshot.store ?? {};
  const shapes: TLRecord[] = [];
  const bindings: TLRecord[] = [];

  for (const id in records) {
    const r = records[id];
    if (!r) continue;
    if (r.typeName === "shape") shapes.push(r);
    else if (r.typeName === "binding") bindings.push(r);
  }

  // Индекс shape.id → element.id (didrawName or fallback shape.id).
  // Нужен для arrow from/to и frame children.
  const idToElementId = new Map<string, string>();
  for (const s of shapes) idToElementId.set(s.id, elementIdOf(s));

  // children index: frameId → [elementId, ...]
  const childrenByFrame = new Map<string, string[]>();
  for (const s of shapes) {
    const pid = s.parentId;
    if (typeof pid !== "string") continue;
    const parent = records[pid];
    if (!parent || parent.type !== "frame") continue;
    const child = idToElementId.get(s.id);
    if (!child) continue;
    const arr = childrenByFrame.get(pid);
    if (arr) arr.push(child);
    else childrenByFrame.set(pid, [child]);
  }

  // bindings index: arrowId → { start?: shapeId, end?: shapeId }
  const arrowTerminals = new Map<string, { start?: string; end?: string }>();
  for (const b of bindings) {
    const fromId = (b as { fromId?: unknown }).fromId;
    const toId = (b as { toId?: unknown }).toId;
    if (typeof fromId !== "string" || typeof toId !== "string") continue;
    const terminal = (b.props as { terminal?: unknown } | undefined)?.terminal;
    if (terminal !== "start" && terminal !== "end") continue;
    const entry = arrowTerminals.get(fromId) ?? {};
    entry[terminal] = toId;
    arrowTerminals.set(fromId, entry);
  }

  const elements: DomainElement[] = [];

  for (const shape of shapes) {
    const type = deriveType(shape);
    const id = elementIdOf(shape);
    const el: DomainElement = { id, type };

    // label из richText
    const richText = (shape.props as { richText?: unknown } | undefined)?.richText;
    if (richText) {
      const text = richTextToString(richText);
      if (text.length > 0) el.label = text;
    }

    // role
    const role = shape.meta?.role;
    if (typeof role === "string") el.role = role as Role;

    // connectionKind (для arrows и иных, у кого meta.connectionKind задан)
    if (type === "connection") {
      const kind = shape.meta?.connectionKind;
      if (typeof kind === "string") el.connectionKind = kind as ConnectionKind;

      const terminals = arrowTerminals.get(shape.id);
      if (terminals) {
        if (terminals.start) {
          const from = idToElementId.get(terminals.start);
          if (from) el.from = from;
        }
        if (terminals.end) {
          const to = idToElementId.get(terminals.end);
          if (to) el.to = to;
        }
      }
    }

    // children для groups (frame)
    if (type === "group") {
      const kids = childrenByFrame.get(shape.id);
      if (kids && kids.length > 0) {
        el.children = [...kids].sort();
      }
    }

    // pinned (только если truthy)
    if (shape.meta?.pinned === true) el.pinned = true;

    // bounds — только при includeGeometry
    if (opts.includeGeometry === true) {
      const x = typeof shape.x === "number" ? shape.x : 0;
      const y = typeof shape.y === "number" ? shape.y : 0;
      const props = (shape.props ?? {}) as { w?: unknown; h?: unknown };
      const w = typeof props.w === "number" ? props.w : 0;
      const h = typeof props.h === "number" ? props.h : 0;
      el.bounds = { x, y, w, h };
    }

    elements.push(el);
  }

  const view: DomainView = { version, elements };
  // diffSince — MVP: проброс через opts.since без diff-фильтрации (Phase 3.x).
  if (opts.since !== undefined) view.diffSince = opts.since;
  return view;
}
