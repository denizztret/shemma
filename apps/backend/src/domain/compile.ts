// apps/backend/src/domain/compile.ts
//
// Phase 3.0: compile DomainAction[] → StoreChangeBatch поверх TLStoreSnapshot.
// Cross-action coherence: staging store + index пересобираются после каждой
// action, чтобы action N мог ссылаться на shapes/groups, созданные в action N-1.
// `layout` — no-op на этом уровне (ELK orchestrate'ится routes/domain.ts).

import { connectionPreset, rolePreset, type Role } from "@shemma/domain";
import { applyStoreChanges, cascadeDeleteShape, rebuildDidrawIndex } from "../store-ops";
import type { StoreChangeBatch, TLRecord, TLStoreSnapshot } from "../store-types";
import type { DomainAction, ElementId } from "./types";

function rand(): string {
  return Math.random().toString(36).slice(2, 12);
}
function shapeId(): string {
  return `shape:${rand()}`;
}
function bindingId(): string {
  return `binding:${rand()}`;
}

function richText(label: string): unknown {
  return label
    ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: label }] }] }
    : { type: "doc", content: [{ type: "paragraph" }] };
}

function mergeBatch(a: StoreChangeBatch, b: StoreChangeBatch): StoreChangeBatch {
  return {
    added: { ...a.added, ...b.added },
    updated: { ...a.updated, ...b.updated },
    removed: { ...a.removed, ...b.removed },
  };
}

// Common arrow shape — only `dash`, `richText` (label), and `meta` vary across
// callers (connect / note.about). Kept private to compile.ts; defaults match
// the inline literals from Phase 3.0.
function makeArrowShape(opts: {
  id: string;
  dash: "draw" | "dashed";
  label: string;
  meta: Record<string, unknown>;
}): TLRecord {
  return {
    id: opts.id,
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
      dash: opts.dash,
      size: "m",
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
      font: "draw",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      bend: 0,
      elbowMidPoint: 0.5,
      text: "",
      labelPosition: 0.5,
      scale: 1,
      richText: richText(opts.label),
    },
    meta: opts.meta,
  } as TLRecord;
}

// Arrow start/end binding pair. Endpoint shapes must already exist.
function makeArrowBindings(arrowId: string, fromShapeId: string, toShapeId: string): {
  start: TLRecord;
  end: TLRecord;
} {
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
      },
      meta: {},
    }) as TLRecord;
  return { start: mk("start", fromShapeId), end: mk("end", toShapeId) };
}

