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

import { applyLayoutParamsDefaults, measureLabelHeuristic, modeToElkOptions, type LayoutMode, type LayoutParams, type Spacing } from "@shemma/domain";
import elkWorkerPath from "../../node_modules/elkjs/lib/elk-worker.min.js" with { type: "file" };
import type { StoreChangeBatch, TLRecord, TLStoreSnapshot } from "../store-types";
import type { ElementId, LayoutHint } from "./types";
import { effectiveShapeBounds } from "./shape-size";
import { inferContainerDirection, type Direction, type ExternalEdge } from "./directions";

// biome-ignore lint/suspicious/noExplicitAny: third-party CJS module
const ELK = require("elkjs/lib/main.js") as any;
// biome-ignore lint/suspicious/noExplicitAny: elk instance
const elk = new ELK({ workerUrl: elkWorkerPath }) as any;

const DEFAULT_W = 120;
const DEFAULT_H = 60;
const DEFAULT_FRAME_W = 400;
const DEFAULT_FRAME_H = 300;

// DRW-152: Mermaid subgraph direction → ELK direction mapping.
const MERMAID_DIR_TO_ELK: Record<string, string> = {
  TB: "DOWN",
  LR: "RIGHT",
  BT: "UP",
  RL: "LEFT",
};

function readContainerDirection(container: ShapeRec): string | undefined {
  if (container.type === "schema-container") {
    const d = (container.props as Record<string, unknown> | undefined)?.direction;
    if (d === "custom") return undefined;
    if (typeof d === "string" && MERMAID_DIR_TO_ELK[d]) return MERMAID_DIR_TO_ELK[d];
  }
  // DRW-178 Task 2.6: auto-inferred direction via inferContainerDirections pass.
  const inferred = container.meta?.didrawDirection;
  if (typeof inferred === "string" && MERMAID_DIR_TO_ELK[inferred]) {
    return MERMAID_DIR_TO_ELK[inferred];
  }
  // Legacy: didrawSubgraphDirection written by mermaid import.
  const subgraphDir = container.meta?.didrawSubgraphDirection;
  if (typeof subgraphDir === "string") return MERMAID_DIR_TO_ELK[subgraphDir];
  return undefined;
}

function isCustomDirection(container: ShapeRec): boolean {
  if (container.type !== "schema-container") return false;
  return (container.props as Record<string, unknown> | undefined)?.direction === "custom";
}

// DRW-003 displacement constants (preserved from Phase 2.x layout.ts).
const COLLISION_SLACK = 10;
const NODE_SPACING_X = 40;
const NODE_SPACING_Y = 20;

// Padding around children inside a container after Pass A layout.
// DRW-162: top padding увеличен с 40 до 72 — geo boundary рисует label
// сверху-по-середине; 40px давал overlap между title контейнера и first row
// child shapes. 72 ≈ font-height (m: ~24px) + breathing room.
const CONTAINER_PAD_TOP = 72;
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
  const baseH = readNumberProp(
    r.props,
    "h",
    isFrame ? DEFAULT_FRAME_H : DEFAULT_H,
  );
  // DRW-174: tldraw geo/note shapes use `growY` to extend height for text that
  // doesn't fit in `h` alone. Effective rendered height = `h + growY`. ELK must
  // see effective height so frame Pass A computes newH covering the full child
  // visual bounds. Without this growY ignored → frame.props.h stays at the
  // estimate while children visually overflow.
  const growY =
    r.type === "geo" || r.type === "note"
      ? readNumberProp(r.props, "growY", 0)
      : 0;
  const h = baseH + growY;
  const x = typeof r.x === "number" ? r.x : 0;
  const y = typeof r.y === "number" ? r.y : 0;
  return { x, y, w, h };
}

function isShape(r: TLRecord): r is ShapeRec {
  return r.typeName === "shape";
}

// DRW-178: extract plain text from arrow richText prop (ProseMirror doc).
function extractArrowLabel(shape: ShapeRec): string {
  const rt = (shape.props as { richText?: { content?: Array<{ content?: Array<{ text?: string }> }> } } | undefined)
    ?.richText;
  if (!rt?.content) return "";
  const parts: string[] = [];
  for (const block of rt.content) {
    if (!Array.isArray(block?.content)) continue;
    for (const span of block.content) {
      if (typeof span?.text === "string") parts.push(span.text);
    }
  }
  return parts.join("");
}

// DRW-178: compute max arrow label width from the store's arrows and return a
// label-derived layer spacing floor. Returns 0 when no labelled arrows found.
// Accepts store directly because collectShapes() filters out arrows (they are
// not ELK layout candidates), so we use collectArrows() to read them.
function computeLabelDerivedSpacing(store: TLStoreSnapshot, params: LayoutParams): number {
  let maxLabelWidth = 0;
  for (const s of collectArrows(store)) {
    const text = extractArrowLabel(s);
    if (!text) continue;
    const m = measureLabelHeuristic(text, {
      maxWidth: params.edgeLabelMaxWidth,
      maxLines: params.edgeLabelMaxLines,
      fontSize: params.edgeLabelFontSize,
    });
    if (m.width > maxLabelWidth) maxLabelWidth = m.width;
  }
  return maxLabelWidth > 0 ? maxLabelWidth + params.edgeLabelMargin * 2 : 0;
}

function isLayoutCandidate(r: ShapeRec): boolean {
  // Arrows позиционируются через bindings → не участвуют в ELK input/output.
  return r.type !== "arrow";
}

