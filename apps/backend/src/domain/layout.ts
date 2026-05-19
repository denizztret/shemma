// apps/backend/src/domain/layout.ts
//
// Phase 3.0: runLayout поверх TLStoreSnapshot.
//   - Вход: TLStoreSnapshot + LayoutHint + didrawIndex.
//   - Выход: StoreChangeBatch (updated only — позиции/размеры shape-записей).
//
// Сохранены invariants из Phase 2.x:
//   * DRW-003 pin discipline: shapes с meta.pinned === true НЕ двигаются;
//     non-pinned, пересекающие pinned bbox, смещаются вправо со y-стэккингом.
//   * DRW-004 group bbox writeback: frame-shapes получают props.w/props.h
//     из ELK output.
//   * ADR-0002 absolute coords: дети frame'а получают absolute x/y
//     (parent offset аккумулируется при сборе positions).
//   * ELK exception → возвращаем empty batch с reason: 'elk-error', не бросаем.
//
// Arrows (type === 'arrow') в ELK input/output НЕ участвуют: их геометрия
// задаётся bindings (start/end terminals), shape.x/y у arrow декоративные.
// Edges для ELK реконструируются по binding'ам (typeName === 'binding').
// Если у arrow != 2 bindings (висячая) — стрелка пропускается.

import { modeToElkOptions, type LayoutMode, type Spacing } from "@shemma/domain";
import elkWorkerPath from "../../node_modules/elkjs/lib/elk-worker.min.js" with { type: "file" };
import type { StoreChangeBatch, TLRecord, TLStoreSnapshot } from "../store-types";
import type { ElementId, LayoutHint } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: third-party CJS module
const ELK = require("elkjs/lib/main.js") as any;
// biome-ignore lint/suspicious/noExplicitAny: elk instance
const elk = new ELK({ workerUrl: elkWorkerPath }) as any;

const DEFAULT_W = 120;
const DEFAULT_H = 60;
const DEFAULT_FRAME_W = 400;
const DEFAULT_FRAME_H = 300;

// DRW-003 displacement constants (preserved from Phase 2.x layout.ts).
const COLLISION_SLACK = 10;
const NODE_SPACING_X = 40;
const NODE_SPACING_Y = 20;

