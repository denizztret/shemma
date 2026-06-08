// Core B (autolayout rebuild): elkjs-driven re-layout of a drawn schema, run
// on the frontend editor. Replaces the legacy backend dagre layout behind ⌘⇧L.
//
// Design (validated by session 1–3 experiments, memory next-session-autolayout-rebuild):
//   - graph extracted from the tldraw store: geo nodes + sizes, schema-container
//     boundaries as elk compound nodes, edges from arrow bindings;
//   - elk `layered` + INCLUDE_CHILDREN; child coords are parent-relative → map
//     1:1 onto tldraw parent-relative x,y;
//   - pin discipline: nodes with meta.pinned keep their position (pixel-freeze
//     via post-override — elk lays out everything, we simply skip pinned);
//     containers with meta.didrawSizePinned keep their size;
//   - frame refit to content unless the frame itself is size-pinned;
//   - arrows are bound elbow shapes → tldraw re-routes them automatically when
//     the nodes move (single-lever elbow; full obstacle router deferred).

import type { LayoutAlgorithm, Spacing } from "@shemma/domain";
import type { ElkExtendedEdge, ElkNode } from "elkjs";
import ELK from "elkjs/lib/elk.bundled.js";
import type { Editor, TLShape, TLShapeId } from "tldraw";
import { withAutoFlipSuppressed } from "../shapes/schema-container/SchemaContainerAutoFlip";
import { buildFlowChainEdges } from "./flow-chains";
import {
  type Anchor,
  computeRespreadLevel,
  levelMinK,
  type RespreadNode,
} from "./respread";
import {
  type FlowNode,
  growOnlyBox,
  resolveOverlapsAlongFlow,
} from "./resolve-overlaps";

// elkjs is pure JS and runs on the main thread from the bundled build.
// Lazily constructed: building it eagerly at module load instantiates a worker
// that throws under bun's test runtime (no Worker), which would make this whole
// module — including its pure direction helpers — unimportable in unit tests.
let _elk: InstanceType<typeof ELK> | null = null;
const elk = (): InstanceType<typeof ELK> => (_elk ??= new ELK());

const DIR_MAP: Record<string, string> = {
  LR: "RIGHT",
  RL: "LEFT",
  TB: "DOWN",
  BT: "UP",
};
const DEFAULT_FRAME_DIR = "LR"; // schemas read left→right by default; per-frame meta overrides.

// Spacing presets with a wide spread. `between` = primary (layer) axis: it grows
// far more aggressively than the cross axis (`nodeNode`), so Roomy stretches
// mainly along the flow direction (horizontal for LR/RL, vertical for TB/BT) —
// elk maps `between` to the active direction automatically.
const SPREAD: Record<
  Spacing,
  {
    nodeNode: number;
    between: number;
    comp: number;
    edgeNode: number;
    edgeEdge: number;
    // node-width growth factor — Roomy widens boxes so labels wrap less AND the
    // frame gains cross-axis spread (esp. the missing horizontal stretch in TB,
    // where `between` only grows the vertical axis). Reversible via the captured
    // base width in meta.didrawBaseW.
    nodeW: number;
  }
> = {
  compact: {
    nodeNode: 34,
    between: 70,
    comp: 60,
    edgeNode: 16,
    edgeEdge: 12,
    nodeW: 1.0,
  },
  normal: {
    // Slightly roomier default so orthogonal arrows have lanes to route in:
    // nodeNode = cross-axis gap between siblings (arrows pass between them),
    // edgeNode/edgeEdge = clearance reserved around edges, between = inter-layer
    // gap where cross-layer arrows turn. Bumped for legibility on busy schemas.
    nodeNode: 92,
    between: 200,
    comp: 130,
    edgeNode: 38,
    edgeEdge: 26,
    nodeW: 1.0,
  },
  loose: {
    nodeNode: 160,
    between: 400,
    comp: 240,
    edgeNode: 48,
    edgeEdge: 36,
    nodeW: 1.5,
  },
};

function readSpacing(
  meta: Record<string, unknown> | undefined,
): Spacing | null {
  const lp = meta?.didrawLayoutParams as { spacing?: unknown } | undefined;
  const sp = lp?.spacing;
  return sp === "compact" || sp === "normal" || sp === "loose" ? sp : null;
}

// Pluggable placement engine (ELK algorithm) from meta.didrawLayoutParams.layoutEngine.
// Returns null when unset/invalid so the caller can fall through to a default.
function readEngine(
  meta: Record<string, unknown> | undefined,
): LayoutAlgorithm | null {
  const lp = meta?.didrawLayoutParams as { layoutEngine?: unknown } | undefined;
  const e = lp?.layoutEngine;
  return e === "layered" || e === "mrtree" || e === "stress" || e === "force"
    ? e
    : null;
}

/** Raw stored direction of a schema-container (props is canonical; meta fallback). */
function readContainerRawDir(s: TLShape): string | undefined {
  return (
    (s.props as { direction?: string } | undefined)?.direction ??
    (s.meta?.didrawDirection as string | undefined)
  );
}

/** A container carries an EXPLICIT user direction (not the import placeholder
 * nor "custom"). Such a direction takes priority and is honoured verbatim. */
function containerHasExplicitDir(container: TLShape): boolean {
  if (container.meta?.didrawDirectionInherited === true) return false;
  const raw = readContainerRawDir(container);
  return !!raw && raw !== "custom" && !!DIR_MAP[raw];
}

/**
 * Whether a container may be reversed by the flip-to-reduce-crossings pass.
 *
 * The flip pass mirrors a container's children along its flow axis (LR↔RL /
 * TB↔BT) to untangle external arrows. That auto-reversal is appropriate ONLY for
 * containers whose direction SENSE the user hasn't fixed — i.e. inherit/auto
 * containers. A container with an EXPLICIT cardinal direction encodes the user's
 * chosen sense (LR ≠ RL), so it must NOT be silently flipped back; otherwise
 * (a) the user's explicit pick looks like a no-op, and (b) a re-layout triggered
 * by editing a SIBLING re-evaluates the global optimum and flips this untouched
 * container — the "changing B reverses A" surprise. forceDirections (⌘⌥⇧L
 * clean-slate) re-infers every direction, so it re-enables flipping for all.
 */
export function isFlipEligible(
  container: TLShape,
  forceDirections: boolean,
): boolean {
  return forceDirections || !containerHasExplicitDir(container);
}

/** Flow axis perpendicular to the frame: horizontal frame (LR/RL) → vertical
 * container (TB); vertical frame (TB/BT) → horizontal (LR). The compactness
 * default for an inherit container — a "lane" across the frame's through-flow. */
function perpendicular(frameDir: string): string {
  return frameDir === "LR" || frameDir === "RL" ? "TB" : "LR";
}

/**
 * Direction for an inherit container — chosen by topology, NOT a blind rule, and
 * DELIBERATELY geometry-independent (so it never oscillates between re-layouts):
 *
 *   - container WITH an internal flow (≥1 edge between its own children) → laid
 *     out ALONG the frame's axis (parallel), so its chain reads in the same
 *     direction as the overall diagram (e.g. build→test→deploy stacks the way the
 *     frame flows);
 *   - container WITHOUT internal edges (a bundle of parallel items) →
 *     PERPENDICULAR to the frame, forming a lane ACROSS the through-flow.
 *
 * Both cases flip correctly when the frame direction flips. The reverse within
 * the chosen axis (TB↔BT / LR↔RL) is then optimised separately by the
 * flip-to-reduce-crossings pass.
 */
function inferInheritDir(
  kidIds: ReadonlySet<string>,
  frameDir: string,
  nodeEdges: ReadonlyArray<{ from: string; to: string }>,
): string {
  const hasInternalFlow = nodeEdges.some(
    (e) => kidIds.has(e.from) && kidIds.has(e.to),
  );
  return hasInternalFlow ? frameDir : perpendicular(frameDir);
}

/**
 * How an INHERIT container's direction is chosen for a given layout pass:
 *   - "auto"  → topology (internal-flow rule, the default);
 *   - "perp"  → forced perpendicular to the frame (narrow lanes — compactness).
 * The aspect-aware auto-direction search (autoLayoutFrame) tries "auto" vs "perp"
 * to find the most compact arrangement; explicit user directions ignore this.
 */
export type InheritMode = "auto" | "perp";

/**
 * The direction a container is laid out in:
 *   - explicit user direction → honoured verbatim (priority);
 *   - inherit (placeholder / custom / none) → engine-inferred per `inheritMode`;
 *   - forceUnpin (⌘⌥⇧L) → ignore explicit directions too (a clean-slate pass
 *     re-infers everything), parity with ignoring pins/sizes.
 */
export function resolveContainerDir(
  container: TLShape,
  kidIds: ReadonlySet<string>,
  frameDir: string,
  nodeEdges: ReadonlyArray<{ from: string; to: string }>,
  forceDirections: boolean,
  inheritMode: InheritMode = "auto",
): string {
  if (!forceDirections && containerHasExplicitDir(container))
    return readContainerRawDir(container)!;
  if (inheritMode === "perp") return perpendicular(frameDir);
  return inferInheritDir(kidIds, frameDir, nodeEdges);
}

/**
 * Cross-axis center alignment for a SINGLE-LANE container (one node per layer):
 * the reference centres pipeline-chain children within their lane. Skipped when
 * any layer holds ≥2 nodes (branching) — centering would overlap siblings.
 * Mutates childPos in place; the container's measured box is unchanged (children
 * only move toward the existing cross-axis centre).
 */