// DRW-098: container = tldraw frame ИЛИ geo+role=boundary (DRW-084 Mermaid
// subgraphs рендерятся как geo с meta.role="boundary" а не как frame —
// layout должен трактовать их как compound contаiner identical to frame).
// DRW-157: storage-mode mermaid wrappers исторически писали meta.didrawSubgraph
// без meta.role — также считаем containers для совместимости (новые шейпы
// пишут оба поля, но старые комнаты могут содержать только didrawSubgraph).
function isContainerShape(r: ShapeRec): boolean {
  if (r.type === "frame") return true;
  if (r.type === "schema-container") return true;
  if (r.type === "geo" && r.meta?.role === "boundary") return true;
  if (r.type === "geo" && r.meta?.didrawSubgraph === true) return true;
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

/**
 * Resolve raw src/tgt shape ids for an arrow from its bindings.
 * Returns null if arrow has !=2 bindings or either endpoint id missing.
 */
function resolveArrowEndpoints(
  store: TLStoreSnapshot,
  arrowId: string,
): { src: string; tgt: string } | null {
  const bs = bindingsForArrow(store, arrowId);
  if (bs.length !== 2) return null;
  const start = bs.find((b) => (b.props as { terminal?: string } | undefined)?.terminal === "start");
  const end = bs.find((b) => (b.props as { terminal?: string } | undefined)?.terminal === "end");
  const src = start?.toId ?? bs[0]?.toId;
  const tgt = end?.toId ?? bs[1]?.toId;
  if (!src || !tgt) return null;
  return { src, tgt };
}

/** Collect ELK edges from arrow bindings. Only edges where both endpoints are in includedIds. */
function buildEdges(
  store: TLStoreSnapshot,
  includedIds: Set<string>,
): ElkEdge[] {
  const edges: ElkEdge[] = [];
  for (const a of collectArrows(store)) {
    const ep = resolveArrowEndpoints(store, a.id);
    if (!ep) continue;
    if (!includedIds.has(ep.src) || !includedIds.has(ep.tgt)) continue;
    edges.push({ id: a.id, sources: [ep.src], targets: [ep.tgt] });
  }
  return edges;
}

/**
 * DRW-161: Pass A edge collection с cross-subgraph lift'ом.
 *
 * Возвращает edges для ELK input в Pass A. В отличие от buildEdges:
 * - Если arrow endpoint находится в childIds — оставляем напрямую.
 * - Если endpoint — leaf внутри одного из child-containers childIds — поднимаем
 *   ID до этого container'а (как Pass B `liftToTopLevel`).
 * - Если оба endpoint после lift'а попали в childIds и различны — добавляем
 *   container→container ребро (дедупликация по `src->tgt`).
 *
 * Это даёт ELK информацию о потоке между nested compounds на уровне Pass A
 * и позволяет layered ranking'у выстроить chain (например Вход → Оркестрация
 * → Результат → Доставка → Потребители → EC).
 */
function buildPassAEdges(
  store: TLStoreSnapshot,
  childIds: Set<string>,
  allShapes: ShapeRec[],
): ElkEdge[] {
  // Карта shape.id → ancestor in childIds (lift up to closest child of this Pass A's container).
  const shapeById = new Map(allShapes.map((s) => [s.id, s]));
  const liftCache = new Map<string, string | null>();
  const lift = (rawId: string): string | null => {
    if (childIds.has(rawId)) return rawId;
    const cached = liftCache.get(rawId);
    if (cached !== undefined) return cached;
    let current = shapeById.get(rawId);
    let safety = 32;
    while (current && current.parentId && safety-- > 0) {
      if (childIds.has(current.parentId)) {
        liftCache.set(rawId, current.parentId);
        return current.parentId;
      }
      current = shapeById.get(current.parentId);
    }
    liftCache.set(rawId, null);
    return null;
  };

  const edges: ElkEdge[] = [];
  const seen = new Set<string>();
  for (const a of collectArrows(store)) {
    const ep = resolveArrowEndpoints(store, a.id);
    if (!ep) continue;
    const src = lift(ep.src);
    const tgt = lift(ep.tgt);
    if (!src || !tgt || src === tgt) continue;
    if (!childIds.has(src) || !childIds.has(tgt)) continue;
    const key = `${src}->${tgt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: `${a.id}_pa`, sources: [src], targets: [tgt] });
  }
  return edges;
}

/** DRW-158: count connected components in an undirected view of (nodes, edges). */
function countConnectedComponents(nodes: { id: string }[], edges: ElkEdge[]): number {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    for (const s of e.sources) {
      for (const t of e.targets) {
        adj.get(s)?.add(t);
        adj.get(t)?.add(s);
      }
    }
  }
  const seen = new Set<string>();
  let components = 0;
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    components++;
    const stack = [n.id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const neighbors = adj.get(cur);
      if (neighbors) for (const nb of neighbors) stack.push(nb);
    }
  }
  return components;
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
 * Used for scope='all' single-pass layout (INCLUDE_CHILDREN). For subgraph mode
 * (scope='affected'), runLayoutSubgraph implements hierarchical multi-pass (DRW-099).
 */
function buildElkGraph(
  store: TLStoreSnapshot,
  shapes: ShapeRec[],
  hint: Required<LayoutHint>,
  params: LayoutParams,
): unknown {
  const opts = modeToElkOptions(hint.mode, hint.spacing);
  // DRW-178: reserve horizontal layer spacing for the widest arrow label so
  // labels never overflow into neighbouring shapes/arrows.
  const labelDerivedSpacing = computeLabelDerivedSpacing(store, params);
  if (labelDerivedSpacing > 0) {
    const key = "elk.layered.spacing.nodeNodeBetweenLayers";
    opts[key] = String(Math.max(Number(opts[key] ?? 0), labelDerivedSpacing));
  }

  // Partition shapes: frames (compound) vs leaves.
  const frames = shapes.filter(isContainerShape);
  const leaves = shapes.filter((s) => !isContainerShape(s));

  // Children of each frame; leaves whose parent is not a frame become top-level.
  const childrenByFrame = new Map<string, ShapeRec[]>();
  for (const f of frames) childrenByFrame.set(f.id, []);
  const topLevel: ShapeRec[] = [];
  for (const s of leaves) {
    if (s.parentId && childrenByFrame.has(s.parentId)) {
      childrenByFrame.get(s.parentId)!.push(s);
    } else {
      topLevel.push(s);
    }
  }

  const buildLeaf = (s: ShapeRec): ElkNode => {
    const b = effectiveShapeBounds(s, shapeBounds(s));
    return { id: s.id, width: Math.max(20, b.w), height: Math.max(20, b.h), ports: [] };
  };

  // DRW-092 v3: frames используют тот же layered algorithm что и outer — сохраняем
  // ranks + edge routing. Не зажимаем размер: ELK сам вычислит compound size под
  // реальный children layout, мы это запишем в frame.props.w/h.
  const buildFrame = (f: ShapeRec): ElkNode => {
    const b = shapeBounds(f);
    return {
      id: f.id,
      width: b.w,
      height: b.h,
      layoutOptions: { ...opts, "elk.padding": "[top=40,left=20,bottom=20,right=20]" },
      children: (childrenByFrame.get(f.id) ?? []).map(buildLeaf),
    };
  };

  // Edges from bindings — без фильтра по присутствию endpoint'а в shapes.
  // В scope='all' dangling bindings (toId на несуществующую запись) намеренно
  // прокидываются в ELK: тот вернёт ошибку, runLayout вернёт reason='elk-error'
  // (см. test: 'returns reason elk-error when ELK fails (edge references missing node)').
  const edges: ElkEdge[] = [];
  for (const a of collectArrows(store)) {
    const ep = resolveArrowEndpoints(store, a.id);
    if (!ep) continue;
    edges.push({ id: a.id, sources: [ep.src], targets: [ep.tgt] });
  }

  return {
    id: "root",
    layoutOptions: { ...opts, "elk.hierarchyHandling": "INCLUDE_CHILDREN" },
    children: [...topLevel.map(buildLeaf), ...frames.map(buildFrame)],
    edges,
  };
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
  /** parent-relative coords of children laid out inside this container.
   * For container children (nested frames), w/h carry Pass A computed size. */
  childPositions: Map<string, { x: number; y: number; w?: number; h?: number }>;
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
  // DRW-152/DRW-150: override ELK direction if container has didrawSubgraphDirection (legacy)
  // or schema-container props.direction (new). custom direction → undefined (no override).
  const elkDir = readContainerDirection(container);
  const containerOpts = elkDir !== undefined
    ? { ...opts, "elk.direction": elkDir }
    : opts;

  // Разделим детей на листья и контейнеры
  const childContainers = filteredChildren.filter(isContainerShape);
  const childLeaves = filteredChildren.filter((s) => !isContainerShape(s));

  // Сначала рекурсивно обработаем вложенные контейнеры (Pass A рекурсия).
  // Для каждого child-контейнера соберём его direct selected non-container children
  // и запустим Pass A рекурсивно. Container collectShapes уже отфильтровал arrows.
  const nestedResults = new Map<string, ContainerPassResult>();
  for (const cc of childContainers) {
    if (isCustomDirection(cc)) continue; // DRW-150: custom direction → preserve children positions
    const ccSelectedChildren = allShapes.filter(
      (s) => s.parentId === cc.id && !isContainerShape(s) && filterToIds.has(s.id),
    );
    if (ccSelectedChildren.length === 0) continue;
    const nestedRes = await runPassA(store, cc, ccSelectedChildren, opts, allShapes, filterToIds);
    if (nestedRes) nestedResults.set(cc.id, nestedRes);
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

  // Обычные листья — используем effective bounds чтобы ELK учитывал props.size
  for (const s of childLeaves) {
    const b = effectiveShapeBounds(s, shapeBounds(s));
    elkChildren.push({ id: s.id, width: Math.max(20, b.w), height: Math.max(20, b.h) });
  }

  if (elkChildren.length === 0) return null;

  // Edges между детьми этого контейнера. DRW-161: помимо прямых рёбер
  // child↔child нужно lift'ить cross-subgraph рёбра — если arrow соединяет
  // два leaf'а в разных nested containers (которые сейчас выступают leaf'ами
  // в Pass A на этом уровне), это даёт container→container ребро. Без этого
  // ELK видит только containers без рёбер и раскладывает их arbitrary.
  const childIds = new Set(elkChildren.map((c) => c.id));
  const edges = buildPassAEdges(store, childIds, allShapes);

  // DRW-158: when direction is explicit (mermaid subgraph) but internal edges
  // не образуют connected graph, ELK layered с separateConnectedComponents=true
  // (default) располагает компоненты ORTHOGONALly к direction. Чтобы вынудить
  // ELK уважать direction даже для disconnected children, добавляем virtual
  // chain edges по declaration order. Edges помечаются "v_" prefix и не
  // пересекаются с реальными edge ID; ELK их использует только для ranking,
  // а edge geometry мы не читаем — берём только node positions.
  if (elkDir !== undefined && elkChildren.length >= 2) {
    const connected = countConnectedComponents(elkChildren, edges);
    if (connected > 1) {
      for (let i = 0; i < elkChildren.length - 1; i++) {
        edges.push({
          id: `v_chain_${i}`,
          sources: [elkChildren[i].id],
          targets: [elkChildren[i + 1].id],
        });
      }
    }
  }

  const graph: ElkGraph = {
    id: "root",
    layoutOptions: { ...containerOpts, "elk.padding": `[top=${CONTAINER_PAD_TOP},left=${CONTAINER_PAD_LR},bottom=${CONTAINER_PAD_BOT},right=${CONTAINER_PAD_LR}]` },
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
    if (p) {
      // DRW-154: propagate nested Pass A newW/newH into childPositions so that
      // Pass C can write the correct props.w/h for nested frames.
      const nested = nestedResults.get(cc.id);
      childPositions.set(cc.id, {
        x: p.x,
        y: p.y,
        w: nested ? nested.newW : undefined,
        h: nested ? nested.newH : undefined,
      });
    }

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
  params: LayoutParams,
  containerScope: "self" | "auto" = "auto",
): Promise<{ positions: Positions; anchorFrameIds: Set<string> } | null> {
  const opts = modeToElkOptions(hint.mode, hint.spacing);
  // DRW-178: reserve horizontal layer spacing for the widest arrow label so
  // labels never overflow into neighbouring shapes/arrows.
  const labelDerivedSpacing = computeLabelDerivedSpacing(store, params);
  if (labelDerivedSpacing > 0) {
    const key = "elk.layered.spacing.nodeNodeBetweenLayers";
    opts[key] = String(Math.max(Number(opts[key] ?? 0), labelDerivedSpacing));
  }

  const frames = shapes.filter(isContainerShape);
  const leaves = shapes.filter((s) => !isContainerShape(s));

  // Filtered children (non-container leaves that are selected)
  const selectedLeaves = leaves.filter((s) => filterToIds.has(s.id));
  // Selected containers
  const selectedContainers = frames.filter((f) => filterToIds.has(f.id));
  const frameById = new Map(frames.map((f) => [f.id, f]));

  // Anchor containers: NOT selected, but have ≥1 selected descendant (handles deep nesting).
  // First pass: direct selected leaf/container child. Then iterate until stable to propagate
  // anchor status up through nested anchor parents.
  //
  // containerScope === "self": skip anchor expansion entirely — we only re-layout the internal
  // children of the directly selected containers, leaving parent frames untouched (DRW-167).
  const anchorFrameIds = new Set<string>();
  if (containerScope !== "self") {
    for (const f of frames) {
      if (filterToIds.has(f.id)) continue;
      const hasDirectSelectedLeaf = selectedLeaves.some((s) => s.parentId === f.id);
      const hasDirectSelectedContainer = selectedContainers.some((c) => c.parentId === f.id);
      if (hasDirectSelectedLeaf || hasDirectSelectedContainer) anchorFrameIds.add(f.id);
    }
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

  // Direct selected children (leaves + containers) of a given parent id.
  const directSelectedChildrenOf = (parentId: string): ShapeRec[] => {
    const out: ShapeRec[] = [];
    for (const s of selectedLeaves) if (s.parentId === parentId) out.push(s);
    for (const c of selectedContainers) if (c.parentId === parentId) out.push(c);
    return out;
  };

  // =====================================================================
  // Pass A: layout children of each anchor container and selected containers
  // that have selected children.
  // =====================================================================

  // passAResults: containerId → ContainerPassResult
  const passAResults = new Map<string, ContainerPassResult>();

  // Process top-level anchors (they will recursively handle nested ones)
  // DRW-150 W2: When a container has direction='custom', ALL its descendants
  // (including nested non-custom containers) are skipped from Pass A.
  // This is intentional — custom = "user-controlled subtree". To re-layout
  // inner subtree without affecting outer, user must set outer back to TB/LR
  // via context menu, then trigger layout, then revert to custom if needed.
  for (const anchorId of topLevelAnchorIds) {
    const anchor = frameById.get(anchorId);
    if (!anchor) continue;
    if (isCustomDirection(anchor)) continue; // DRW-150: custom direction → preserve children positions

    // Direct filtered children + nested anchor frames as direct children.
    const directAnchorChildren = frames.filter(
      (f) => f.parentId === anchorId && anchorFrameIds.has(f.id),
    );
    const allDirectChildren = [...directSelectedChildrenOf(anchorId), ...directAnchorChildren];
    if (allDirectChildren.length === 0) continue;

    const res = await runPassA(store, anchor, allDirectChildren, opts, shapes, filterToIds);
    if (res) passAResults.set(anchorId, res);
  }

  // Process selected containers that have selected children (not inside anchor/other selected)
  for (const sc of topLevelSelectedContainers) {
    if (isCustomDirection(sc)) continue; // DRW-150: custom direction → preserve children positions
    const directFilteredChildren = directSelectedChildrenOf(sc.id);
    if (directFilteredChildren.length === 0) continue;

    const res = await runPassA(store, sc, directFilteredChildren, opts, shapes, filterToIds);
    if (res) passAResults.set(sc.id, res);
  }

  // =====================================================================
  // containerScope === "self": return after Pass A — no Pass B, no top-level
  // repositioning. Parent frames keep their original bounds (DRW-167).
  // =====================================================================
  if (containerScope === "self") {
    const positions: Positions = {};
    for (const [, passARes] of passAResults) {
      for (const [childId, pos] of passARes.childPositions) {
        positions[childId] = { x: pos.x, y: pos.y, w: pos.w, h: pos.h };
      }
      // Include the container itself so its w/h gets updated to the Pass A result.
      const container = frameById.get(passARes.containerId);
      if (container) {
        const origB = shapeBounds(container);
        positions[passARes.containerId] = {
          x: origB.x,
          y: origB.y,
          w: passARes.newW,
          h: passARes.newH,
        };
      }
    }
    return { positions, anchorFrameIds };
  }

  // =====================================================================
  // Pass B: top-level layout
  // Frames with Pass A results treated as leaf nodes with computed sizes.
  // =====================================================================

  // Container size: Pass A computed size when available, original bounds otherwise.
  const sizeFor = (s: ShapeRec): { w: number; h: number } => {
    const passARes = passAResults.get(s.id);
    if (passARes) return { w: passARes.newW, h: passARes.newH };
    const b = shapeBounds(s);
    return { w: b.w, h: b.h };
  };

  // Top-level ELK nodes: selected containers (as leaves with Pass A size) + selected bare leaves.
  const elkChildren: ElkNode[] = [];
  for (const sc of topLevelSelectedContainers) {
    const { w, h } = sizeFor(sc);
    elkChildren.push({ id: sc.id, width: Math.max(20, w), height: Math.max(20, h) });
  }
  for (const s of topLevelSelectedLeaves) {
    const b = effectiveShapeBounds(s, shapeBounds(s));
    elkChildren.push({ id: s.id, width: Math.max(20, b.w), height: Math.max(20, b.h) });
  }

  if (elkChildren.length === 0) {
    // No top-level selected shapes to lay out in Pass B.
    // Still return Pass A child positions (e.g. children-only selection where
    // the parent frame is an anchor not in selection — AC-2).
    const positions: Positions = {};
    // Anchor containers: original x/y stays, w/h from Pass A if computed.
    for (const anchorId of anchorFrameIds) {
      const anchor = frameById.get(anchorId);
      if (!anchor) continue;
      const origB = shapeBounds(anchor);
      const passARes = passAResults.get(anchorId);
      const w = passARes ? passARes.newW : origB.w;
      const h = passARes ? passARes.newH : origB.h;
      positions[anchorId] = { x: origB.x, y: origB.y, w, h };
    }
    // Children parent-relative positions from Pass A.
    // DRW-154: pos.w/h carry nested Pass A computed size for container children.
    for (const [, passARes] of passAResults) {
      for (const [childId, pos] of passARes.childPositions) {
        if (!positions[childId]) {
          positions[childId] = { x: pos.x, y: pos.y, w: pos.w, h: pos.h };
        }
      }
    }
    return { positions, anchorFrameIds };
  }

  // Build edges for Pass B.
  // Cross-compound edges: if both endpoints are children of different top-level selected containers,
  // remap them to container-to-container edge.
  const topLevelNodeIds = new Set(elkChildren.map((c) => c.id));

  // Map child → its top-level container (if applicable)
  // DRW-099 v3: populate childToTopContainer из ВСЕХ shapes (не только selected).
  // Раньше использовали [...selectedLeaves, ...selectedContainers] — но при tldraw
  // mutex (user селектит frame → его children НЕ в selection) selectedLeaves пустой,
  // map пустой, cross-compound edges дропаются → ELK получает граф без рёбер →
  // arbitrary layered order.
  const childToTopContainer = new Map<string, string>();
  const topContainerIds = new Set(topLevelSelectedContainers.map((c) => c.id));
  const shapeById = new Map(shapes.map((s) => [s.id, s]));
  const ascendToTopContainer = (shapeId: string): string | null => {
    let current = shapeById.get(shapeId);
    let safety = 32;
    while (current && current.parentId && safety-- > 0) {
      if (topContainerIds.has(current.parentId)) return current.parentId;
      current = shapeById.get(current.parentId);
    }
    return null;
  };
  for (const s of shapes) {
    if (topContainerIds.has(s.id)) continue;
    const top = ascendToTopContainer(s.id);
    if (top) childToTopContainer.set(s.id, top);
  }

  // Build edges remapping child endpoints to their top-level container
  const passBEdgeIds = new Set<string>();
  const passBEdges: ElkEdge[] = [];
  const liftToTopLevel = (rawId: string): string | null =>
    topLevelNodeIds.has(rawId) ? rawId : (childToTopContainer.get(rawId) ?? null);

  for (const a of collectArrows(store)) {
    const ep = resolveArrowEndpoints(store, a.id);
    if (!ep) continue;

    // Resolve endpoints to top-level nodes
    const src = liftToTopLevel(ep.src);
    const tgt = liftToTopLevel(ep.tgt);
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
      const origShape = shapeById.get(node.id);
      if (origShape) {
        const b = shapeBounds(origShape);
        positions[node.id] = { x: b.x, y: b.y, w: node.width, h: node.height };
      }
    }
    // Merge Pass A child positions
    // DRW-154: pos.w/h carry nested Pass A computed size for container children.
    for (const [, passARes] of passAResults) {
      for (const [childId, pos] of passARes.childPositions) {
        positions[childId] = { x: pos.x, y: pos.y, w: pos.w, h: pos.h };
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
  // DRW-154: pos.w/h carry nested Pass A computed size for container children.
  for (const [, passARes] of passAResults) {
    for (const [childId, pos] of passARes.childPositions) {
      // Only record if not already in positions (top-level takes priority)
      if (!positions[childId]) {
        positions[childId] = { x: pos.x, y: pos.y, w: pos.w, h: pos.h };
      }
    }
  }

  // Anchor containers: original x/y stays, w/h from Pass A (if computed) or original.
  for (const anchorId of anchorFrameIds) {
    const anchor = frameById.get(anchorId);
    if (!anchor) continue;
    const origB = shapeBounds(anchor);
    const { w, h } = sizeFor(anchor);
    positions[anchorId] = { x: origB.x, y: origB.y, w, h };
  }

  return { positions, anchorFrameIds };
}

// =====================================================================
// DRW-178 Task 2.6: Auto-infer direction for containers without explicit setting.
// =====================================================================

/**
 * Compute the parent direction for a container by walking up the shape hierarchy.
 * Returns the direction of the nearest ancestor container that has a readable
 * direction, or "TB" as the universal default.
 */
function getParentDirection(
  container: ShapeRec,
  shapeById: Map<string, ShapeRec>,
): Direction {
  let current = container;
  let safety = 32;
  while (current.parentId && safety-- > 0) {
    const parent = shapeById.get(current.parentId);
    if (!parent) break;
    if (isContainerShape(parent)) {
      // Read explicit direction from parent (meta or props), not inferred yet.
      // We read didrawSubgraphDirection (legacy mermaid) and schema-container props.
      if (parent.type === "schema-container") {
        const d = (parent.props as Record<string, unknown> | undefined)?.direction;
        if (typeof d === "string" && d !== "custom" && MERMAID_DIR_TO_ELK[d]) {
          return d as Direction;
        }
      }
      const metaDir = parent.meta?.didrawSubgraphDirection ?? parent.meta?.didrawDirection;
      if (typeof metaDir === "string" && (metaDir === "TB" || metaDir === "BT" || metaDir === "LR" || metaDir === "RL")) {
        return metaDir as Direction;
      }
    }
    current = parent;
  }
  return "TB";
}

/**
 * DRW-178 Task 2.6: For each container without an explicit direction set,
 * compute the optimal direction using the parallel-lanes algorithm and return
 * it as meta.didrawDirection writes in a StoreChangeBatch.
 *
 * "Explicit direction" means:
 *   - schema-container: props.direction is a valid direction (not "custom")
 *   - any container: meta.didrawDirection or meta.didrawSubgraphDirection already set
 *
 * When autoDirectionEnabled === false, returns an empty batch (no inference).
 */
function inferContainerDirections(
  store: TLStoreSnapshot,
  shapes: ShapeRec[],
  params: LayoutParams,
): StoreChangeBatch {
  const batch: StoreChangeBatch = { added: {}, updated: {}, removed: {} };
  if (params.autoDirectionEnabled === false) return batch;

  const containers = shapes.filter(isContainerShape);
  if (containers.length === 0) return batch;

  const shapeById = new Map(shapes.map((s) => [s.id, s]));

  // Build subtree membership: shape.id → set of ancestor container ids.
  // Used to determine if an arrow endpoint is inside a given container.
  const ancestorContainerIds = (shapeId: string): Set<string> => {
    const result = new Set<string>();
    let current = shapeById.get(shapeId);
    let safety = 32;
    while (current && current.parentId && safety-- > 0) {
      result.add(current.parentId);
      current = shapeById.get(current.parentId);
    }
    return result;
  };

  // Collect all arrows with their endpoints.
  const arrows: Array<{ src: string; tgt: string }> = [];
  for (const a of collectArrows(store)) {
    const ep = resolveArrowEndpoints(store, a.id);
    if (ep) arrows.push(ep);
  }

  for (const container of containers) {
    // Skip if explicit direction is set.
    if (container.type === "schema-container") {
      const d = (container.props as Record<string, unknown> | undefined)?.direction;
      if (typeof d === "string" && d !== "custom" && MERMAID_DIR_TO_ELK[d]) continue;
    }
    if (typeof container.meta?.didrawSubgraphDirection === "string") continue;
    if (typeof container.meta?.didrawDirection === "string") continue;

    // Collect direct children of this container.
    const directChildIds = new Set<string>();
    for (const s of shapes) {
      if (s.parentId === container.id) directChildIds.add(s.id);
    }
    if (directChildIds.size === 0) continue;

    // For each direct child, compute which sides external edges come from/go to.
    // "External" means the other endpoint is NOT inside this container's subtree.
    const externalEdgesPerChild = new Map<string, ExternalEdge[]>();
    for (const childId of directChildIds) {
      externalEdgesPerChild.set(childId, []);
    }

    // Pre-compute sibling order for side determination.
    // parentDirection is needed to map sibling order to cardinal side.
    const parentDirection = getParentDirection(container, shapeById);

    // Get ordered siblings of container in parent scope (sibling order as proxy for position).
    const containerParentId = container.parentId;
    const siblings: string[] = [];
    if (containerParentId) {
      for (const s of shapes) {
        if (s.parentId === containerParentId) siblings.push(s.id);
      }
    }
    const idxContainer = siblings.indexOf(container.id);

    /**
     * Given an external shape (outside this container), determine which cardinal
     * side relative to this container the edge comes from.
     * Uses sibling order in parent as position proxy.
     */
    const sideRelativeToContainer = (externalShapeId: string): ExternalEdge["side"] | null => {
      // Find the sibling-of-container ancestor of externalShape.
      let current = shapeById.get(externalShapeId);
      let safety = 32;
      let ancestor: ShapeRec | undefined;
      while (current && safety-- > 0) {
        if (current.parentId === containerParentId) {
          ancestor = current;
          break;
        }
        if (!current.parentId) break;
        current = shapeById.get(current.parentId);
      }
      if (!ancestor) return null;

      const idxA = siblings.indexOf(ancestor.id);
      if (idxA === -1 || idxA === idxContainer) return null;

      const before = idxA < idxContainer;
      switch (parentDirection) {
        case "TB": return before ? "top" : "bottom";
        case "BT": return before ? "bottom" : "top";
        case "LR": return before ? "left" : "right";
        case "RL": return before ? "right" : "left";
      }
    };

    /**
     * Given a direct child of container and the other endpoint of an arrow,
     * check if the other endpoint is outside this container's subtree.
     * If so, compute the cardinal side and push it.
     */
    const processArrowEndpoint = (childId: string, otherEndpointId: string): void => {
      // Is the other endpoint inside this container?
      const otherAncestors = ancestorContainerIds(otherEndpointId);
      if (otherAncestors.has(container.id)) return; // internal edge, skip
      // Check if otherEndpoint is the container itself
      if (otherEndpointId === container.id) return;

      const side = sideRelativeToContainer(otherEndpointId);
      if (side) {
        externalEdgesPerChild.get(childId)?.push({ side });
      }
    };

    // Walk all arrows: for each endpoint that is a direct child of this container,
    // check if the other endpoint is external.
    for (const arrow of arrows) {
      // Find which side of the arrow is inside this container.
      // Walk up from src to check if any ancestor is a direct child of container.
      const findDirectChild = (shapeId: string): string | null => {
        if (directChildIds.has(shapeId)) return shapeId;
        let current = shapeById.get(shapeId);
        let safety = 32;
        while (current && current.parentId && safety-- > 0) {
          if (current.parentId === container.id) return current.id;
          current = shapeById.get(current.parentId);
        }
        return null;
      };

      const srcChild = findDirectChild(arrow.src);
      const tgtChild = findDirectChild(arrow.tgt);

      if (srcChild && !tgtChild) {
        // src is inside container, tgt is outside → outgoing external edge
        processArrowEndpoint(srcChild, arrow.tgt);
      } else if (tgtChild && !srcChild) {
        // tgt is inside container, src is outside → incoming external edge
        processArrowEndpoint(tgtChild, arrow.src);
      }
      // If both are inside or both outside → skip (internal or irrelevant)
    }

    // Only infer when there are actual external edges to reason about.
    // If no external edges exist → let ELK inherit the outer layout direction
    // (the existing behavior before DRW-178 Task 2.6). Writing TB here would
    // override ELK's own direction inheritance which tests rely on.
    const totalExternalEdges = [...externalEdgesPerChild.values()].reduce((sum, e) => sum + e.length, 0);
    if (totalExternalEdges === 0) continue;

    // Apply inference algorithm.
    const inferred = inferContainerDirection({
      container,
      parentDirection,
      externalEdgesPerChild,
    });

    // Write inferred direction to meta.didrawDirection.
    const updated: ShapeRec = {
      ...container,
      meta: { ...(container.meta ?? {}), didrawDirection: inferred },
    };
    batch.updated[container.id] = [container, updated as TLRecord];
  }

  return batch;
}

/**
 * Apply a StoreChangeBatch to a TLStoreSnapshot, returning a new snapshot
 * with the updated records merged in. Used to apply direction inference
 * before layout passes so they see inferred directions.
 */
function applyBatchToStore(store: TLStoreSnapshot, batch: StoreChangeBatch): TLStoreSnapshot {
  if (Object.keys(batch.updated).length === 0 && Object.keys(batch.added).length === 0) {
    return store;
  }
  const newStore: Record<string, TLRecord> = { ...store.store };
  for (const id in batch.updated) {
    const [, newRec] = batch.updated[id]!;
    newStore[id] = newRec;
  }
  for (const id in batch.added) {
    newStore[id] = batch.added[id]!;
  }
  return { ...store, store: newStore };
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
  paramsPartial?: Partial<LayoutParams>,
): Promise<{ batch: StoreChangeBatch; affected: string[]; reason?: string }> {
  const params = applyLayoutParamsDefaults(paramsPartial ?? {});
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

  // DRW-178 Task 2.6: auto-infer direction for containers without explicit setting.
  // Must run BEFORE layout passes so readContainerDirection sees inferred meta.didrawDirection.
  const directionInferenceBatch = inferContainerDirections(store, shapes, params);
  const storeForLayout = applyBatchToStore(store, directionInferenceBatch);
  // Refresh shapes from updated store so layout passes see inferred directions in meta.
  const shapesForLayout = collectShapes(storeForLayout);

  // Subgraph mode: scope="affected" with affectedIds provided → DRW-091/092/099.
  // DRW-149 GAP-1: mutable so we can expand containers below.
  let affectedIds = hint.affectedIds;
  // DRW-150: scope='all' (Cmd+Shift+L) overrides custom direction containers.
  // Per user expectation — global layout request implies "re-layout everything".
  // Per-container preserve (custom direction) applies only in scope='affected' path.
  const isSubgraphMode = fullHint.scope === "affected" && affectedIds && affectedIds.size > 0;

  // Pin set: only meta.pinned === true shapes (DRW-003).
  const pinnedSet = new Set<string>();
  // Container ids (frame OR geo+role=boundary) — used both for parent-relative conversion
  // (DRW-082) and origin-preservation top-level filter below.
  const containerIds = new Set<string>();
  const shapeById = new Map<string, ShapeRec>();
  for (const s of shapesForLayout) {
    if (isPinned(s)) pinnedSet.add(s.id);
    if (isContainerShape(s)) containerIds.add(s.id);
    shapeById.set(s.id, s);
  }

  let positions: Positions;
  let anchorFrameIds: Set<string>;

  if (isSubgraphMode) {
    // DRW-149 GAP-1 fix: frame-expand — when affectedIds contains a container (frame or
    // geo+boundary), recursively add its direct children so Pass A actually runs on them.
    // Without this: directSelectedChildrenOf(containerId) returns [] → Pass A skipped → noop
    // (probe Cases 1 and 2).
    //
    // Applied UNCONDITIONALLY (no guard on selection composition):
    //   - {frame}             → expand frame.children → Pass A on frame.children + frame resize
    //   - {frame, ext}        → expand frame.children → Pass A inside frame +
    //                            Pass B on {frame, ext} as top-level peers (G3: два прохода)
    //   - nested containers   → recurse into nested frames
    //
    // Архитектурно: expanded children имеют parentId = frame (не page) → они НЕ попадают
    // в topLevelSelected (Pass B видит только original {frame, ext}). frame.children идут
    // через Pass A → parent-relative coords → frame resize from Pass A → frame size feeds
    // into Pass B. Pass B/A разделение сохраняется.
    // biome-ignore lint/style/noNonNullAssertion: isSubgraphMode guarantees affectedIds is defined
    const expanded = new Set<string>(affectedIds!);
    const expandContainer = (containerId: string): void => {
      for (const s of shapesForLayout) {
        if (s.parentId !== containerId) continue;
        expanded.add(s.id);
        if (containerIds.has(s.id)) {
          // Recurse into nested containers
          expandContainer(s.id);
        }
      }
    };
    // biome-ignore lint/style/noNonNullAssertion: isSubgraphMode guarantees affectedIds is defined
    for (const id of affectedIds!) {
      if (containerIds.has(id)) {
        expandContainer(id);
      }
    }
    // Reassign so downstream batch-filter (uses affectedIds) includes expanded children.
    affectedIds = expanded;

    // DRW-099: hierarchical multi-pass layout
    const result = await runLayoutSubgraph(storeForLayout, shapesForLayout, fullHint, affectedIds, params, hint.containerScope ?? "auto");
    if (!result) {
      return { batch: emptyBatch, affected: [], reason: "elk-error" };
    }
    positions = result.positions;
    anchorFrameIds = result.anchorFrameIds;
  } else {
    // scope='all': single-pass through INCLUDE_CHILDREN (unchanged behavior).
    // No anchor frames in scope='all' — every shape participates.
    anchorFrameIds = new Set();
    const graph = buildElkGraph(storeForLayout, shapesForLayout, fullHint, params);

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
  for (const s of shapesForLayout) {
    if (pinnedSet.has(s.id) && positions[s.id] !== undefined) {
      positions[s.id] = { ...positions[s.id], x: s.x ?? 0, y: s.y ?? 0 };
    }
  }

  // DRW-091 AC#2 / DRW-099 v2: origin preservation для subgraph mode.
  // Анчоры (centroid baseline) — top-level selected shapes (containers + bare leaves at root).
  // Anchor frames (children selected, frame НЕ в selection) исключены — они уже stay-put через
  // override в Pass C. Pinned shapes тоже исключены — у них своя анкоринг.
  // DRW-149 GAP-2 investigation: origin preservation фильтрует только top-level shapes
  // (parentId === "page:page"). После GAP-1 frame-expand дети контейнера становятся
  // частью affectedIds, но их parent-relative coords из Pass A НЕ трогаются centroid
  // translation'ом — потому что их parentId != "page:page". GAP-2 не актуален.
  if (isSubgraphMode && affectedIds && affectedIds.size > 0) {
    const anchorShapes = shapesForLayout.filter(
      (s) =>
        affectedIds.has(s.id) &&
        !pinnedSet.has(s.id) &&
        !anchorFrameIds.has(s.id) &&
        (s.parentId === "page:page" || !s.parentId),
    );
    if (anchorShapes.length > 0) {
      let origCX = 0;
      let origCY = 0;
      let elkCX = 0;
      let elkCY = 0;
      let count = 0;
      for (const s of anchorShapes) {
        const ob = shapeBounds(s);
        origCX += ob.x + ob.w / 2;
        origCY += ob.y + ob.h / 2;
        const ep = positions[s.id];
        if (ep) {
          const w = ep.w ?? ob.w;
          const h = ep.h ?? ob.h;
          elkCX += ep.x + w / 2;
          elkCY += ep.y + h / 2;
          count++;
        }
      }
      if (count > 0) {
        origCX /= anchorShapes.length;
        origCY /= anchorShapes.length;
        elkCX /= count;
        elkCY /= count;
        const dx = origCX - elkCX;
        const dy = origCY - elkCY;
        // В subgraph mode children контейнеров хранятся parent-relative,
        // их трогать нельзя. Сдвигаем только top-level (parentId=page) shapes
        // и сами containers, кроме anchor (anchor stays put через override).
        for (const id in positions) {
          if (pinnedSet.has(id)) continue;
          if (anchorFrameIds.has(id)) continue;
          const shape = shapeById.get(id);
          const isTopLevel =
            !shape ||
            !shape.parentId ||
            shape.parentId === "page:page" ||
            !containerIds.has(shape.parentId);
          if (!isTopLevel) continue;
          const p = positions[id];
          positions[id] = { ...p, x: p.x + dx, y: p.y + dy };
        }
      }
    }
  }

  // DRW-003 displacement.
  applyDisplacement(positions, shapesForLayout, pinnedSet);

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
  for (const s of shapesForLayout) {
    const p = positions[s.id];
    if (!p) continue;
    const isAnchor = anchorFrameIds.has(s.id);
    // In subgraph mode: только shapes из filterToIds или anchor-frames попадают в batch.
    if (isSubgraphMode && !isAnchor && affectedIds && !affectedIds.has(s.id)) continue;
    const oldB = shapeBounds(s);
    const isFrame = containerIds.has(s.id);
    const parentIsFrame =
      typeof s.parentId === "string" && containerIds.has(s.parentId);

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
    // DRW-168: для leaf shapes — пишем effective w/h чтобы визуально shape
    // вырос под выбранный size (L/XL). ELK уже использовал effective dims;
    // теперь синхронизируем props чтобы форма на canvas совпадала.
    let newW: number | undefined;
    let newH: number | undefined;
    if (isFrame && typeof p.w === "number") {
      newW = p.w;
      newH = typeof p.h === "number" ? p.h : undefined;
    } else if (!isFrame) {
      const effB = effectiveShapeBounds(s, oldB);
      if (effB.w > oldB.w + EPS) newW = effB.w;
      if (effB.h > oldB.h + EPS) newH = effB.h;
    }

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

  // Merge direction inference writes into the layout batch.
  // Containers that moved will already have the updated meta from shapesForLayout in
  // their `updated[s.id]` entry above. For containers without position change we add
  // the meta-only inference write so callers persist the inferred direction.
  for (const id in directionInferenceBatch.updated) {
    if (!updated[id]) {
      updated[id] = directionInferenceBatch.updated[id]!;
    }
    // If already in updated (position changed), the new record already carries
    // the inferred meta because shapesForLayout was built from storeForLayout.
  }

  const batch: StoreChangeBatch = { added: {}, updated, removed: {} };

  // NOTE (DRW-178): computeElbowMidpoints is NOT called here. It runs in
  // runAndBroadcastAnchors (route layer) AFTER computeAnchors has written
  // meta.didrawSourcePort / meta.didrawTargetPort, so midpoints see correct ports.

  return { batch, affected };
}

export type { ElementId };