export function compile(
  actions: DomainAction[],
  store: TLStoreSnapshot,
  index: Map<string, string>,
): { batch: StoreChangeBatch; elementIds: (ElementId | undefined)[] } {
  let stagingStore: TLStoreSnapshot = store;
  let stagingIndex: Map<string, string> = new Map(index);
  let batch: StoreChangeBatch = { added: {}, updated: {}, removed: {} };
  const elementIds: (ElementId | undefined)[] = [];

  const stage = (sub: StoreChangeBatch) => {
    batch = mergeBatch(batch, sub);
    stagingStore = applyStoreChanges(stagingStore, sub);
    stagingIndex = rebuildDidrawIndex(stagingStore);
  };

  for (const a of actions) {
    switch (a.kind) {
      case "define": {
        const existingId = stagingIndex.get(a.name);
        const preset = rolePreset(a.role as Role);
        const oldShape = existingId ? stagingStore.store[existingId] : undefined;
        if (existingId && oldShape) {
          const old = oldShape;
          // preserve user-owned meta (pinned/position/styleOwnedBy)
          const oldMeta = (old.meta ?? {}) as Record<string, unknown>;
          const { pinned, position, styleOwnedBy, ...rest } = oldMeta as {
            pinned?: unknown;
            position?: unknown;
            styleOwnedBy?: unknown;
            [key: string]: unknown;
          };
          const newMeta: Record<string, unknown> = {
            ...rest,
            didrawName: a.name,
            role: a.role,
            ...(a.meta ?? {}),
          };
          if (pinned !== undefined) newMeta.pinned = pinned;
          if (position !== undefined) newMeta.position = position;
          if (styleOwnedBy !== undefined) newMeta.styleOwnedBy = styleOwnedBy;
          const newR: TLRecord = { ...old, meta: newMeta };
          if (a.label !== undefined) {
            (newR as { props?: Record<string, unknown> }).props = {
              ...((old.props as Record<string, unknown>) ?? {}),
              richText: richText(a.label),
            };
          }
          stage({ added: {}, updated: { [existingId]: [old, newR] }, removed: {} });
          elementIds.push(a.name);
        } else {
          const id = shapeId();
          const shape: TLRecord = {
            id,
            typeName: "shape",
            type: "geo",
            x: 0,
            y: 0,
            parentId: "page:page",
            index: "a1",
            isLocked: false,
            opacity: 1,
            rotation: 0,
            props: {
              w: preset.defaultW,
              h: preset.defaultH,
              geo: "rectangle",
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
              richText: richText(a.label ?? a.name),
            },
            meta: { didrawName: a.name, role: a.role, ...(a.meta ?? {}) },
          } as TLRecord;
          stage({ added: { [id]: shape }, updated: {}, removed: {} });
          elementIds.push(a.name);
        }
        break;
      }
      case "connect": {
        const fromId = stagingIndex.get(a.from);
        const toId = stagingIndex.get(a.to);
        if (!fromId) throw new Error(`compile.connect: missing endpoint "from=${a.from}"`);
        if (!toId) throw new Error(`compile.connect: missing endpoint "to=${a.to}"`);
        const aid = shapeId();
        const ck = a.connectionKind ?? "sync";
        const preset = connectionPreset(ck);
        const arrow = makeArrowShape({
          id: aid,
          dash: preset.dashed ? "dashed" : "draw",
          label: a.label ?? preset.defaultLabel ?? "",
          meta: { connectionKind: ck, ...(a.meta ?? {}) },
        });
        const { start, end } = makeArrowBindings(aid, fromId, toId);
        stage({
          added: { [aid]: arrow, [start.id]: start, [end.id]: end },
          updated: {},
          removed: {},
        });
        elementIds.push(aid);
        break;
      }
      case "group": {
        const fid = shapeId();
        const frame: TLRecord = {
          id: fid,
          typeName: "shape",
          type: "frame",
          x: 0,
          y: 0,
          parentId: "page:page",
          index: "a1",
          isLocked: false,
          opacity: 1,
          rotation: 0,
          props: { w: 400, h: 300, name: a.label ?? a.name },
          meta: { didrawName: a.name, didrawIsGroup: true, role: a.as },
        } as TLRecord;
        const sub: StoreChangeBatch = { added: { [fid]: frame }, updated: {}, removed: {} };
        for (const memberName of a.ids) {
          const mid = stagingIndex.get(memberName);
          if (!mid) continue;
          const old = stagingStore.store[mid];
          if (!old) continue;
          sub.updated[mid] = [old, { ...old, parentId: fid }];
        }
        stage(sub);
        elementIds.push(a.name);
        break;
      }
      case "note": {
        const name = a.name ?? `note-${rand()}`;
        const id = shapeId();
        const note: TLRecord = {
          id,
          typeName: "shape",
          type: "note",
          x: 0,
          y: 0,
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
            richText: richText(a.text),
          },
          meta: { didrawName: name, role: "note" },
        } as TLRecord;
        const sub: StoreChangeBatch = { added: { [id]: note }, updated: {}, removed: {} };
        if (a.about) {
          const targetId = stagingIndex.get(a.about);
          if (targetId) {
            const aid = shapeId();
            const arrow = makeArrowShape({
              id: aid,
              dash: "dashed",
              label: "",
              meta: { connectionKind: "dep", noteBinding: true },
            });
            const { start, end } = makeArrowBindings(aid, id, targetId);
            sub.added[aid] = arrow;
            sub.added[start.id] = start;
            sub.added[end.id] = end;
          }
        }
        stage(sub);
        elementIds.push(name);
        break;
      }
      case "layout": {
        // No-op в compile. ELK orchestrate'ится routes/domain.ts через domain/layout.ts.
        elementIds.push(undefined);
        break;
      }
      case "delete": {
        const ids = "ids" in a ? a.ids : [a.id];
        for (const nm of ids) {
          const id = stagingIndex.get(nm);
          if (!id) continue;
          const sub = cascadeDeleteShape(stagingStore, id);
          stage(sub);
        }
        elementIds.push(undefined);
        break;
      }
    }
  }

  return { batch, elementIds };
}