function centerCrossAxis(
  childPos: Record<string, { x: number; y: number; w?: number; h?: number }>,
  dir: string,
): void {
  const entries = Object.values(childPos);
  if (entries.length < 2) return;
  const vertical = dir === "TB" || dir === "BT";
  // Reject branching: group by the FLOW axis; if any group has >1 node, bail.
  const groups = new Map<number, number>();
  for (const p of entries) {
    const key = Math.round((vertical ? p.y : p.x) / 4);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const n of groups.values()) if (n > 1) return;
  if (vertical) {
    let min = Infinity;
    let max = -Infinity;
    for (const p of entries) {
      min = Math.min(min, p.x);
      max = Math.max(max, p.x + (p.w ?? 0));
    }
    const cx = (min + max) / 2;
    for (const p of entries) p.x = cx - (p.w ?? 0) / 2;
  } else {
    let min = Infinity;
    let max = -Infinity;
    for (const p of entries) {
      min = Math.min(min, p.y);
      max = Math.max(max, p.y + (p.h ?? 0));
    }
    const cy = (min + max) / 2;
    for (const p of entries) p.y = cy - (p.h ?? 0) / 2;
  }
}

type Pt = { x: number; y: number };
const ccw = (a: Pt, b: Pt, c: Pt): number =>
  (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x);
/** Proper (non-collinear) crossing of open segments [p1,p2] and [p3,p4]. */
function segmentsCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = ccw(p3, p4, p1);
  const d2 = ccw(p3, p4, p2);
  const d3 = ccw(p1, p2, p3);
  const d4 = ccw(p1, p2, p4);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

type Rect = { minX: number; minY: number; maxX: number; maxY: number };
/**
 * Whether segment [p1,p2] intersects the axis-aligned `rect` grown by `pad`
 * (Liang–Barsky clip). Used to detect an arrow segment clipping a box: a
 * negative `pad` requires the segment to actually bite into the box (ignores
 * a connector merely grazing the edge), a positive `pad` flags near-touches.
 */
export function segmentIntersectsRect(
  p1: Pt,
  p2: Pt,
  rect: Rect,
  pad: number,
): boolean {
  const minx = rect.minX - pad;
  const miny = rect.minY - pad;
  const maxx = rect.maxX + pad;
  const maxy = rect.maxY + pad;
  let t0 = 0;
  let t1 = 1;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (
    clip(-dx, p1.x - minx) &&
    clip(dx, maxx - p1.x) &&
    clip(-dy, p1.y - miny) &&
    clip(dy, maxy - p1.y)
  )
    return t1 >= t0;
  return false;
}

/** Flat (post-elk) position map: parent-relative x,y (+ optional size). */
type FlatPos = Record<string, { x: number; y: number; w?: number; h?: number }>;
/** A straight edge segment between two node centres, tagged with its endpoints. */
type CrossSeg = { a: Pt; b: Pt; from: string; to: string };

/**
 * Absolute (frame-relative) centre of a node from the flat position map: for a
 * container child the owner box origin is added; loose geo and containers
 * themselves are already frame-relative. Shared by the flip pass and the dryRun
 * crossing estimate (identical owner-offset math).
 */
function absCenter(flat: FlatPos, ownerOf: Record<string, string>, id: string): Pt | null {
  const p = flat[id];
  if (!p) return null;
  const owner = ownerOf[id];
  if (!owner || owner === id || !flat[owner])
    return { x: p.x + (p.w ?? 0) / 2, y: p.y + (p.h ?? 0) / 2 };
  const c = flat[owner];
  return { x: c.x + p.x + (p.w ?? 0) / 2, y: c.y + p.y + (p.h ?? 0) / 2 };
}

/**
 * Count proper crossings among straight node-centre segments: O(n²) pair scan
 * skipping edges that share an endpoint (they fan out from a node, not a
 * crossing). Shared by the flip pass and the dryRun crossing estimate.
 */
function countStraightCrossings(segs: ReadonlyArray<CrossSeg>): number {
  let n = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!;
      const t = segs[j]!;
      // adjacent edges fan out from a shared node — not a crossing
      if (s.from === t.from || s.from === t.to || s.to === t.from || s.to === t.to)
        continue;
      if (segmentsCross(s.a, s.b, t.a, t.b)) n++;
    }
  }
  return n;
}

// elbow mid-point candidates sampled by the obstacle-aware routing pass, and the
// inset at which an arrow segment counts as biting into a box (must actually
// penetrate ~3px — grazing the edge is not a "наезд").
const ELBOW_MID_CANDIDATES = [0.15, 0.35, 0.5, 0.65, 0.85] as const;
const ELBOW_OVERLAP_PAD = -3;

/**
 * Obstacle-aware elbow mid-point pass — the single routing lever tldraw gives a
 * bound elbow arrow is `elbowMidPoint` (0..1: where the perpendicular jog sits
 * along the path). Layout fixes WHERE nodes are, the port pass fixes WHICH sides
 * arrows attach; this fixes WHERE each arrow's jog sits, nudging a long
 * cross-fan arrow into a clear lane (fewer arrow-arrow crossings) and lifting a
 * jog out of a box it would otherwise clip (fewer box overlaps).
 *
 * Greedy + conservative: only arrows that currently cross another arrow or clip
 * a non-endpoint box are touched; the current value is always a candidate, so a
 * clean (or un-improvable) arrow is left exactly as tldraw/the user had it. The
 * whole sweep runs in one history-ignored transaction — getShapeGeometry
 * reflects mid-transaction prop writes (verified), so each candidate is scored
 * against tldraw's real router output, not a re-implementation of it.
 */
function optimizeElbowMidpoints(
  editor: Editor,
  arrowIds: string[],
  endpointOf: Record<string, { start?: string; end?: string }>,
  boxes: Array<Rect & { id: string }>,
): void {
  if (arrowIds.length < 2) return;
  type Seg = [Pt, Pt];
  const segsOf = (aid: string): Seg[] => {
    const g = editor.getShapeGeometry(aid as TLShapeId);
    const tr = editor.getShapePageTransform(aid as TLShapeId);
    if (!g || !tr) return [];
    const v = g.vertices.map((p) => tr.applyToPoint(p));
    const out: Seg[] = [];
    for (let i = 0; i < v.length - 1; i++) out.push([v[i]!, v[i + 1]!]);
    return out;
  };
  const adjacent = (a: string, b: string): boolean => {
    const ea = endpointOf[a] ?? {};
    const eb = endpointOf[b] ?? {};
    return (
      (!!ea.start && (ea.start === eb.start || ea.start === eb.end)) ||
      (!!ea.end && (ea.end === eb.start || ea.end === eb.end))
    );
  };
  const segMap: Record<string, Seg[]> = {};
  for (const a of arrowIds) segMap[a] = segsOf(a);
  const crossingsOf = (a: string, segs: Seg[]): number => {
    let n = 0;
    for (const b of arrowIds) {
      if (b === a || adjacent(a, b)) continue;
      const bs = segMap[b]!;
      let hit = false;
      for (const s of segs) {
        for (const t of bs)
          if (segmentsCross(s[0], s[1], t[0], t[1])) {
            hit = true;
            break;
          }
        if (hit) break;
      }
      if (hit) n++;
    }
    return n;
  };
  const overlapsOf = (a: string, segs: Seg[]): number => {
    const e = endpointOf[a] ?? {};
    let n = 0;
    for (const box of boxes) {
      if (box.id === e.start || box.id === e.end) continue;
      let hit = false;
      for (const s of segs)
        if (segmentIntersectsRect(s[0], s[1], box, ELBOW_OVERLAP_PAD)) {
          hit = true;
          break;
        }
      if (hit) n++;
    }
    return n;
  };
  // box overlap weighted above arrow crossings — clipping an object reads worse.
  const cost = (a: string, segs: Seg[]): number =>
    crossingsOf(a, segs) * 3 + overlapsOf(a, segs) * 5;

  editor.run(
    () => {
      for (const a of arrowIds) {
        const shape = editor.getShape(a as TLShapeId);
        if (!shape || (shape.props as { kind?: string }).kind !== "elbow")
          continue;
        const curMid =
          (shape.props as { elbowMidPoint?: number }).elbowMidPoint ?? 0.5;
        let best = curMid;
        let bestCost = cost(a, segMap[a]!);
        if (bestCost === 0) continue; // already clean — don't disturb it
        for (const v of ELBOW_MID_CANDIDATES) {
          if (v === curMid) continue;
          editor.updateShape({
            id: a as TLShapeId,
            type: "arrow",
            props: { elbowMidPoint: v },
          } as never);
          const c = cost(a, segsOf(a));
          if (c < bestCost) {
            bestCost = c;
            best = v;
          }
        }
        editor.updateShape({
          id: a as TLShapeId,
          type: "arrow",
          props: { elbowMidPoint: best },
        } as never);
        segMap[a] = segsOf(a); // later arrows score against the chosen route
      }
    },
    { history: "ignore" },
  );
}

export type ElkLayoutResult =
  | { kind: "ok"; applied: number; frameId: string; affected: string[] }
  // dryRun: the computed plan's metrics (no store mutation) — drives the
  // aspect-aware auto-direction search in autoLayoutFrame.
  | { kind: "plan"; contentW: number; contentH: number; crossings: number }
  | { kind: "noop"; reason: string }
  | { kind: "error"; message: string };

/** Walk up the parent chain until a frame shape is found. */
function ancestorFrame(editor: Editor, id: TLShapeId): TLShapeId | null {
  let cur: TLShape | undefined = editor.getShape(id);
  while (cur) {
    if (cur.type === "frame") return cur.id;
    const parent = cur.parentId;
    cur = parent.startsWith("shape:")
      ? editor.getShape(parent as TLShapeId)
      : undefined;
  }
  return null;
}