type ShapeRec = TLRecord & {
  type?: string;
  x?: number;
  y?: number;
  props?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

type BindingRec = TLRecord & {
  fromId?: string;
  toId?: string;
  props?: { terminal?: string };
};

type Bounds = { x: number; y: number; w: number; h: number };

function readNumberProp(props: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const v = props?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function shapeBounds(r: ShapeRec): Bounds {
  const isFrame = r.type === "frame";
  const w = readNumberProp(r.props, "w", isFrame ? DEFAULT_FRAME_W : DEFAULT_W);
  const h = readNumberProp(r.props, "h", isFrame ? DEFAULT_FRAME_H : DEFAULT_H);
  const x = typeof r.x === "number" ? r.x : 0;
  const y = typeof r.y === "number" ? r.y : 0;
  return { x, y, w, h };
}

function isShape(r: TLRecord): r is ShapeRec {
  return r.typeName === "shape";
}

function isLayoutCandidate(r: ShapeRec): boolean {
  // Arrows позиционируются через bindings → не участвуют в ELK input/output.
  return r.type !== "arrow";
}

function isPinned(r: ShapeRec): boolean {
  return r.meta?.pinned === true;
}

function collectShapes(store: TLStoreSnapshot): ShapeRec[] {
  const out: ShapeRec[] = [];
  for (const id in store.store) {
    const r = store.store[id];
    if (r && isShape(r) && isLayoutCandidate(r)) out.push(r);
  }
  return out;
}

function collectArrows(store: TLStoreSnapshot): ShapeRec[] {
  const out: ShapeRec[] = [];
  for (const id in store.store) {
    const r = store.store[id];
    if (r && isShape(r) && r.type === "arrow") out.push(r);
  }
  return out;
}

function bindingsForArrow(store: TLStoreSnapshot, arrowId: string): BindingRec[] {
  const out: BindingRec[] = [];
  for (const id in store.store) {
    const r = store.store[id] as BindingRec | undefined;
    if (r && r.typeName === "binding" && r.fromId === arrowId) out.push(r);
  }
  return out;
}

/**
 * Build ELK graph from shapes + arrow-bindings, treating frames as compound nodes.
 *
 * When `filterToIds` is provided (subgraph mode — DRW-091/092):
 *   - Leaves: only included if id ∈ filterToIds.
 *   - Frames:
 *     a) frame.id ∈ filterToIds → included as full compound node (selected frame).
 *     b) frame has ≥1 included child → included as anchor container with fixed
 *        size constraint; its position will NOT be written back in batch.
 *   - Edges: included only if both endpoints are in included shape ids.
 *
 * Returns the set of anchor frame ids (frames included as containers but NOT in filterToIds).
 */
function buildElkGraph(
  store: TLStoreSnapshot,
  shapes: ShapeRec[],
  hint: Required<LayoutHint>,
  filterToIds?: Set<string>,
): { graph: unknown; anchorFrameIds: Set<string> } {
  const opts = modeToElkOptions(hint.mode, hint.spacing);

  // Partition shapes: frames vs leaves.
  const frames = shapes.filter((s) => s.type === "frame");
  const leaves = shapes.filter((s) => s.type !== "frame");

  const includedLeaves = filterToIds
    ? leaves.filter((s) => filterToIds.has(s.id))
    : leaves;

  // Anchor frames: parent of ≥1 included leaf, but not themselves in filterToIds.
  // Included as fixed-size containers in ELK; their position is NOT written back.
  const anchorFrameIds = new Set<string>();
  if (filterToIds) {
    for (const f of frames) {
      if (!filterToIds.has(f.id) && includedLeaves.some((s) => s.parentId === f.id)) {
        anchorFrameIds.add(f.id);
      }
    }
  }

  // Include selected frames (in filterToIds) + anchor frames.
  const includedFrames = filterToIds
    ? frames.filter((f) => filterToIds.has(f.id) || anchorFrameIds.has(f.id))
    : frames;

  // Children of frame: shapes whose parentId === frame.id (layout candidates).
  const childrenByFrame = new Map<string, ShapeRec[]>();
  for (const f of includedFrames) childrenByFrame.set(f.id, []);
  const topLevel: ShapeRec[] = [];
  for (const s of includedLeaves) {
    if (s.parentId && childrenByFrame.has(s.parentId)) {
      childrenByFrame.get(s.parentId)!.push(s);
    } else {
      topLevel.push(s);
    }
  }

  const buildLeaf = (s: ShapeRec) => {
    const b = shapeBounds(s);
    return {
      id: s.id,
      width: Math.max(20, b.w),
      height: Math.max(20, b.h),
      ports: [],
    };
  };

  const buildFrame = (f: ShapeRec, _isAnchor: boolean) => {
    const b = shapeBounds(f);
    const children = (childrenByFrame.get(f.id) ?? []).map(buildLeaf);
    // DRW-092 v3: frames (anchor и selected) используют тот же layered algorithm
    // что и outer — сохраняем ranks + edge routing. Не зажимаем размер: ELK сам
    // вычислит compound size под реальный children layout, мы это запишем в
    // frame.props.w/h (anchor frame растёт под содержимое, x/y остаётся).
    return {
      id: f.id,
      width: b.w,
      height: b.h,
      layoutOptions: { ...opts, "elk.padding": "[top=40,left=20,bottom=20,right=20]" },
      children,
    };
  };

  // All shape ids included in this graph (for edge filtering in subgraph mode).
  const allIncludedIds = new Set([
    ...includedLeaves.map((s) => s.id),
    ...includedFrames.map((f) => f.id),
  ]);

  // Edges from bindings: per arrow, find 2 bindings (start/end), use their toId endpoints.
  // In subgraph mode: only include edges where BOTH endpoints are in included ids.
  const arrows = collectArrows(store);
  const edges: Array<{ id: string; sources: string[]; targets: string[] }> = [];
  for (const a of arrows) {
    const bs = bindingsForArrow(store, a.id);
    if (bs.length !== 2) continue;
    const start = bs.find((b) => (b.props as { terminal?: string } | undefined)?.terminal === "start");
    const end = bs.find((b) => (b.props as { terminal?: string } | undefined)?.terminal === "end");
    const src = start?.toId ?? bs[0]?.toId;
    const tgt = end?.toId ?? bs[1]?.toId;
    if (!src || !tgt) continue;
    // Subgraph filter: skip edges to non-included shapes.
    if (filterToIds && (!allIncludedIds.has(src) || !allIncludedIds.has(tgt))) continue;
    edges.push({ id: a.id, sources: [src], targets: [tgt] });
  }

  const graph = {
    id: "root",
    layoutOptions: { ...opts, "elk.hierarchyHandling": "INCLUDE_CHILDREN" },
    children: [
      ...topLevel.map(buildLeaf),
      ...includedFrames.map((f) => buildFrame(f, anchorFrameIds.has(f.id))),
    ],
    edges,
  };

  return { graph, anchorFrameIds };
}

type Positions = Record<string, { x: number; y: number; w?: number; h?: number }>;

function collectPositions(
  res: { children?: unknown[] },
): Positions {
  const positions: Positions = {};
  const walk = (children: unknown[] | undefined, offsetX: number, offsetY: number) => {
    for (const ch of children ?? []) {
      const c = ch as {
        id?: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        children?: unknown[];
      };
      if (c.id == null) continue;
      const absX = (c.x ?? 0) + offsetX;
      const absY = (c.y ?? 0) + offsetY;
      positions[c.id] = { x: absX, y: absY, w: c.width, h: c.height };
      walk(c.children, absX, absY);
    }
  };
  walk(res.children, 0, 0);
  return positions;
}

/** DRW-003: смещение non-pinned shapes, пересекающих pinned bbox. */
function applyDisplacement(
  positions: Positions,
  shapes: ShapeRec[],
  pinnedSet: Set<string>,
): void {
  if (pinnedSet.size === 0) return;
  const shapeById = new Map(shapes.map((s) => [s.id, s]));
  const boxOf = (id: string): Bounds | null => {
    const p = positions[id];
    if (!p) return null;
    const s = shapeById.get(id);
    const fallback = s ? shapeBounds(s) : { x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H };
    return {
      x: p.x,
      y: p.y,
      w: p.w ?? fallback.w,
      h: p.h ?? fallback.h,
    };
  };

  const pinnedBoxes: Bounds[] = [];
  for (const pid of pinnedSet) {
    const b = boxOf(pid);
    if (b) pinnedBoxes.push(b);
  }
  if (pinnedBoxes.length === 0) return;

  const pinnedRight = Math.max(...pinnedBoxes.map((b) => b.x + b.w));
  const pinnedTop = Math.min(...pinnedBoxes.map((b) => b.y));
  const overlapsAnyPinned = (b: Bounds) =>
    pinnedBoxes.some(
      (pb) =>
        !(
          b.x + b.w + COLLISION_SLACK <= pb.x ||
          pb.x + pb.w + COLLISION_SLACK <= b.x ||
          b.y + b.h + COLLISION_SLACK <= pb.y ||
          pb.y + pb.h + COLLISION_SLACK <= b.y
        ),
    );

  // Affected ids: все non-pinned shapes с position'ом, отсортированы по id для детерминизма.
  const affectedIds = shapes
    .filter((s) => !pinnedSet.has(s.id) && positions[s.id] !== undefined)
    .map((s) => s.id)
    .sort();

  let nextY = pinnedTop;
  for (const aid of affectedIds) {
    const box = boxOf(aid);
    if (!box) continue;
    if (!overlapsAnyPinned(box)) continue;
    positions[aid] = {
      ...positions[aid],
      x: pinnedRight + NODE_SPACING_X,
      y: nextY,
    };
    nextY += box.h + NODE_SPACING_Y;
  }
}

/**
 * Run ELK layout over a TLStoreSnapshot and produce a StoreChangeBatch
 * updating only position (x/y) and, for frames, props.w/props.h.
 *
 * `index` параметр (didrawName → recordId) сейчас не используется — keep
 * в сигнатуре для совместимости с orchestrator-call'ом в routes/domain.ts;
 * пригодится при future "scope=ElementId" реализации (subgraph layout).
 */
export async function runLayout(
  store: TLStoreSnapshot,
  hint: LayoutHint,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: kept for API stability, see jsdoc
  index: Map<string, string>,
): Promise<{ batch: StoreChangeBatch; affected: string[]; reason?: string }> {
  const fullHint: Required<LayoutHint> = {
    mode: (hint.mode ?? "layered-lr") as LayoutMode,
    scope: hint.scope ?? "affected",
    spacing: (hint.spacing ?? "normal") as Spacing,
    affectedIds: hint.affectedIds ?? new Set(),
  };

  const emptyBatch: StoreChangeBatch = { added: {}, updated: {}, removed: {} };

  const shapes = collectShapes(store);
  if (shapes.length === 0) {
    return { batch: emptyBatch, affected: [] };
  }

  // Subgraph mode: scope="affected" with affectedIds provided → DRW-091/092 fix.
  // Non-affected shapes are EXCLUDED from ELK graph entirely (not pinned).
  // Anchor frames (parent of selected children, not selected themselves) are
  // included as fixed-size containers but NOT written back in batch.
  const affectedIds = hint.affectedIds;
  const isSubgraphMode = fullHint.scope === "affected" && affectedIds && affectedIds.size > 0;

  // Pin set: only meta.pinned === true shapes (DRW-003).
  // In subgraph mode the old "pin non-affected" trick is replaced by exclusion from ELK input.
  const pinnedSet = new Set<string>();
  for (const s of shapes) {
    if (isPinned(s)) {
      pinnedSet.add(s.id);
    }
  }

  const filterToIds = isSubgraphMode ? affectedIds : undefined;
  const { graph, anchorFrameIds } = buildElkGraph(store, shapes, fullHint, filterToIds);

  let res: { children?: unknown[]; edges?: unknown[] };
  try {
    res = await elk.layout(graph as never);
  } catch (_e) {
    return { batch: emptyBatch, affected: [], reason: "elk-error" };
  }

  const positions = collectPositions(res);

  // Restore pinned coords (ELK layered ignores fixed-position hints in elkjs 0.9.3 —
  // override after layout. См. layout.ts pre-Phase-3 commentary).
  for (const s of shapes) {
    if (pinnedSet.has(s.id) && positions[s.id] !== undefined) {
      positions[s.id] = { ...positions[s.id], x: s.x ?? 0, y: s.y ?? 0 };
    }
  }

  // DRW-091 AC#2: when selected shapes are top-level (no anchor frame), translate ELK
  // output to preserve original centroid. Prevents cluster from jumping to (0,0).
  if (isSubgraphMode && anchorFrameIds.size === 0 && filterToIds && filterToIds.size > 0) {
    const selectedShapes = shapes.filter(
      (s) => filterToIds.has(s.id) && !pinnedSet.has(s.id) && s.type !== "frame",
    );
    if (selectedShapes.length > 0) {
      let origCX = 0;
      let origCY = 0;
      let elkCX = 0;
      let elkCY = 0;
      let count = 0;
      for (const s of selectedShapes) {
        const ob = shapeBounds(s);
        origCX += ob.x + ob.w / 2;
        origCY += ob.y + ob.h / 2;
        const ep = positions[s.id];
        if (ep) {
          elkCX += ep.x + (ep.w ?? ob.w) / 2;
          elkCY += ep.y + (ep.h ?? ob.h) / 2;
          count++;
        }
      }
      if (count > 0) {
        origCX /= selectedShapes.length;
        origCY /= selectedShapes.length;
        elkCX /= count;
        elkCY /= count;
        const dx = origCX - elkCX;
        const dy = origCY - elkCY;
        for (const id in positions) {
          if (pinnedSet.has(id)) continue;
          const p = positions[id];
          positions[id] = { ...p, x: p.x + dx, y: p.y + dy };
        }
      }
    }
  }

  // DRW-003 displacement.
  applyDisplacement(positions, shapes, pinnedSet);

  // Build updated batch — only записи, у которых реально поменялись x/y/w/h.
  // DRW-092 v3: anchor frame — x/y остаются original, но w/h обновляются под
  // ELK-computed compound size (frame растёт под содержимое).
  const updated: Record<string, [TLRecord, TLRecord]> = {};
  const affected: string[] = [];
  const EPS = 1e-6;

  // DRW-082: collectPositions возвращает absolute page coords (через walk c
  // offsetX/Y накопителем). Но в tldraw shape с parentId=frame хранит x/y
  // RELATIVE к parent'у — иначе при render абсолютные координаты добавляются
  // к parent.x повторно и shape уезжает за границы frame. Конвертируем abs
  // обратно в parent-relative для children frame'ов.
  const frameIds = new Set<string>();
  for (const s of shapes) {
    if (s.type === "frame") frameIds.add(s.id);
  }

  for (const s of shapes) {
    const p = positions[s.id];
    if (!p) continue;
    const isAnchor = anchorFrameIds.has(s.id);
    // In subgraph mode: только shapes из filterToIds или anchor-frames попадают в batch.
    if (!isAnchor && filterToIds && !filterToIds.has(s.id)) continue;
    const oldB = shapeBounds(s);
    const isFrame = s.type === "frame";
    const parentIsFrame =
      typeof s.parentId === "string" && frameIds.has(s.parentId);

    let newX: number;
    let newY: number;
    if (isAnchor) {
      // Anchor frame stays put — x/y из original; w/h ниже обновляется до ELK output.
      newX = oldB.x;
      newY = oldB.y;
    } else if (parentIsFrame) {
      const parentPos = positions[s.parentId as string];
      newX = parentPos ? p.x - parentPos.x : p.x;
      newY = parentPos ? p.y - parentPos.y : p.y;
    } else {
      newX = p.x;
      newY = p.y;
    }
    // DRW-004: для frame пишем bbox обратно в props.w/props.h.
    const newW = isFrame && typeof p.w === "number" ? p.w : undefined;
    const newH = isFrame && typeof p.h === "number" ? p.h : undefined;

    const xChanged = Math.abs(newX - oldB.x) > EPS;
    const yChanged = Math.abs(newY - oldB.y) > EPS;
    const wChanged = newW !== undefined && Math.abs(newW - oldB.w) > EPS;
    const hChanged = newH !== undefined && Math.abs(newH - oldB.h) > EPS;
    if (!xChanged && !yChanged && !wChanged && !hChanged) continue;

    const newRec: TLRecord = { ...s, x: newX, y: newY };
    if (newW !== undefined || newH !== undefined) {
      const oldProps = (s.props ?? {}) as Record<string, unknown>;
      const newProps: Record<string, unknown> = { ...oldProps };
      if (newW !== undefined) newProps.w = newW;
      if (newH !== undefined) newProps.h = newH;
      (newRec as { props?: Record<string, unknown> }).props = newProps;
    }
    updated[s.id] = [s, newRec];
    affected.push(s.id);
  }

  return { batch: { added: {}, updated, removed: {} }, affected };
}

export type { ElementId };
