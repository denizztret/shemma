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
// DRW-099: hierarchical multi-pass layout для nested compounds.
//   Pass A: per-compound layout — для каждого anchor container (NOT in filterToIds,
//     has ≥1 selected child) и каждого selected container (in filterToIds, has ≥1
//     selected child) — независимый ELK layout на filtered children.
//   Pass B: top-level layout — selected containers trataed as leaf nodes with
//     sizes computed in Pass A; bare shapes at root laid out together.
//   Pass C: apply — top-level positions + children parent-relative coords +
//     container w/h updates.
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

// Padding around children inside a container after Pass A layout.
const CONTAINER_PAD_TOP = 40;
const CONTAINER_PAD_LR = 20;
const CONTAINER_PAD_BOT = 20;

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

// DRW-098: container = tldraw frame ИЛИ geo+role=boundary (DRW-084 Mermaid
// subgraphs рендерятся как geo с meta.role="boundary" а не как frame —
// layout должен трактовать их как compound contаiner identical to frame).
function isContainerShape(r: ShapeRec): boolean {
  if (r.type === "frame") return true;
  if (r.type === "geo" && r.meta?.role === "boundary") return true;
  return false;
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

type ElkEdge = { id: string; sources: string[]; targets: string[] };

/** Collect ELK edges from arrow bindings. Only edges where both endpoints are in includedIds. */
function buildEdges(
  store: TLStoreSnapshot,
  includedIds: Set<string>,
): ElkEdge[] {
  const arrows = collectArrows(store);
  const edges: ElkEdge[] = [];
  for (const a of arrows) {
    const bs = bindingsForArrow(store, a.id);
    if (bs.length !== 2) continue;
    const start = bs.find((b) => (b.props as { terminal?: string } | undefined)?.terminal === "start");
    const end = bs.find((b) => (b.props as { terminal?: string } | undefined)?.terminal === "end");
    const src = start?.toId ?? bs[0]?.toId;
    const tgt = end?.toId ?? bs[1]?.toId;
    if (!src || !tgt) continue;
    if (!includedIds.has(src) || !includedIds.has(tgt)) continue;
    edges.push({ id: a.id, sources: [src], targets: [tgt] });
  }
  return edges;
}

type ElkNode = {
  id: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  ports?: unknown[];
  layoutOptions?: Record<string, unknown>;
  children?: ElkNode[];
};

type ElkGraph = {
  id: string;
  layoutOptions: Record<string, unknown>;
  children: ElkNode[];
  edges: ElkEdge[];
};

type ElkResult = {
  children?: Array<{
    id?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    children?: unknown[];
  }>;
};

type Positions = Record<string, { x: number; y: number; w?: number; h?: number }>;

function collectPositions(
  res: ElkResult,
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
 *
 * NOTE: This is used for scope='all' path only. For subgraph mode (scope='affected'),
 * runLayoutSubgraph implements hierarchical multi-pass (DRW-099).
 */
function buildElkGraph(
  store: TLStoreSnapshot,
  shapes: ShapeRec[],
  hint: Required<LayoutHint>,
  filterToIds?: Set<string>,
): { graph: unknown; anchorFrameIds: Set<string> } {
  const opts = modeToElkOptions(hint.mode, hint.spacing);

  // Partition shapes: frames vs leaves.
  const frames = shapes.filter(isContainerShape);
  const leaves = shapes.filter((s) => !isContainerShape(s));

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

// =====================================================================
// DRW-099: Hierarchical multi-pass layout for subgraph mode
// =====================================================================

/**
 * ContainerPassResult: результат Pass A для одного контейнера.
 * Содержит parent-relative позиции children и новые w/h контейнера.
 */
type ContainerPassResult = {
  containerId: string;
  /** parent-relative coords of children laid out inside this container */
  childPositions: Map<string, { x: number; y: number }>;
  /** computed w/h for the container (to write back to props) */
  newW: number;
  newH: number;
};

/**
 * Pass A: layout children of a single container independently.
 * Запускает ELK на детях этого контейнера (только те, что в filteredChildren).
 * Возвращает parent-relative coords детей и новый размер контейнера.
 * Рекурсивно обрабатывает вложенные контейнеры.
 */
async function runPassA(
  store: TLStoreSnapshot,
  container: ShapeRec,
  filteredChildren: ShapeRec[],
  opts: Record<string, unknown>,
  allShapes: ShapeRec[],
  filterToIds: Set<string>,
): Promise<ContainerPassResult | null> {
  // Разделим детей на листья и контейнеры
  const childContainers = filteredChildren.filter(isContainerShape);
  const childLeaves = filteredChildren.filter((s) => !isContainerShape(s));

  // Сначала рекурсивно обработаем вложенные контейнеры (Pass A рекурсия)
  // Для каждого child-контейнера найдём его отфильтрованных детей
  const nestedResults = new Map<string, ContainerPassResult>();
  for (const cc of childContainers) {
    // Дети этого вложенного контейнера, которые в filterToIds или которые anchor
    const ccChildren = allShapes.filter(
      (s) => s.parentId === cc.id && !isContainerShape(s) && !isLayoutCandidate(s) === false,
    );
    // Filtered children: только те что в filterToIds или являются anchor-детьми
    const ccFiltered = ccChildren.filter(
      (s) => filterToIds.has(s.id) || ccChildren.some((_) => filterToIds.has(s.id)),
    );
    const ccFilteredActual = ccChildren.filter((s) => filterToIds.has(s.id));
    if (ccFilteredActual.length > 0) {
      const nestedRes = await runPassA(store, cc, ccFilteredActual, opts, allShapes, filterToIds);
      if (nestedRes) nestedResults.set(cc.id, nestedRes);
    }
  }

  // Теперь собираем ELK leaf nodes для Pass A этого контейнера.
  // child-контейнеры с вложенным результатом трактуются как листья с computed size.
  const elkChildren: ElkNode[] = [];

  // Листья-контейнеры (selected child-контейнеры трактуются как leaf в pass A parent layout)
  for (const cc of childContainers) {
    const nested = nestedResults.get(cc.id);
    const origB = shapeBounds(cc);
    const w = nested ? nested.newW : origB.w;
    const h = nested ? nested.newH : origB.h;
    elkChildren.push({ id: cc.id, width: Math.max(20, w), height: Math.max(20, h) });
  }

  // Обычные листья
  for (const s of childLeaves) {
    const b = shapeBounds(s);
    elkChildren.push({ id: s.id, width: Math.max(20, b.w), height: Math.max(20, b.h) });
  }

  if (elkChildren.length === 0) return null;

  // Edges между детьми этого контейнера (внутренние edges только)
  const childIds = new Set(elkChildren.map((c) => c.id));
  const edges = buildEdges(store, childIds);

  const graph: ElkGraph = {
    id: "root",
    layoutOptions: { ...opts, "elk.padding": `[top=${CONTAINER_PAD_TOP},left=${CONTAINER_PAD_LR},bottom=${CONTAINER_PAD_BOT},right=${CONTAINER_PAD_LR}]` },
    children: elkChildren,
    edges,
  };

  let res: ElkResult;
  try {
    res = await elk.layout(graph as never);
  } catch (_e) {
    return null;
  }

  // Собираем позиции — flat (root offset=0,0)
  const positions = collectPositions(res);

  // Вычисляем новый размер контейнера
  let maxX = 0;
  let maxY = 0;
  for (const childId in positions) {
    const p = positions[childId];
    const w = p.w ?? DEFAULT_W;
    const h = p.h ?? DEFAULT_H;
    if (p.x + w > maxX) maxX = p.x + w;
    if (p.y + h > maxY) maxY = p.y + h;
  }
  const newW = maxX + CONTAINER_PAD_LR;
  const newH = maxY + CONTAINER_PAD_BOT;

  // Собираем parent-relative coords для всех children
  const childPositions = new Map<string, { x: number; y: number }>();

  // Листья — из ELK output напрямую (root=0,0 → это уже relative coords внутри контейнера)
  for (const s of childLeaves) {
    const p = positions[s.id];
    if (p) childPositions.set(s.id, { x: p.x, y: p.y });
  }

  // Контейнеры — из ELK output, плюс их вложенные дети
  for (const cc of childContainers) {
    const p = positions[cc.id];
    if (p) childPositions.set(cc.id, { x: p.x, y: p.y });

    // Вложенные дети получают позиции relative к cc, которая уже internal relative к container
    const nested = nestedResults.get(cc.id);
    if (nested) {
      for (const [childId, childPos] of nested.childPositions) {
        // childPos — relative to cc; cc.pos — relative to container
        // Итоговая позиция для child в batch: relative to cc (tldraw nested)
        childPositions.set(childId, childPos);
      }
    }
  }

  return {
    containerId: container.id,
    childPositions,
    newW,
    newH,
  };
}

/**
 * DRW-099: Hierarchical multi-pass layout for subgraph mode.
 *
 * Pass A: per-compound layout для каждого anchor container и каждого selected container с children.
 * Pass B: top-level layout на selected top-level shapes (selected frames как leaf с size из Pass A).
 * Pass C: apply — собирает итоговые позиции из Pass A и Pass B.
 *
 * Returns positions map (absolute for top-level, parent-relative for children).
 */
async function runLayoutSubgraph(
  store: TLStoreSnapshot,
  shapes: ShapeRec[],
  hint: Required<LayoutHint>,
  filterToIds: Set<string>,
): Promise<{ positions: Positions; anchorFrameIds: Set<string> } | null> {
  const opts = modeToElkOptions(hint.mode, hint.spacing);

  const frames = shapes.filter(isContainerShape);
  const leaves = shapes.filter((s) => !isContainerShape(s));

  // Filtered children (non-container leaves that are selected)
  const selectedLeaves = leaves.filter((s) => filterToIds.has(s.id));
  // Selected containers
  const selectedContainers = frames.filter((f) => filterToIds.has(f.id));
  // Anchor containers: NOT selected, but have ≥1 selected child anywhere in subtree
  const anchorFrameIds = new Set<string>();

  // Find all shapes that are children of a container and their container is not selected
  for (const f of frames) {
    if (filterToIds.has(f.id)) continue;
    // Check if any selected shape is a direct child of this frame
    const hasSelectedChild = selectedLeaves.some((s) => s.parentId === f.id) ||
      selectedContainers.some((c) => c.parentId === f.id);
    if (hasSelectedChild) anchorFrameIds.add(f.id);
  }

  // Build ancestry map for anchor resolution: shape.id → ancestor frame ids chain
  // For multi-level: if a leaf's parent is a nested anchor, we need its root anchor too
  const frameById = new Map(frames.map((f) => [f.id, f]));

  // Get all ancestor containers for a shape (bottom-up order)
  function getAncestorContainers(s: ShapeRec): ShapeRec[] {
    const ancestors: ShapeRec[] = [];
    let pid = s.parentId;
    while (pid && pid !== "page:page") {
      const p = frameById.get(pid);
      if (!p) break;
      ancestors.push(p);
      pid = p.parentId;
    }
    return ancestors;
  }

  // Identify top-level anchor containers and all nested ones
  // Re-scan: anchor = any frame NOT in filterToIds that has a filtered descendant
  anchorFrameIds.clear();
  for (const f of frames) {
    if (filterToIds.has(f.id)) continue;
    // Direct selected leaf children
    const hasDirectSelectedLeaf = selectedLeaves.some((s) => s.parentId === f.id);
    // Direct selected container children
    const hasDirectSelectedContainer = selectedContainers.some((c) => c.parentId === f.id);
    // Direct anchor frame children (nested anchor)
    const hasAnchorChild = frames.some((ff) => ff.parentId === f.id && anchorFrameIds.has(ff.id));
    if (hasDirectSelectedLeaf || hasDirectSelectedContainer || hasAnchorChild) {
      anchorFrameIds.add(f.id);
    }
  }

  // Multi-pass anchor re-scan: iterate until stable (handles deep nesting)
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of frames) {
      if (filterToIds.has(f.id) || anchorFrameIds.has(f.id)) continue;
      const hasAnchorChild = frames.some((ff) => ff.parentId === f.id && anchorFrameIds.has(ff.id));
      if (hasAnchorChild) {
        anchorFrameIds.add(f.id);
        changed = true;
      }
    }
  }

  // Determine top-level anchor containers: anchor containers whose parent is NOT also an anchor
  const topLevelAnchorIds = new Set<string>();
  for (const fid of anchorFrameIds) {
    const f = frameById.get(fid);
    if (!f) continue;
    const parentId = f.parentId;
    if (!parentId || parentId === "page:page" || !anchorFrameIds.has(parentId)) {
      topLevelAnchorIds.add(fid);
    }
  }

  // TOP-LEVEL selected shapes: selected shapes whose parent is page (not inside any anchor/selected frame)
  // A selected shape is top-level if its DIRECT parent is page:page OR a non-anchor non-selected frame
  const isInsideSelectedOrAnchor = (s: ShapeRec): boolean => {
    const pid = s.parentId;
    if (!pid || pid === "page:page") return false;
    return anchorFrameIds.has(pid) || filterToIds.has(pid);
  };

  const topLevelSelectedContainers = selectedContainers.filter((f) => !isInsideSelectedOrAnchor(f));
  const topLevelSelectedLeaves = selectedLeaves.filter((s) => !isInsideSelectedOrAnchor(s));

  // =====================================================================
  // Pass A: layout children of each anchor container and selected containers
  // that have selected children.
  // =====================================================================

  // passAResults: containerId → ContainerPassResult
  const passAResults = new Map<string, ContainerPassResult>();

  // Process top-level anchors (they will recursively handle nested ones)
  for (const anchorId of topLevelAnchorIds) {
    const anchor = frameById.get(anchorId);
    if (!anchor) continue;

    // Collect direct filtered children of this anchor
    const directFilteredChildren = [...selectedLeaves, ...selectedContainers].filter(
      (s) => s.parentId === anchorId,
    );
    // Also collect nested anchor frames that are direct children
    const directAnchorChildren = frames.filter(
      (f) => f.parentId === anchorId && anchorFrameIds.has(f.id),
    );
    // All direct children to layout: filtered + nested anchors
    const allDirectChildren = [...directFilteredChildren, ...directAnchorChildren];

    if (allDirectChildren.length === 0) continue;

    const res = await runPassA(store, anchor, allDirectChildren, opts, shapes, filterToIds);
    if (res) passAResults.set(anchorId, res);
  }

  // Process selected containers that have selected children (not inside anchor/other selected)
  for (const sc of topLevelSelectedContainers) {
    // Children of this selected container that are selected
    const directFilteredChildren = [...selectedLeaves, ...selectedContainers].filter(
      (s) => s.parentId === sc.id,
    );
    if (directFilteredChildren.length === 0) continue;

    const res = await runPassA(store, sc, directFilteredChildren, opts, shapes, filterToIds);
    if (res) passAResults.set(sc.id, res);
  }

  // =====================================================================
  // Pass B: top-level layout
  // Frames with Pass A results treated as leaf nodes with computed sizes.
  // =====================================================================

  // Top-level ELK nodes
  const elkChildren: ElkNode[] = [];

  // Selected containers as leaf nodes (with Pass A computed sizes or original sizes)
  for (const sc of topLevelSelectedContainers) {
    const passARes = passAResults.get(sc.id);
    const origB = shapeBounds(sc);
    const w = passARes ? passARes.newW : origB.w;
    const h = passARes ? passARes.newH : origB.h;
    elkChildren.push({ id: sc.id, width: Math.max(20, w), height: Math.max(20, h) });
  }

  // Top-level selected leaves
  for (const s of topLevelSelectedLeaves) {
    const b = shapeBounds(s);
    elkChildren.push({ id: s.id, width: Math.max(20, b.w), height: Math.max(20, b.h) });
  }

  if (elkChildren.length === 0) {
    // Nothing to layout
    return { positions: {}, anchorFrameIds };
  }

  // Build edges for Pass B.
  // Cross-compound edges: if both endpoints are children of different top-level selected containers,
  // remap them to container-to-container edge.
  const topLevelNodeIds = new Set(elkChildren.map((c) => c.id));

  // Map child → its top-level container (if applicable)
  const childToTopContainer = new Map<string, string>();
  for (const sc of topLevelSelectedContainers) {
    for (const s of [...selectedLeaves, ...selectedContainers]) {
      if (s.parentId === sc.id) childToTopContainer.set(s.id, sc.id);
    }
    // Also nested children through passA results
    const passARes = passAResults.get(sc.id);
    if (passARes) {
      for (const childId of passARes.childPositions.keys()) {
        childToTopContainer.set(childId, sc.id);
      }
    }
  }

  // Build edges remapping child endpoints to their top-level container
  const passBEdgeIds = new Set<string>();
  const passBEdges: ElkEdge[] = [];
  const arrows = collectArrows(store);
  for (const a of arrows) {
    const bs = bindingsForArrow(store, a.id);
    if (bs.length !== 2) continue;
    const start = bs.find((b) => (b.props as { terminal?: string } | undefined)?.terminal === "start");
    const end = bs.find((b) => (b.props as { terminal?: string } | undefined)?.terminal === "end");
    const rawSrc = start?.toId ?? bs[0]?.toId;
    const rawTgt = end?.toId ?? bs[1]?.toId;
    if (!rawSrc || !rawTgt) continue;

    // Resolve endpoints to top-level nodes
    const src = topLevelNodeIds.has(rawSrc) ? rawSrc : (childToTopContainer.get(rawSrc) ?? null);
    const tgt = topLevelNodeIds.has(rawTgt) ? rawTgt : (childToTopContainer.get(rawTgt) ?? null);

    if (!src || !tgt || src === tgt) continue;
    if (!topLevelNodeIds.has(src) || !topLevelNodeIds.has(tgt)) continue;

    // Deduplicate edges (multiple cross-compound children might generate same container edge)
    const edgeKey = `${src}->${tgt}`;
    if (passBEdgeIds.has(edgeKey)) continue;
    passBEdgeIds.add(edgeKey);
    passBEdges.push({ id: `${a.id}_passB`, sources: [src], targets: [tgt] });
  }

  // Single node: no layout needed (just preserve position)
  if (elkChildren.length === 1) {
    const positions: Positions = {};
    const node = elkChildren[0];
    if (node) {
      const origShape = shapes.find((s) => s.id === node.id);
      if (origShape) {
        const b = shapeBounds(origShape);
        positions[node.id] = { x: b.x, y: b.y, w: node.width, h: node.height };
      }
    }
    // Merge Pass A child positions
    for (const [, passARes] of passAResults) {
      for (const [childId, pos] of passARes.childPositions) {
        positions[childId] = { x: pos.x, y: pos.y };
      }
    }
    return { positions, anchorFrameIds };
  }

  const passBGraph: ElkGraph = {
    id: "root",
    layoutOptions: opts,
    children: elkChildren,
    edges: passBEdges,
  };

  let passBRes: ElkResult;
  try {
    passBRes = await elk.layout(passBGraph as never);
  } catch (_e) {
    return null;
  }

  const passBPositions = collectPositions(passBRes);

  // =====================================================================
  // Pass C: assemble final positions
  // =====================================================================
  const positions: Positions = {};

  // Top-level positions from Pass B
  for (const id in passBPositions) {
    const p = passBPositions[id];
    // For containers: use their computed Pass A size if available
    const passARes = passAResults.get(id);
    const w = passARes ? passARes.newW : p.w;
    const h = passARes ? passARes.newH : p.h;
    positions[id] = { x: p.x, y: p.y, w, h };
  }

  // Children parent-relative positions from Pass A
  for (const [, passARes] of passAResults) {
    for (const [childId, pos] of passARes.childPositions) {
      // Only record if not already in positions (top-level takes priority)
      if (!positions[childId]) {
        positions[childId] = { x: pos.x, y: pos.y };
      }
    }
  }

  // Anchor containers: original x/y stays, w/h from Pass A
  for (const anchorId of anchorFrameIds) {
    const anchor = frameById.get(anchorId);
    if (!anchor) continue;
    const origB = shapeBounds(anchor);
    const passARes = passAResults.get(anchorId);
    const w = passARes ? passARes.newW : origB.w;
    const h = passARes ? passARes.newH : origB.h;
    positions[anchorId] = { x: origB.x, y: origB.y, w, h };
  }

  return { positions, anchorFrameIds };
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

  // Subgraph mode: scope="affected" with affectedIds provided → DRW-091/092/099.
  const affectedIds = hint.affectedIds;
  const isSubgraphMode = fullHint.scope === "affected" && affectedIds && affectedIds.size > 0;

  // Pin set: only meta.pinned === true shapes (DRW-003).
  const pinnedSet = new Set<string>();
  for (const s of shapes) {
    if (isPinned(s)) pinnedSet.add(s.id);
  }

  let positions: Positions;
  let anchorFrameIds: Set<string>;

  if (isSubgraphMode) {
    // DRW-099: hierarchical multi-pass layout
    // biome-ignore lint/style/noNonNullAssertion: isSubgraphMode guarantees affectedIds is defined
    const result = await runLayoutSubgraph(store, shapes, fullHint, affectedIds!);
    if (!result) {
      return { batch: emptyBatch, affected: [], reason: "elk-error" };
    }
    positions = result.positions;
    anchorFrameIds = result.anchorFrameIds;
  } else {
    // scope='all': single-pass through INCLUDE_CHILDREN (unchanged behavior).
    const { graph, anchorFrameIds: aFI } = buildElkGraph(store, shapes, fullHint, undefined);
    anchorFrameIds = aFI;

    let res: { children?: unknown[]; edges?: unknown[] };
    try {
      res = await elk.layout(graph as never);
    } catch (_e) {
      return { batch: emptyBatch, affected: [], reason: "elk-error" };
    }
    positions = collectPositions(res);
  }

  // Restore pinned coords (ELK layered ignores fixed-position hints in elkjs 0.9.3 —
  // override after layout).
  for (const s of shapes) {
    if (pinnedSet.has(s.id) && positions[s.id] !== undefined) {
      positions[s.id] = { ...positions[s.id], x: s.x ?? 0, y: s.y ?? 0 };
    }
  }

  // DRW-091 AC#2: when selected shapes are top-level (no anchor frame and no selected containers),
  // translate ELK output to preserve original centroid. Prevents cluster from jumping to (0,0).
  // Only applies to subgraph mode. Disabled when selected containers are present (hierarchical pass
  // computes positions relative to containers which manage their own placement).
  const selectedContainerCount = isSubgraphMode && affectedIds
    ? shapes.filter((s) => isContainerShape(s) && affectedIds.has(s.id)).length
    : 0;
  if (isSubgraphMode && anchorFrameIds.size === 0 && selectedContainerCount === 0 && affectedIds && affectedIds.size > 0) {
    const selectedShapes = shapes.filter(
      (s) => affectedIds.has(s.id) && !pinnedSet.has(s.id) && !isContainerShape(s),
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
  const updated: Record<string, [TLRecord, TLRecord]> = {};
  const affected: string[] = [];
  const EPS = 1e-6;

  // DRW-082: collectPositions возвращает absolute page coords (через walk c
  // offsetX/Y накопителем). Но в tldraw shape с parentId=frame хранит x/y
  // RELATIVE к parent'у — иначе при render абсолютные координаты добавляются
  // к parent.x повторно и shape уезжает за границы frame. Конвертируем abs
  // обратно в parent-relative для children frame'ов.
  //
  // DRW-099: В subgraph mode positions для children от Pass A уже parent-relative
  // (ELK layout на детях относительно root=0,0 контейнера).
  // В scope='all' mode positions абсолютные (collectPositions с offset walk).
  const frameIds = new Set<string>();
  for (const s of shapes) {
    if (isContainerShape(s)) frameIds.add(s.id);
  }

  for (const s of shapes) {
    const p = positions[s.id];
    if (!p) continue;
    const isAnchor = anchorFrameIds.has(s.id);
    // In subgraph mode: только shapes из filterToIds или anchor-frames попадают в batch.
    if (isSubgraphMode && !isAnchor && affectedIds && !affectedIds.has(s.id)) continue;
    const oldB = shapeBounds(s);
    const isFrame = isContainerShape(s);
    const parentIsFrame =
      typeof s.parentId === "string" && frameIds.has(s.parentId);

    let newX: number;
    let newY: number;
    if (isAnchor) {
      // Anchor frame stays put — x/y из original; w/h ниже обновляется до ELK output.
      newX = oldB.x;
      newY = oldB.y;
    } else if (isSubgraphMode && parentIsFrame) {
      // In subgraph mode: Pass A уже вернул parent-relative coords, не нужно вычитать parent.
      newX = p.x;
      newY = p.y;
    } else if (!isSubgraphMode && parentIsFrame) {
      // In scope='all' mode: positions are absolute, convert to parent-relative.
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