/**
 * The frame that owns the current selection (a selected frame itself, or the
 * ancestor frame of a selected container/leaf). Null when the selection sits
 * outside any frame — the caller then considers frameless board layout.
 */
function selectionFrame(editor: Editor, ids: TLShapeId[]): TLShapeId | null {
  for (const id of ids) {
    const f = ancestorFrame(editor, id);
    if (f) return f;
  }
  return null;
}

/**
 * Fallback frame when the selection points at no frame and isn't a layoutable
 * loose selection: the frame under the viewport centre, else the only frame.
 * (Drives "⌘⇧L with nothing selected lays out the obvious frame".)
 */
function fallbackFrame(editor: Editor): TLShapeId | null {
  const frames = editor
    .getCurrentPageShapes()
    .filter((s) => s.type === "frame");
  const first = frames[0];
  if (!first) return null;
  if (frames.length === 1) return first.id;
  const c = editor.getViewportPageBounds().center;
  const hit = frames.find((f) => {
    const b = editor.getShapePageBounds(f.id);
    return (
      !!b && c.x >= b.x && c.x <= b.x + b.w && c.y >= b.y && c.y <= b.y + b.h
    );
  });
  return (hit ?? first).id;
}

function childrenOf(editor: Editor, parentId: TLShapeId): TLShape[] {
  return editor.getCurrentPageShapes().filter((s) => s.parentId === parentId);
}

/**
 * elk input size for a geo node with Roomy width-growth applied.
 *
 * `baseW` is the node's natural width — read from meta.didrawBaseW once
 * captured, else the current width (natural on first layout, before any
 * growth has shipped). The returned width = baseW × nodeW; reverting to a
 * smaller spacing recomputes from base, so growth is fully reversible.
 * Height is left at the measured value (elk reserves at least that, so a
 * widened box that now wraps less just gains airy padding — never overlaps).
 * sizePinned nodes keep their exact size and report no base (never grown).
 */
function geoInputSize(
  editor: Editor,
  id: TLShapeId,
  nodeW: number,
): { width: number; height: number; baseW: number | null } {
  const s = editor.getShape(id);
  const b = editor.getShapePageBounds(id);
  const curW = b?.w ?? 100;
  const height = b?.h ?? 60;
  if (s?.meta?.didrawSizePinned) return { width: curW, height, baseW: null };
  const metaBase = s?.meta?.didrawBaseW;
  const baseW = typeof metaBase === "number" ? metaBase : curW;
  return { width: Math.round(baseW * nodeW), height, baseW };
}

// Containers get a tighter fraction of the board spacing for their internals.
const CONTAINER_SPACING_FRACTION = 0.62;

/**
 * Lay a single schema-container out internally — its children placed along the
 * container's OWN direction (with its own spacing / engine, and a flow chain when
 * the children aren't wired) — and report the measured box size + child positions
 * relative to the container origin (which map 1:1 onto tldraw parent-relative
 * coords).
 *
 * This is the per-node building block of the recursive layout: the frame lays its
 * containers out as fixed-size boxes (step 2 in runElkLayout), each box sized here.
 * Doing the two passes explicitly is what lets BOTH the container internals and the
 * frame-level arrangement honour their own direction — elk's SEPARATE_CHILDREN
 * ignores the root direction, INCLUDE_CHILDREN flattens the container directions;
 * only this split gives both. (Nested containers = future recursion — this helper
 * already isolates the unit it would recurse on.)
 */
async function layoutContainerInternal(
  container: TLShape,
  kids: TLShape[],
  ctx: {
    editor: Editor;
    /** Resolved direction (explicit or topology-inferred) — see resolveContainerDir. */
    dir: string;
    frameSpacing: Spacing | null;
    nodeEdges: Array<{ from: string; to: string }>;
    geoBaseW: Record<string, number>;
  },
): Promise<{
  id: string;
  w: number;
  h: number;
  childPos: Record<string, { x: number; y: number; w?: number; h?: number }>;
}> {
  const dir = ctx.dir;
  const csp = SPREAD[readSpacing(container.meta) ?? ctx.frameSpacing ?? "normal"];
  const cAlg: LayoutAlgorithm = readEngine(container.meta) ?? "layered";
  const kidIds = kids.map((k) => k.id as string);
  const kset = new Set(kidIds);
  const edges: ElkExtendedEdge[] = [];
  for (const e of ctx.nodeEdges) {
    if (kset.has(e.from) && kset.has(e.to)) {
      edges.push({ id: `${e.from}>${e.to}`, sources: [e.from], targets: [e.to] });
    }
  }
  // Flow chain when the children aren't wired internally (else they clump on the
  // cross axis and the container's Direction looks dead).
  const withInternal =
    edges.length > 0 ? new Set([container.id as string]) : new Set<string>();
  edges.push(...buildFlowChainEdges({ [container.id]: kidIds }, withInternal));
  const cf = CONTAINER_SPACING_FRACTION;
  const children: ElkNode[] = kids.map((k) => {
    const z = geoInputSize(ctx.editor, k.id, csp.nodeW);
    if (z.baseW != null) ctx.geoBaseW[k.id] = z.baseW;
    return { id: k.id as string, width: z.width, height: z.height };
  });
  const graph: ElkNode = {
    id: container.id as string,
    layoutOptions: {
      "elk.algorithm": cAlg,
      "elk.direction": DIR_MAP[dir] || "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.spacing.nodeNode": String(Math.round(csp.nodeNode * cf)),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(
        Math.round(csp.between * cf),
      ),
      "elk.padding": "[top=44,left=16,bottom=16,right=16]",
    },
    children,
    edges,
  };
  const res = await elk().layout(graph);
  const childPos: Record<
    string,
    { x: number; y: number; w?: number; h?: number }
  > = {};
  for (const c of res.children ?? []) {
    childPos[c.id] = { x: c.x ?? 0, y: c.y ?? 0, w: c.width, h: c.height };
  }
  // Centre single-lane children within the container (matches the reference).
  centerCrossAxis(childPos, dir);
  return {
    id: container.id as string,
    w: Math.round(res.width ?? 0),
    h: Math.round(res.height ?? 0),
    childPos,
  };
}

/**
 * Re-layout the schema frame addressed by `ids` (selection) using elkjs.
 * Pure side effect on the editor store (which syncs to the backend); returns a
 * small result for the caller to drive camera feedback.
 */
