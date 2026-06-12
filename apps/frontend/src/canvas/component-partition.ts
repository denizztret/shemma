/**
 * Connected-component layer of the frame layout (DRW-218).
 *
 * ELK's own `separateConnectedComponents` packs disconnected components by the
 * AGGREGATE bbox — any edit to one component shifts the others. This module
 * makes the split explicit and deterministic: WE partition the collapsed root
 * graph, ELK only ever sees one connected graph per run, and the components are
 * then placed by `packComponents` in a stable, input-independent order.
 *
 * Pure functions, no Editor — unit-tested exhaustively.
 */

export type ComponentInfo = {
  /** Top-level ids (container boxes + loose geo), in input order. */
  ids: string[];
  /** Total leaf nodes across the component (containers count their children). */
  leaves: number;
  /** Total input box area — ranking tie-break. */
  area: number;
};

/**
 * Union-find over the collapsed root edges. Components come out in first-id
 * input order; ids inside a component keep the input order — fully
 * deterministic for identical input.
 */
export function partitionComponents(
  topLevelIds: ReadonlyArray<string>,
  edges: ReadonlyArray<{ from: string; to: string }>,
): string[][] {
  const index = new Map<string, number>();
  topLevelIds.forEach((id, i) => index.set(id, i));
  const parent = topLevelIds.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    let c = i;
    while (parent[c] !== r) {
      const next = parent[c] ?? c;
      parent[c] = r;
      c = next;
    }
    return r;
  };
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a == null || b == null) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  const groups = new Map<number, string[]>();
  topLevelIds.forEach((id, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(id);
    else groups.set(r, [id]);
  });
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ids]) => ids);
}

/**
 * Rank components: most leaves first (the "main" schema), tie-broken by total
 * area, then by the lexicographically smallest first id. Index 0 = main.
 */
export function rankComponents(
  components: ReadonlyArray<ReadonlyArray<string>>,
  info: Readonly<Record<string, { leaves: number; area: number }>>,
): ComponentInfo[] {
  const enriched: ComponentInfo[] = components.map((ids) => {
    let leaves = 0;
    let area = 0;
    for (const id of ids) {
      leaves += info[id]?.leaves ?? 1;
      area += info[id]?.area ?? 0;
    }
    return { ids: [...ids], leaves, area };
  });
  return enriched.sort(
    (a, b) =>
      b.leaves - a.leaves ||
      b.area - a.area ||
      (String(a.ids[0]) < String(b.ids[0]) ? -1 : 1),
  );
}

/**
 * A "stray" is a singleton component consisting of one loose GEO node — a note
 * dropped next to the schema. Strays are merged into ONE pseudo-component
 * (flow-chained along the frame direction by the caller) instead of each
 * becoming its own cross-axis component. A lone CONTAINER is a real schema —
 * never a stray.
 */
export function splitStrays(
  ranked: ReadonlyArray<ComponentInfo>,
  isStrayEligible: (id: string) => boolean,
): { real: ComponentInfo[]; strays: string[] } {
  const real: ComponentInfo[] = [];
  const strays: string[] = [];
  for (const c of ranked) {
    const firstId = c.ids[0] ?? "";
    if (c.ids.length === 1 && isStrayEligible(firstId)) {
      strays.push(firstId);
    } else {
      real.push(c);
    }
  }
  return { real, strays };
}

export type PackedOffset = { dx: number; dy: number };

/**
 * Deterministic component placement: the main component (index 0) keeps its
 * ELK coordinates; the rest stack ACROSS the frame's flow axis in ranked order —
 * TB/BT frame → a column to the RIGHT of the main bbox, LR/RL → a row BELOW it.
 * Reads as "a separate schema beside the flow", never as its continuation.
 */
export function packComponents(
  boxes: ReadonlyArray<{ w: number; h: number }>,
  frameDir: string,
  gap: number,
): PackedOffset[] {
  if (boxes.length === 0) return [];
  const out: PackedOffset[] = [{ dx: 0, dy: 0 }];
  const main = boxes[0] ?? { w: 0, h: 0 };
  const verticalFlow = frameDir === "TB" || frameDir === "BT";
  let cursor = 0;
  for (let i = 1; i < boxes.length; i++) {
    const b = boxes[i] ?? { w: 0, h: 0 };
    if (verticalFlow) {
      out.push({ dx: main.w + gap, dy: cursor });
      cursor += b.h + gap;
    } else {
      out.push({ dx: cursor, dy: main.h + gap });
      cursor += b.w + gap;
    }
  }
  return out;
}

export type ComponentGraph = {
  ids: string[];
  edges: Array<{ id: string; sources: string[]; targets: string[] }>;
};

/** Split the collapsed root edge list per component (source decides ownership). */
export function buildComponentGraphs(
  components: ReadonlyArray<ComponentInfo>,
  rootEdges: ReadonlyArray<{
    id: string;
    sources: string[];
    targets: string[];
  }>,
): ComponentGraph[] {
  const componentOf = new Map<string, number>();
  components.forEach((c, i) => {
    for (const id of c.ids) componentOf.set(id, i);
  });
  const out: ComponentGraph[] = components.map((c) => ({
    ids: [...c.ids],
    edges: [],
  }));
  for (const e of rootEdges) {
    const sourceId = e.sources[0] ?? "";
    const i = componentOf.get(sourceId);
    if (i != null) {
      const graph = out[i];
      if (graph) graph.edges.push(e);
    }
  }
  return out;
}