export async function runElkLayout(
  editor: Editor,
  ids: TLShapeId[],
  opts?: {
    forceUnpin?: boolean;
    forceDirections?: boolean;
    // aspect-aware auto-direction overrides (set by autoLayoutFrame's search):
    frameDirOverride?: string; // use this frame direction instead of the meta one
    inheritMode?: InheritMode; // how inherit containers pick their direction
    dryRun?: boolean; // compute the plan + return its metrics WITHOUT applying
  },
): Promise<ElkLayoutResult> {
  // forceUnpin (⌘⌥⇧L / «Принудительно») lays out *everything* for this single
  // pass — pinned position + sizePinned containers + the frame refit included.
  // The pin meta flags are NOT cleared; they simply don't veto this one layout.
  const forceUnpin = opts?.forceUnpin === true;
  const inheritMode: InheritMode = opts?.inheritMode ?? "auto";
  // forceDirections (also ⌘⌥⇧L) additionally ignores EXPLICIT container
  // directions, re-inferring every container from topology for a clean-slate
  // pass. Kept separate from forceUnpin so a plain direction-change re-layout can
  // ignore pins WITHOUT discarding the direction the user just set.
  const forceDirections = opts?.forceDirections === true;
  // Scope priority: (1) the selection's own frame; (2) an explicit loose
  // selection of ≥2 page-level nodes → frameless board layout; (3) fall back to
  // the viewport / only frame (so ⌘⇧L with nothing selected still does something).
  let frameId = selectionFrame(editor, ids);
  // Frameless: no frame around the selection → lay out the selected page-level
  // nodes in place on the board (schema drawn loose, not wrapped in a frame).
  const looseNodes: TLShape[] = !frameId
    ? ids
        .map((id) => editor.getShape(id))
        .filter(
          (s): s is TLShape =>
            !!s &&
            (s.type === "geo" || s.type === "schema-container") &&
            s.parentId.startsWith("page:"),
        )
    : [];
  if (!frameId && looseNodes.length < 2) {
    // Not a loose multi-node selection → fall back to an obvious frame.
    frameId = fallbackFrame(editor);
  }
  const frame = frameId ? editor.getShape(frameId) : null;
  if (!frameId) {
    if (looseNodes.length < 2) {
      return {
        kind: "noop",
        reason:
          "no schema frame found — select ≥2 connected nodes on the board, or draw a frame",
      };
    }
  } else {
    if (!frame) return { kind: "noop", reason: "frame vanished" };
    // Lock: a locked frame ignores ALL layout — even forceUnpin. Unlock to re-flow.
    if (frame.meta?.didrawLocked) {
      return { kind: "noop", reason: "frame locked — unlock to re-layout" };
    }
  }
  // The shapes to lay out at the root level: a frame's direct children, or the
  // loose page-level selection. Everything downstream is scope-agnostic.
  const scopeNodes: TLShape[] = frameId
    ? childrenOf(editor, frameId)
    : looseNodes;

  // ---- build the elk graph from the frame's descendants ----
  // frameDirOverride (autoLayoutFrame's aspect search) wins over the stored meta.
  const frameDir =
    opts?.frameDirOverride ??
    ((frame?.meta?.didrawDirection as string) || DEFAULT_FRAME_DIR);
  // spacing preset (Compact / Normal / Roomy) from the frame or any container meta
  let spacingName = readSpacing(frame?.meta);
  if (!spacingName) {
    for (const c of scopeNodes) {
      const v = readSpacing(c.meta);
      if (v) {
        spacingName = v;
        break;
      }
    }
  }
  const sp = SPREAD[spacingName ?? "normal"];
  // placement engine (Layered / Tree / Stress / Force) — frame meta first, then
  // any container meta, else default "layered". All four handle compound nodes
  // (containers) under INCLUDE_CHILDREN; layered-specific options below are
  // simply ignored by the other algorithms.
  let engine = readEngine(frame?.meta);
  if (!engine) {
    for (const c of scopeNodes) {
      const v = readEngine(c.meta);
      if (v) {
        engine = v;
        break;
      }
    }
  }
  const algorithm: LayoutAlgorithm = engine ?? "layered";
  // Recursive 2-level layout. elk's SEPARATE_CHILDREN ignores the root direction
  // (the frame can't re-arrange its containers); INCLUDE_CHILDREN flattens the
  // container directions. Neither gives "containers compose their own children AND
  // the frame arranges the containers". So we do it in two explicit passes:
  //   step 1 — lay each container out internally with its own dir/spacing/engine
  //            → a fixed-size box (layoutContainerInternal);
  //   step 2 — lay the frame out FLAT (those boxes + loose geo + collapsed edges)
  //            with the frame's own dir/spacing/engine.
  // Both the frame direction AND each container direction now take effect. (This is
  // the 2-level case of the general recursive model; nested containers = future.)
  const rootElkDir = DIR_MAP[frameDir] || "RIGHT";
  // base width per geo id (captured on writeback so width-growth is reversible)
  const geoBaseW: Record<string, number> = {};

  // --- arrows: terminal map drives internal/root edges AND the port pass below ---
  const byArrow: Record<string, { start?: string; end?: string }> = {};
  for (const r of editor.store.allRecords()) {
    const rec = r as {
      typeName: string;
      type?: string;
      fromId?: string;
      toId?: string;
      props?: { terminal?: string };
    };
    if (rec.typeName !== "binding" || rec.type !== "arrow") continue;
    const t = rec.props?.terminal;
    if (!rec.fromId || !rec.toId || (t !== "start" && t !== "end")) continue;
    const slot = byArrow[rec.fromId] ?? {};
    slot[t] = rec.toId;
    byArrow[rec.fromId] = slot;
  }
  const nodeEdges: Array<{ from: string; to: string }> = [];
  for (const t of Object.values(byArrow)) {
    if (t.start && t.end) nodeEdges.push({ from: t.start, to: t.end });
  }

  // Classify the frame's direct children: schema-containers (≥1 geo kid) vs loose
  // geo. Every container is laid out in its OWN pass (step 1) as an opaque box —
  // the engine picks each inherit container's direction by topology, explicit
  // directions win — then the frame arranges the boxes + loose geo (step 2). Map
  // each geo leaf → its owning container so inter-container arrows collapse onto
  // the box.
  const containerShapes: TLShape[] = [];
  const looseGeo: TLShape[] = [];
  const ownerOf: Record<string, string> = {};
  const containerKidsMap: Record<string, TLShape[]> = {};
  for (const s of scopeNodes) {
    if (s.type === "schema-container") {
      const kids = childrenOf(editor, s.id).filter((k) => k.type === "geo");
      if (kids.length === 0) continue;
      containerShapes.push(s);
      containerKidsMap[s.id] = kids;
      for (const k of kids) ownerOf[k.id] = s.id;
    } else if (s.type === "geo") {
      looseGeo.push(s);
      ownerOf[s.id] = s.id;
    }
  }
  if (containerShapes.length === 0 && looseGeo.length === 0)
    return { kind: "noop", reason: "frame has no layoutable nodes" };

  // every laid-out node — scopes the arrow-port pass to this frame
  const inGraph = new Set<string>();
  for (const g of looseGeo) inGraph.add(g.id);
  for (const c of containerShapes) {
    inGraph.add(c.id);
    for (const k of containerKidsMap[c.id]!) inGraph.add(k.id);
  }

  // parent-relative positions for every node (container internals relative to
  // their container; top-level containers/loose-geo relative to the frame origin).
  const flat: Record<string, { x: number; y: number; w?: number; h?: number }> =
    {};
  // resolved layout direction per container (for the flip-to-reduce-crossings pass).
  const resolvedDirs: Record<string, string> = {};

  let res: ElkNode;
  try {
    // ---- step 1: every container laid out internally as a fixed-size opaque box.
    // The engine picks each inherit container's direction by topology
    // (resolveContainerDir); explicit directions win; forceUnpin re-infers all. ----
    const boxes = await Promise.all(
      containerShapes.map((c) => {
        const dir = resolveContainerDir(
          c,
          new Set(containerKidsMap[c.id]!.map((k) => k.id as string)),
          frameDir,
          nodeEdges,
          forceDirections,
          inheritMode,
        );
        resolvedDirs[c.id as string] = dir;
        return layoutContainerInternal(c, containerKidsMap[c.id]!, {
          editor,
          dir,
          frameSpacing: spacingName,
          nodeEdges,
          geoBaseW,
        });
      }),
    );
    const boxSize: Record<string, { w: number; h: number }> = {};
    for (const box of boxes) {
      boxSize[box.id] = { w: box.w, h: box.h };
      for (const [kid, p] of Object.entries(box.childPos)) flat[kid] = p;
    }

    // ---- step 2: the frame lays the container boxes + loose geo out FLAT by its
    // own direction / engine / spacing; inter-container arrows collapse onto the
    // owning boxes. ----
    const rootChildren: ElkNode[] = [];
    for (const c of containerShapes) {
      const bs = boxSize[c.id]!;
      rootChildren.push({ id: c.id as string, width: bs.w, height: bs.h });
    }
    for (const g of looseGeo) {
      const z = geoInputSize(editor, g.id, sp.nodeW);
      if (z.baseW != null) geoBaseW[g.id] = z.baseW;
      rootChildren.push({ id: g.id as string, width: z.width, height: z.height });
    }
    // Collapse node→node arrows onto the owning boxes; skip intra-box (same owner)
    // and cross-frame edges (endpoint outside this frame's scope → not in ownerOf;
    // elk would otherwise throw "Referenced shape does not exist").
    const rootSeen = new Set<string>();
    const rootEdges: ElkExtendedEdge[] = [];
    for (const e of nodeEdges) {
      const a = ownerOf[e.from];
      const b = ownerOf[e.to];
      if (!a || !b || a === b) continue;
      const key = `${a}>${b}`;
      if (rootSeen.has(key)) continue;
      rootSeen.add(key);
      rootEdges.push({ id: key, sources: [a], targets: [b] });
    }
    // a frame of disconnected top-level nodes still lines up along the frame dir
    const topLevelIds = rootChildren.map((n) => n.id);
    rootEdges.push(
      ...buildFlowChainEdges(
        { __root__: topLevelIds },
        new Set(rootEdges.length > 0 ? ["__root__"] : []),
      ),
    );
    const rootGraph: ElkNode = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": algorithm,
        "elk.direction": rootElkDir,
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.layered.thoroughness": "12",
        "elk.spacing.nodeNode": String(sp.nodeNode),
        "elk.spacing.componentComponent": String(sp.comp),
        "elk.spacing.edgeNode": String(sp.edgeNode),
        "elk.spacing.edgeEdge": String(sp.edgeEdge),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(sp.between),
        "elk.layered.spacing.edgeNodeBetweenLayers": String(sp.edgeNode),
        "elk.layered.spacing.edgeEdgeBetweenLayers": String(sp.edgeEdge),
      },
      children: rootChildren,
      edges: rootEdges,
    };
    res = await elk().layout(rootGraph);
  } catch (e) {
    return {
      kind: "error",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  // Top-level (container box + loose geo) positions, relative to the frame origin.
  // Each container's internal children are already in `flat` from step 1
  // (container-relative — tldraw's parent-relative convention).
  for (const c of res.children ?? []) {
    flat[c.id] = { x: c.x ?? 0, y: c.y ?? 0, w: c.width, h: c.height };
  }

  // ---- flip-to-reduce-crossings: reversing a container's flow axis (LR↔RL /
  // TB↔BT) reverses its child order, which can untangle the external arrows that
  // attach to those children (user insight). For each container, mirror its
  // children within their own span and keep the orientation with fewer
  // straight-line edge crossings across the whole frame. ----
  {
    const scopedEdges = nodeEdges.filter(
      (e) => inGraph.has(e.from) && inGraph.has(e.to),
    );
    const countCrossings = (): number => {
      const segs = scopedEdges
        .map((e) => {
          const a = absCenter(flat, ownerOf, e.from);
          const b = absCenter(flat, ownerOf, e.to);
          return a && b ? { a, b, from: e.from, to: e.to } : null;
        })
        .filter((s): s is CrossSeg => s !== null);
      return countStraightCrossings(segs);
    };
    // Mirror a container's children within their OWN bounding span (preserves the
    // box + title padding, just reverses order along the flow axis).
    const mirrorContainer = (cid: string): void => {
      const dir = resolvedDirs[cid] ?? "TB";
      const vertical = dir === "TB" || dir === "BT";
      const ps = (containerKidsMap[cid] ?? [])
        .map((k) => flat[k.id as string])
        .filter((p): p is NonNullable<typeof p> => !!p);
      if (ps.length < 2) return;
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const p of ps) {
        const a = vertical ? p.y : p.x;
        const b = a + (vertical ? (p.h ?? 0) : (p.w ?? 0));
        lo = Math.min(lo, a);
        hi = Math.max(hi, b);
      }
      for (const p of ps) {
        if (vertical) p.y = lo + hi - p.y - (p.h ?? 0);
        else p.x = lo + hi - p.x - (p.w ?? 0);
      }
    };
    for (const c of containerShapes) {
      const cid = c.id as string;
      const kids = containerKidsMap[cid] ?? [];
      if (kids.length < 2) continue;
      // Honour an explicit user direction sense: never auto-reverse a container
      // the user pinned to a cardinal direction (LR ≠ RL). This both makes the
      // explicit pick stick AND keeps the pass local — editing a sibling no
      // longer flips this untouched container. forceDirections re-enables it.
      if (!isFlipEligible(c, forceDirections)) continue;
      // Respect pins: don't reorder a container whose children are user-placed.
      if (!forceUnpin && kids.some((k) => k.meta?.pinned)) continue;
      const kidSet = new Set(kids.map((k) => k.id as string));
      const hasExternal = scopedEdges.some(
        (e) => kidSet.has(e.from) !== kidSet.has(e.to),
      );
      if (!hasExternal) continue;
      const before = countCrossings();
      mirrorContainer(cid);
      if (countCrossings() >= before) mirrorContainer(cid); // no gain → revert
    }
  }

  // dryRun (aspect-aware search in autoLayoutFrame): report the post-flip plan's
  // content bounds + a cheap straight-segment crossing estimate, then bail BEFORE
  // any store mutation. The caller compares candidate (frameDir × inheritMode)
  // configs and only the winner gets a real apply pass — so no flicker.
  if (opts?.dryRun) {
    let minx = Number.POSITIVE_INFINITY;
    let miny = Number.POSITIVE_INFINITY;
    let maxx = Number.NEGATIVE_INFINITY;
    let maxy = Number.NEGATIVE_INFINITY;
    for (const s of scopeNodes) {
      const p = flat[s.id as string];
      if (!p) continue;
      minx = Math.min(minx, p.x);
      miny = Math.min(miny, p.y);
      maxx = Math.max(maxx, p.x + (p.w ?? 0));
      maxy = Math.max(maxy, p.y + (p.h ?? 0));
    }
    const segs = nodeEdges
      .filter((e) => inGraph.has(e.from) && inGraph.has(e.to))
      .map((e) => {
        const a = absCenter(flat, ownerOf, e.from);
        const b = absCenter(flat, ownerOf, e.to);
        return a && b ? { a, b, from: e.from, to: e.to } : null;
      })
      .filter((s): s is CrossSeg => s !== null);
    const crossings = countStraightCrossings(segs);
    return {
      kind: "plan",
      contentW: Math.max(1, Number.isFinite(minx) ? maxx - minx : 1),
      contentH: Math.max(1, Number.isFinite(miny) ? maxy - miny : 1),
      crossings,
    };
  }

  // Anti-drift: elk lays the frame's direct children out starting near its own
  // origin (min ≈ 0). The frame's top-left stays put; we normalise the top-level
  // children so their bounding box sits `pad` inside it. (The old code moved the
  // frame to `min - pad` instead — but the children are parent-relative, so moving
  // the frame dragged them along, nudging the whole frame up-left every run.)
  const pad = 56;
  const topIds = new Set(scopeNodes.map((s) => s.id as string));
  let minTopX = Number.POSITIVE_INFINITY;
  let minTopY = Number.POSITIVE_INFINITY;
  // Frameless: also track the selection's CURRENT page top-left so the new layout
  // can be anchored there (schema stays where the user drew it on the board).
  let curMinX = Number.POSITIVE_INFINITY;
  let curMinY = Number.POSITIVE_INFINITY;
  for (const id of topIds) {
    const s = editor.getShape(id as TLShapeId);
    if (!forceUnpin && s?.meta?.pinned) continue; // pinned tops keep their spot
    const fp = flat[id];
    if (!fp) continue;
    minTopX = Math.min(minTopX, fp.x);
    minTopY = Math.min(minTopY, fp.y);
    if (!frameId) {
      const b = editor.getShapePageBounds(id as TLShapeId);
      if (b) {
        curMinX = Math.min(curMinX, b.x);
        curMinY = Math.min(curMinY, b.y);
      }
    }
  }
  // Frame mode: place content `pad` inside the frame top-left (anti-drift).
  // Frameless mode: land the new layout on the selection's previous top-left.
  const anchorX = frameId ? pad : curMinX;
  const anchorY = frameId ? pad : curMinY;
  const offX =
    Number.isFinite(minTopX) && Number.isFinite(anchorX) ? anchorX - minTopX : 0;
  const offY =
    Number.isFinite(minTopY) && Number.isFinite(anchorY) ? anchorY - minTopY : 0;

  const updates: Record<string, unknown>[] = [];
  const affected: string[] = [];
  for (const [id, p] of Object.entries(flat)) {
    const s = editor.getShape(id as TLShapeId);
    if (!s) continue;
    if (!forceUnpin && s.meta?.pinned) continue; // pin discipline: keep user-placed nodes
    // Only top-level children are shifted (their coords are frame-relative);
    // nodes inside containers are relative to the container, which already moved.
    const top = topIds.has(id);
    const upd: Record<string, unknown> = {
      id,
      type: s.type,
      x: top ? p.x + offX : p.x,
      y: top ? p.y + offY : p.y,
    };
    if (
      s.type === "schema-container" &&
      (forceUnpin || !s.meta?.didrawSizePinned) &&
      p.w != null &&
      p.h != null
    ) {
      upd.props = { w: p.w, h: p.h };
    } else if (s.type === "geo" && !s.meta?.didrawSizePinned) {
      // Roomy width-growth: elk echoes back our scaled input width (p.w). Apply
      // it when it actually changed, and capture the natural base width once so
      // a later switch to a smaller spacing can shrink back.
      const curW = Math.round((s.props as { w?: number }).w ?? 0);
      const targetW = p.w != null ? Math.round(p.w) : curW;
      if (targetW !== curW) upd.props = { w: targetW };
      const baseW = geoBaseW[id];
      if (baseW != null && typeof s.meta?.didrawBaseW !== "number") {
        upd.meta = { ...(s.meta ?? {}), didrawBaseW: baseW };
      }
    }
    updates.push(upd);
    affected.push(id);
  }
  if (updates.length === 0)
    return {
      kind: "noop",
      reason: "everything is pinned — nothing to lay out",
    };

  editor.markHistoryStoppingPoint();
  // Suppress schema-container auto-flip: layout runs through editor.run() which
  // tldraw stamps source:"user", so moving a container's children would trip the
  // auto-flip listener and rewrite props.direction → "custom" (DRW-150) — which
  // then makes the container follow the FRAME direction instead of its own. The
  // WS-driven layout path already wraps its apply the same way.
  withAutoFlipSuppressed(() =>
    editor.run(() => {
      editor.updateShapes(updates as never);
      // Resize the frame to wrap its content with `pad`, WITHOUT moving its top-left
    // (content was normalised to start `pad` inside above). Keeping the position
    // fixed is what kills the per-run drift. Skip entirely if the size is pinned,
    // or when there is no frame (frameless board layout).
    if (frameId && frame && (forceUnpin || !frame.meta?.didrawSizePinned)) {
      const f = editor.getShape(frameId);
      const fb = editor.getShapePageBounds(frameId);
      if (f && fb) {
        let maxx = Number.NEGATIVE_INFINITY;
        let maxy = Number.NEGATIVE_INFINITY;
        for (const t of childrenOf(editor, frameId)) {
          const b = editor.getShapePageBounds(t.id);
          if (!b) continue;
          maxx = Math.max(maxx, b.x + b.w);
          maxy = Math.max(maxy, b.y + b.h);
        }
        if (Number.isFinite(maxx)) {
          editor.updateShape({
            id: frameId,
            type: "frame",
            props: { w: maxx - fb.x + pad, h: maxy - fb.y + pad },
          } as never);
        }
      }
    }
    }),
  );

  // ---- distribute arrow ports over the new layout so tldraw's elbow router
  // draws clean, non-overlapping connectors: each arrow exits/enters on the side
  // facing its neighbour; multiple arrows on one side spread out (DRW-172-style). ----
  // Flow axis from the frame direction: TB/BT stack layers vertically (inter-layer
  // edges exit/enter on top/bottom), LR/RL stack horizontally (left/right).
  const flowV = frameDir === "TB" || frameDir === "BT";
  type Box = {
    cx: number;
    cy: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  const center = (id: string): Box | null => {
    const b = editor.getShapePageBounds(id as TLShapeId);
    return b
      ? {
          cx: b.x + b.w / 2,
          cy: b.y + b.h / 2,
          minX: b.x,
          minY: b.y,
          maxX: b.x + b.w,
          maxY: b.y + b.h,
        }
      : null;
  };
  // Side of `a` facing `b`, snapped to the flow axis. An edge that crosses layers
  // (the boxes are separated along the flow axis) exits/enters on that axis — so a
  // fan-in/out to a hub lands consistently on one side instead of scattering by raw
  // centre angle (далёкий-и-вбок источник иначе садился на боковую грань). Same-layer
  // edges (overlapping along the flow axis) fall back to the cross axis.
  const sideOf = (a: Box, b: Box): "R" | "L" | "B" | "T" => {
    const dx = b.cx - a.cx;
    const dy = b.cy - a.cy;
    const vSep = b.minY >= a.maxY || a.minY >= b.maxY;
    const hSep = b.minX >= a.maxX || a.minX >= b.maxX;
    let vertical: boolean;
    if (!vSep && !hSep) vertical = Math.abs(dy) >= Math.abs(dx);
    else if (flowV) vertical = vSep || !hSep;
    else vertical = vSep && !hSep;
    return vertical ? (dy >= 0 ? "B" : "T") : dx >= 0 ? "R" : "L";
  };
  const anchorFor = (side: string, frac: number): { x: number; y: number } => {
    if (side === "R") return { x: 1, y: frac };
    if (side === "L") return { x: 0, y: frac };
    if (side === "B") return { x: frac, y: 1 };
    return { x: frac, y: 0 };
  };
  const bindRecs = editor.store.allRecords().filter((r) => {
    const x = r as { typeName: string; type?: string };
    return x.typeName === "binding" && x.type === "arrow";
  }) as unknown as {
    id: string;
    fromId: string;
    toId: string;
    props: Record<string, unknown> & { terminal: "start" | "end" };
  }[];
  const bindByKey: Record<string, (typeof bindRecs)[number]> = {};
  for (const b of bindRecs) bindByKey[`${b.fromId}|${b.props.terminal}`] = b;

  const portGroups: Record<
    string,
    { aid: string; term: "start" | "end"; other: Box }[]
  > = {};
  for (const [aid, t] of Object.entries(byArrow)) {
    if (!t.start || !t.end || !editor.getShape(aid as TLShapeId)) continue;
    // Scope to THIS frame's graph: byArrow spans the whole store, so without this
    // the pass would re-anchor arrows in other frames (e.g. a copy's layout would
    // disturb the original's connectors).
    if (!inGraph.has(t.start) || !inGraph.has(t.end)) continue;
    const sc = center(t.start);
    const tc = center(t.end);
    if (!sc || !tc) continue;
    const ks = `${t.start}|${sideOf(sc, tc)}`;
    const ke = `${t.end}|${sideOf(tc, sc)}`;
    let gs = portGroups[ks];
    if (!gs) {
      gs = [];
      portGroups[ks] = gs;
    }
    let ge = portGroups[ke];
    if (!ge) {
      ge = [];
      portGroups[ke] = ge;
    }
    gs.push({ aid, term: "start", other: tc });
    ge.push({ aid, term: "end", other: sc });
  }
  const bindingUpdates: Record<string, unknown>[] = [];
  for (const [key, list] of Object.entries(portGroups)) {
    const side = key.slice(key.indexOf("|") + 1);
    const horiz = side === "L" || side === "R";
    list.sort((p, q) =>
      horiz ? p.other.cy - q.other.cy : p.other.cx - q.other.cx,
    );
    const n = list.length;
    list.forEach((item, i) => {
      const rec = bindByKey[`${item.aid}|${item.term}`];
      if (!rec) return;
      bindingUpdates.push({
        id: rec.id,
        type: "arrow",
        fromId: rec.fromId,
        toId: rec.toId,
        props: {
          ...rec.props,
          isPrecise: true,
          normalizedAnchor: anchorFor(side, (i + 1) / (n + 1)),
        },
      });
    });
  }
  if (bindingUpdates.length > 0) {
    editor.run(
      () => {
        for (const u of bindingUpdates) editor.updateBinding(u as never);
      },
      { history: "ignore" },
    );
  }

  // ---- obstacle-aware elbow routing: now that nodes + ports are final, pick
  // each arrow's elbowMidPoint to dodge other arrows and non-endpoint boxes. ----
  {
    const elbowArrowIds = Object.keys(byArrow).filter((aid) => {
      const t = byArrow[aid]!;
      return (
        !!t.start &&
        !!t.end &&
        inGraph.has(t.start) &&
        inGraph.has(t.end) &&
        editor.getShape(aid as TLShapeId)?.type === "arrow"
      );
    });
    const obstacleBoxes = [...inGraph]
      .map((id) => editor.getShape(id as TLShapeId))
      .filter((s): s is TLShape => !!s && s.type === "geo")
      .map((s) => {
        const b = editor.getShapePageBounds(s.id);
        return b
          ? {
              id: s.id as string,
              minX: b.x,
              minY: b.y,
              maxX: b.x + b.w,
              maxY: b.y + b.h,
            }
          : null;
      })
      .filter((b): b is Rect & { id: string } => b !== null);
    optimizeElbowMidpoints(editor, elbowArrowIds, byArrow, obstacleBoxes);
  }

  return {
    kind: "ok",
    applied: updates.length,
    frameId: frameId ?? "",
    affected: frameId ? [...affected, frameId] : affected,
  };
}

// A frame whose laid-out content is more lopsided than this (longer/shorter ≥
// 2.2:1) triggers the aspect-aware config search; anything balanced keeps the
// default config verbatim, so already-good frames are never disturbed.
const ASPECT_SEARCH_THRESHOLD = 2.2;

/**
 * Aspect-aware layout entry point for the explicit layout triggers (⌘⇧L /
 * ⌘⌥⇧L / panel «Упорядочить»). For a frame whose direction the user has NOT
 * pinned, it dry-runs candidate configurations — frame direction × inherit
 * container mode — and applies the most compact one (least extreme aspect ratio,
 * tie-broken by fewer crossings), so a long pipeline lands as a balanced block
 * instead of an extreme-wide strip. Balanced frames, frames with an explicit
 * direction, frameless selections and locked frames defer to runElkLayout
 * unchanged — only a genuinely lopsided auto frame pays for the search.
 */
export async function autoLayoutFrame(
  editor: Editor,
  ids: TLShapeId[],
  opts?: { forceUnpin?: boolean; forceDirections?: boolean },
): Promise<ElkLayoutResult> {
  const frameId = selectionFrame(editor, ids);
  const frame = frameId ? editor.getShape(frameId) : null;
  // Auto-direction only when there IS a frame and the user hasn't pinned its
  // direction. Otherwise (explicit dir / frameless / locked) → runElkLayout.
  if (!frame || frame.meta?.didrawDirection) {
    return runElkLayout(editor, ids, opts);
  }

  const base = DEFAULT_FRAME_DIR;
  const perp = perpendicular(base);
  const ratioOf = (p: { contentW: number; contentH: number }): number =>
    Math.max(p.contentW / p.contentH, p.contentH / p.contentW);

  // Fast path: dry-run the default config; if it is already reasonably balanced,
  // apply it as-is (no search → already-good frames behave exactly as before).
  const basePlan = await runElkLayout(editor, ids, {
    ...opts,
    frameDirOverride: base,
    inheritMode: "auto",
    dryRun: true,
  });
  if (basePlan.kind !== "plan" || ratioOf(basePlan) <= ASPECT_SEARCH_THRESHOLD) {
    return runElkLayout(editor, ids, opts);
  }

  // Lopsided → search the remaining candidates for the most compact arrangement.
  const candidates: Array<{ dir: string; mode: InheritMode }> = [
    { dir: perp, mode: "auto" },
    { dir: base, mode: "perp" },
    { dir: perp, mode: "perp" },
  ];
  let best: { dir: string; mode: InheritMode } = { dir: base, mode: "auto" };
  // aspect extremity dominates; a small crossing increase is acceptable for a big
  // compactness gain (0.15 per crossing ≈ a 0.15 ratio worsening).
  let bestScore = ratioOf(basePlan) + basePlan.crossings * 0.15;
  for (const c of candidates) {
    const plan = await runElkLayout(editor, ids, {
      ...opts,
      frameDirOverride: c.dir,
      inheritMode: c.mode,
      dryRun: true,
    });
    if (plan.kind !== "plan") continue;
    const score = ratioOf(plan) + plan.crossings * 0.15;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return runElkLayout(editor, ids, {
    ...opts,
    frameDirOverride: best.dir,
    inheritMode: best.mode,
  });
}

/**
 * Fire-and-forget elk re-layout for the Direction / Spacing toggles: re-flows
 * the schema in place (no camera zoom — the user is fine-tuning and a jump is
 * disorienting) and logs failures. Errors are swallowed after logging.
 */
export function autoElkLayout(
  editor: Editor,
  ids: TLShapeId[],
  opts?: { forceUnpin?: boolean; forceDirections?: boolean },
): void {
  void runElkLayout(editor, ids, opts).then((r) => {
    if (r.kind === "error") console.warn("[elk-layout] auto failed", r.message);
  });
}

// DRW-239 density respread. Refit padding: a frame keeps a 56px margin around its
// content (matches the anti-drift `pad` of the ELK writeback); a container keeps a
// tight 16px right/bottom margin — its left/top margins already live in the
// children's container-relative coords. Default min-gap on compression.
const FRAME_REFIT_PAD = 56;
const CONTAINER_REFIT_PAD = 16;
const RESPREAD_MIN_GAP = 24;

// Box-like leaf shapes the density control may reposition. Excludes arrows/lines/
// draw/highlight (bound or path shapes — moving their x/y is meaningless or breaks
// bindings; bound arrows follow their nodes on their own). NOT just "geo" so plain
// objects on the board (notes, text, images, …) respread too — DRW-239 feedback.
const RESPREAD_LEAF_TYPES: ReadonlySet<string> = new Set([
  "geo",
  "text",
  "note",
  "image",
  "embed",
  "bookmark",
]);
const isRespreadLeaf = (type: string): boolean => RESPREAD_LEAF_TYPES.has(type);

/** Rendered size of a shape (page bounds — robust for any leaf type, incl. growY). */
function leafSize(editor: Editor, id: string): { w: number; h: number } {
  const b = editor.getShapePageBounds(id as TLShapeId);
  if (b) return { w: b.w, h: b.h };
  const p = (editor.getShape(id as TLShapeId)?.props ?? {}) as {
    w?: number;
    h?: number;
  };
  return { w: typeof p.w === "number" ? p.w : 0, h: typeof p.h === "number" ? p.h : 0 };
}

/** Captured parent-relative geometry of every node a respread gesture may move. */
export type RespreadSnapshot = Map<
  string,
  { x: number; y: number; w: number; h: number }
>;

// A level = the children of one parent that scale together about one anchor.
type RespreadGroup = {
  parentId: string;
  /** "min" → keep content top-left fixed (wrapper, refit); "center" → symmetric (loose). */
  anchor: Anchor;
  /** Refit pad when the parent is a wrapper we resize; null for loose page nodes. */
  refitPad: number | null;
  /** Whether the parent is a frame (refit ordering: containers before frames). */
  parentIsFrame: boolean;
  /** Node ids to scale on this level. */
  nodeIds: string[];
};

/**
 * Resolve the selection into respread groups (children-of-one-parent that scale
 * together). A frame → two levels (each container's geo kids + the frame's own
 * top-level boxes); a container → its geo kids; loose geo → grouped by parent
 * (page → "center" anchor, wrapper → "min" + refit). Empty selection → every
 * frame on the page plus loose page nodes (board-wide spread).
 */
function resolveRespreadGroups(
  editor: Editor,
  ids: TLShapeId[],
): RespreadGroup[] {
  const groups = new Map<string, RespreadGroup>();
  const add = (
    parentId: string,
    childId: string,
    anchor: Anchor,
    refitPad: number | null,
    parentIsFrame: boolean,
  ): void => {
    let g = groups.get(parentId);
    if (!g) {
      g = { parentId, anchor, refitPad, parentIsFrame, nodeIds: [] };
      groups.set(parentId, g);
    }
    if (!g.nodeIds.includes(childId)) g.nodeIds.push(childId);
  };

  const addFrame = (frame: TLShape): void => {
    if (frame.meta?.didrawLocked) return;
    for (const child of childrenOf(editor, frame.id)) {
      if (child.type === "schema-container") {
        for (const k of childrenOf(editor, child.id)) {
          if (isRespreadLeaf(k.type))
            add(child.id as string, k.id as string, "min", CONTAINER_REFIT_PAD, false);
        }
        add(frame.id as string, child.id as string, "min", FRAME_REFIT_PAD, true);
      } else if (isRespreadLeaf(child.type)) {
        add(frame.id as string, child.id as string, "min", FRAME_REFIT_PAD, true);
      }
    }
  };

  const sel = ids.map((id) => editor.getShape(id)).filter((s): s is TLShape => !!s);

  if (sel.length === 0) {
    // board: every frame + loose page-level nodes
    for (const s of editor.getCurrentPageShapes()) {
      if (s.type === "frame") addFrame(s);
      else if (
        (isRespreadLeaf(s.type) || s.type === "schema-container") &&
        s.parentId.startsWith("page:")
      )
        add(s.parentId, s.id as string, "center", null, false);
    }
  } else {
    for (const s of sel) {
      if (s.type === "frame") {
        addFrame(s);
      } else if (s.type === "schema-container") {
        for (const k of childrenOf(editor, s.id)) {
          if (isRespreadLeaf(k.type))
            add(s.id as string, k.id as string, "min", CONTAINER_REFIT_PAD, false);
        }
      } else if (isRespreadLeaf(s.type)) {
        const parent = editor.getShape(s.parentId as TLShapeId);
        if (parent?.type === "schema-container")
          add(parent.id as string, s.id as string, "min", CONTAINER_REFIT_PAD, false);
        else if (parent?.type === "frame")
          add(parent.id as string, s.id as string, "min", FRAME_REFIT_PAD, true);
        else add(s.parentId, s.id as string, "center", null, false);
      }
    }
  }
  return [...groups.values()];
}

/** Build a RespreadNode for `id`, reading geometry from the snapshot or live. */
function toRespreadNode(
  editor: Editor,
  id: string,
  snapshot?: RespreadSnapshot,
): RespreadNode | null {
  const s = editor.getShape(id as TLShapeId);
  if (!s) return null;
  const snap = snapshot?.get(id);
  const wh = snap ?? leafSize(editor, id);
  return {
    id,
    x: snap ? snap.x : s.x,
    y: snap ? snap.y : s.y,
    w: wh.w,
    h: wh.h,
    // The density gesture is a DIRECT user manipulation of the selection — it sets
    // user positions, so it moves shapes regardless of meta.pinned (pins guard only
    // against AI / auto-layout, not the user's own spread; without this it would be
    // a no-op on hand-arranged content, which is auto-pinned on drag — DRW-185).
    // Shapes keep their pinned flag (their new position is still user-owned).
    pinned: false,
  };
}

/** Resize a frame/container to wrap its (just-moved) children, top-left fixed. */
function refitWrapper(editor: Editor, parentId: TLShapeId, pad: number): void {
  const f = editor.getShape(parentId);
  const fb = editor.getShapePageBounds(parentId);
  if (!f || !fb) return;
  let maxx = Number.NEGATIVE_INFINITY;
  let maxy = Number.NEGATIVE_INFINITY;
  for (const t of childrenOf(editor, parentId)) {
    const b = editor.getShapePageBounds(t.id);
    if (!b) continue;
    maxx = Math.max(maxx, b.x + b.w);
    maxy = Math.max(maxy, b.y + b.h);
  }
  if (!Number.isFinite(maxx)) return;
  editor.updateShape({
    id: parentId,
    type: f.type,
    props: { w: maxx - fb.x + pad, h: maxy - fb.y + pad },
  } as never);
}

/**
 * Синхронный эффективный размер shape из props (`w`, `h + growY`) — НЕ через
 * `getShapePageBounds`. Derived-геометрия (page bounds / пересчёт growY)
 * обновляется лениво ПОСЛЕ транзакции, а props читаются сразу после updateShape;
 * поэтому внутри одной транзакции, где обтяжка только что изменила РАЗМЕРЫ узлов
 * (`applyTextFitToShape` ставит `props.w/h` и `growY=0`), синхронны именно props.
 * (Density-респред меняет лишь x/y — прямые атомы — и потому корректно работает с
 * page bounds; для обтяжки размеров это не так. DRW-232.)
 */
export function effectiveSizeFromProps(s: TLShape): { w: number; h: number } {
  const p = s.props as { w?: number; h?: number; growY?: number };
  return {
    w: typeof p.w === "number" ? p.w : 0,
    h:
      (typeof p.h === "number" ? p.h : 0) +
      (typeof p.growY === "number" ? p.growY : 0),
  };
}

/**
 * DRW-232: устранить наезд box-like детей обёртки (контейнер/фрейм) вдоль её
 * направления — точечный push (resolveOverlapsAlongFlow): двигаются ТОЛЬКО
 * реально наезжающие узлы, остальные интервалы не трогаются. Направление берём из
 * `props.direction` (контейнер) / `meta.didrawDirection` (фрейм); не-cardinal →
 * ось из геометрии. `meta.pinned` дети не двигаются. Размеры — из props (синхронно
 * внутри транзакции), координаты — parent-relative.
 */
function resolveOverlapsInWrapper(
  editor: Editor,
  parentId: TLShapeId,
  gap: number,
): void {
  const parent = editor.getShape(parentId);
  if (!parent) return;
  const dir =
    parent.type === "frame"
      ? (parent.meta?.didrawDirection as string | null | undefined)
      : (parent.props as { direction?: string }).direction;
  const kids = childrenOf(editor, parentId).filter(
    (s) => isRespreadLeaf(s.type) || s.type === "schema-container",
  );
  if (kids.length < 2) return;
  const nodes: FlowNode[] = kids.map((s) => {
    const sz = effectiveSizeFromProps(s);
    return {
      id: s.id as string,
      x: s.x,
      y: s.y,
      w: sz.w,
      h: sz.h,
      pinned: s.meta?.pinned === true,
    };
  });
  const moves = resolveOverlapsAlongFlow(nodes, dir, gap);
  if (moves.length === 0) return;
  const updates = moves.map((m) => {
    const s = editor.getShape(m.id as TLShapeId);
    return {
      id: m.id,
      type: s?.type,
      ...(m.x !== undefined ? { x: m.x } : {}),
      ...(m.y !== undefined ? { y: m.y } : {}),
    };
  });
  editor.updateShapes(updates as never);
}

/**
 * Синхронный envelope-refit обёртки под детей: правый/нижний край контента в
 * parent-relative (`child.x + size`) + padding, top-left fixed (рост И сжатие).
 * Размеры детей — из props (effectiveSizeFromProps), позиции — shape.x/y → верно
 * внутри той же транзакции, где обтяжка и inner-refit только что изменили размеры
 * (page bounds там ещё stale). Отдельно от density-`refitWrapper` (тот по page
 * bounds — корректно для своего сценария смены позиций). DRW-232.
 */
function refitWrapperSync(
  editor: Editor,
  parentId: TLShapeId,
  pad: number,
): void {
  const f = editor.getShape(parentId);
  if (!f) return;
  let maxx = Number.NEGATIVE_INFINITY;
  let maxy = Number.NEGATIVE_INFINITY;
  for (const t of childrenOf(editor, parentId)) {
    const sz = effectiveSizeFromProps(t);
    maxx = Math.max(maxx, t.x + sz.w);
    maxy = Math.max(maxy, t.y + sz.h);
  }
  if (!Number.isFinite(maxx)) return;
  editor.updateShape({
    id: parentId,
    type: f.type,
    props: { w: maxx + pad, h: maxy + pad },
  } as never);
}

/** Обёртки-предки (контейнер/фрейм) узла `id`, от ближайшей к дальней. */
function wrapperAncestors(editor: Editor, id: TLShapeId): TLShapeId[] {
  const out: TLShapeId[] = [];
  let cur: TLShape | undefined = editor.getShape(id);
  while (cur) {
    const pid = cur.parentId;
    if (!pid.startsWith("shape:")) break;
    const parent = editor.getShape(pid as TLShapeId);
    if (!parent) break;
    if (parent.type === "schema-container" || parent.type === "frame")
      out.push(parent.id);
    cur = parent;
  }
  return out;
}

/**
 * DRW-232: привести обёртки в порядок после ручной обтяжки. Для каждой обёртки,
 * содержащей обтянутый узел, ИЗНУТРИ НАРУЖУ: (1) устранить наезд детей точечным
 * push вдоль направления, (2) обтянуть обёртку под детей (envelope: рост И сжатие,
 * top-left fixed). Порядок inner→outer важен — внутренний контейнер примет новый
 * размер раньше, и внешний фрейм увидит его (через props) при своём push/refit.
 * Размеры читаются из props (синхронно) → работает внутри одной editor.run().
 * Ожидается ВНУТРИ editor.run() вызывающей стороны (одна undo-точка).
 */
export function reflowAfterFit(
  editor: Editor,
  fittedIds: ReadonlyArray<string>,
): void {
  const wrappers = new Set<string>();
  for (const id of fittedIds)
    for (const w of wrapperAncestors(editor, id as TLShapeId))
      wrappers.add(w as string);
  if (wrappers.size === 0) return;
  // Сортируем по числу обёрток-предков убыв. → самая вложенная первой.
  const ordered = [...wrappers]
    .map((id) => ({
      id,
      depth: wrapperAncestors(editor, id as TLShapeId).length,
    }))
    .sort((a, b) => b.depth - a.depth);
  for (const { id } of ordered) {
    const s = editor.getShape(id as TLShapeId);
    if (!s) continue;
    resolveOverlapsInWrapper(editor, id as TLShapeId, RESPREAD_MIN_GAP);
    const pad = s.type === "frame" ? FRAME_REFIT_PAD : CONTAINER_REFIT_PAD;
    refitWrapperSync(editor, id as TLShapeId, pad);
  }
}

/**
 * DRW-232 (авто-envelope): вырастить ОДНУ обёртку под её содержимое — только
 * рост, без сжатия и без push. В отличие от `refitWrapperSync` (ручной путь,
 * растит И сжимает) тут `growOnlyBox` берёт max с текущим размером: уменьшение
 * ребёнка не сжимает родителя (AC #7). User-pinned размер обёртки
 * (`didrawSizePinned` с origin "user" — явный drag-resize фрейма/контейнера)
 * уважается и НЕ трогается. Идемпотентно: если обёртка уже вмещает контент,
 * возвращает false без записи — это делает авто-пасс loop-safe. Размеры детей —
 * из props (синхронно внутри одной транзакции). Возвращает true, если обёртка
 * выросла.
 */
function refitWrapperGrowOnly(
  editor: Editor,
  parentId: TLShapeId,
  pad: number,
): boolean {
  const f = editor.getShape(parentId);
  if (!f) return false;
  const meta = f.meta as
    | { didrawSizePinned?: unknown; didrawSizeOrigin?: unknown }
    | undefined;
  if (meta?.didrawSizePinned === true && meta?.didrawSizeOrigin === "user")
    return false;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const t of childrenOf(editor, parentId)) {
    const sz = effectiveSizeFromProps(t);
    right = Math.max(right, t.x + sz.w);
    bottom = Math.max(bottom, t.y + sz.h);
  }
  if (!Number.isFinite(right)) return false;
  const cur = f.props as { w?: number; h?: number };
  const grown = growOnlyBox(
    {
      w: typeof cur.w === "number" ? cur.w : 0,
      h: typeof cur.h === "number" ? cur.h : 0,
    },
    { right, bottom },
    pad,
  );
  if (!grown) return false;
  editor.updateShape({
    id: parentId,
    type: f.type,
    props: { w: grown.w, h: grown.h },
  } as never);
  return true;
}

/**
 * DRW-232 (авто-envelope): вырастить все обёртки-предки переданных узлов под их
 * содержимое — grow-only, изнутри наружу (как `reflowAfterFit`, но без push и без
 * сжатия). Используется авто-listener'ом (`registerAutoEnvelope`) при росте/
 * добавлении вложенного узла и при ручном drag-resize ребёнка (AC #5/#6/#7).
 * Ожидается ВНУТРИ `editor.run()` вызывающей стороны (одна undo-точка).
 * Возвращает true, если хоть одна обёртка выросла.
 */
export function growWrappersForShapes(
  editor: Editor,
  shapeIds: ReadonlyArray<string>,
): boolean {
  const wrappers = new Set<string>();
  for (const id of shapeIds)
    for (const w of wrapperAncestors(editor, id as TLShapeId))
      wrappers.add(w as string);
  if (wrappers.size === 0) return false;
  const ordered = [...wrappers]
    .map((id) => ({
      id,
      depth: wrapperAncestors(editor, id as TLShapeId).length,
    }))
    .sort((a, b) => b.depth - a.depth);
  let any = false;
  for (const { id } of ordered) {
    const s = editor.getShape(id as TLShapeId);
    if (!s) continue;
    const pad = s.type === "frame" ? FRAME_REFIT_PAD : CONTAINER_REFIT_PAD;
    if (refitWrapperGrowOnly(editor, id as TLShapeId, pad)) any = true;
  }
  return any;
}

/** Capture parent-relative geometry of every node the gesture may move. */
export function captureRespreadSnapshot(
  editor: Editor,
  ids: TLShapeId[],
): RespreadSnapshot {
  const snap: RespreadSnapshot = new Map();
  for (const g of resolveRespreadGroups(editor, ids)) {
    for (const id of g.nodeIds) {
      const s = editor.getShape(id as TLShapeId);
      if (s) snap.set(id, { x: s.x, y: s.y, ...leafSize(editor, id) });
    }
  }
  return snap;
}

/**
 * DRW-239: relative density respread — scale the addressed shapes' positions by
 * `k` (k>1 spreads, k<1 compresses) WITHOUT re-running ELK, so structure and
 * direction are preserved by construction. Sizes are never changed; connectors
 * (bound elbows) follow on their own; containers/frames refit to content.
 *
 * The factor is clamped per the min-gap guard so compression never overlaps boxes
 * (the most restrictive level wins, applied uniformly). Pinned nodes and
 * size-pinned/locked wrappers are left untouched. `opts.snapshot` (captured at a
 * gesture's pointer-down) makes a live drag scale the START layout rather than
 * compounding; without it the current layout is the base.
 */
export function applyRespread(
  editor: Editor,
  ids: TLShapeId[],
  k: number,
  opts?: { snapshot?: RespreadSnapshot; minGap?: number; markHistory?: boolean },
): ElkLayoutResult {
  const minGap = opts?.minGap ?? RESPREAD_MIN_GAP;
  const groups = resolveRespreadGroups(editor, ids);
  if (groups.length === 0)
    return { kind: "noop", reason: "nothing to respread" };

  // Build each level's nodes once; compute the global compression floor so one
  // uniform factor keeps EVERY level's boxes ≥ minGap apart (the tightest wins).
  const levels = groups
    .map((g) => ({
      group: g,
      nodes: g.nodeIds
        .map((id) => toRespreadNode(editor, id, opts?.snapshot))
        .filter((n): n is RespreadNode => n !== null),
    }))
    .filter((l) => l.nodes.length > 0);
  if (levels.length === 0)
    return { kind: "noop", reason: "nothing movable to respread" };

  let floor = 0;
  for (const l of levels) floor = Math.max(floor, levelMinK(l.nodes, minGap));
  const kEff = Math.max(k, floor);

  const updates: Record<string, unknown>[] = [];
  for (const l of levels) {
    for (const r of computeRespreadLevel(l.nodes, kEff, l.group.anchor)) {
      const s = editor.getShape(r.id as TLShapeId);
      if (s) updates.push({ id: s.id, type: s.type, x: r.x, y: r.y });
    }
  }
  if (updates.length === 0)
    return { kind: "noop", reason: "everything is pinned — nothing to respread" };

  // Wrappers to refit: the in-scope wrapper parents PLUS every ancestor frame of a
  // moved shape, so a frame grows/shrinks to wrap spread content even when only its
  // children (a container, loose nodes) were addressed — not just when the frame
  // itself was selected. Density is a direct user gesture, so it refits even
  // size-pinned wrappers (they keep the pin, just at the new size — like a pinned
  // shape that the user drags). Containers first, then frames (a frame wraps the
  // already-resized boxes).
  const refits = new Map<string, { id: string; pad: number; isFrame: boolean }>();
  for (const g of groups) {
    if (g.refitPad !== null)
      refits.set(g.parentId, {
        id: g.parentId,
        pad: g.refitPad,
        isFrame: g.parentIsFrame,
      });
  }
  for (const u of updates) {
    const f = ancestorFrame(editor, u.id as TLShapeId);
    if (f && !refits.has(f as string))
      refits.set(f as string, { id: f as string, pad: FRAME_REFIT_PAD, isFrame: true });
  }
  const refitList = [...refits.values()].sort(
    (a, b) => Number(a.isFrame) - Number(b.isFrame),
  );

  // One-shot callers get an undo boundary here; a live drag passes markHistory:false
  // and marks ONCE at gesture start so the whole drag collapses to a single ⌘Z.
  if (opts?.markHistory !== false) editor.markHistoryStoppingPoint();
  // Suppress schema-container auto-flip (moving a container's children through
  // editor.run is stamped source:"user" → would rewrite props.direction).
  withAutoFlipSuppressed(() =>
    editor.run(() => {
      editor.updateShapes(updates as never);
      for (const r of refitList) {
        if (editor.getShape(r.id as TLShapeId))
          refitWrapper(editor, r.id as TLShapeId, r.pad);
      }
    }),
  );
  return {
    kind: "ok",
    applied: updates.length,
    frameId: "",
    affected: updates.map((u) => u.id as string),
  };
}
