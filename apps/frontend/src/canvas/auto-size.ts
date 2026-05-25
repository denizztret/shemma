import type { Editor, TLShape } from "tldraw";

/**
 * DRW-171 / DRW-077: Re-run ShapeUtil.onBeforeCreate for shapes that arrived
 * via store.put (snapshot load, WS mergeRemoteChanges).
 *
 * `GeoShapeUtil.onBeforeCreate` measures the label via `editor.textMeasure`
 * and produces `growY` / expanded `w` so text fits the box. tldraw runs it
 * only when shapes pass through `editor.createShape` — `store.put` bypasses
 * the hook, so shapes from backend (mermaid-import, AI domain actions)
 * arrive with raw `w/h` and clipped text.
 *
 * `onBeforeUpdate` cannot substitute: it early-returns when richText/font/
 * size are equal between prev and next (see tldraw GeoShapeUtil.mjs), so a
 * no-op `updateShape({...same props})` never re-measures. Calling
 * `util.onBeforeCreate(shape)` directly does the measure regardless of
 * diff, and we apply the returned props through `updateShape`.
 *
 * DRW-174 addition: for shapes inside a v2 `schema-frame`, the local update
 * leaves the frame's `props.h` stale (backend packed children at estimate
 * 220×80; after autosize children are taller than the frame). To repack the
 * frame and any sibling subgraphs we POST the effective bounds to backend
 * `/api/schema/:frameId/measured-bounds` — backend writes the normalized
 * bounds (h includes growY, growY reset to 0) and re-runs layout so frame
 * Pass A recomputes `props.w/h` covering the real child sizes. Result lands
 * back via WS broadcast.
 *
 * Whitelist: only tldraw default shapes that have a text-driven autosize
 * path in their `onBeforeCreate`. Custom shapes manage their own sizing.
 */
const AUTOSIZE_TYPES: ReadonlySet<string> = new Set(["geo", "note", "text"]);

const LEGACY_SPACE_ID = "__legacy__";

function readQueryParam(name: string, fallback: string): string {
  if (typeof location === "undefined") return fallback;
  return new URLSearchParams(location.search).get(name) ?? fallback;
}

function findSchemaFrameAncestor(
  shapeMap: Map<string, TLShape>,
  startId: string,
): string | null {
  let cur = shapeMap.get(startId);
  let safety = 32;
  while (cur && safety-- > 0) {
    if (
      cur.type === "frame" &&
      // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
      (cur as any).meta?.didrawSchemaFrame === true
    ) {
      return cur.id;
    }
    // biome-ignore lint/suspicious/noExplicitAny: tldraw parentId untyped in TLShape
    const pid = (cur as any).parentId;
    if (typeof pid !== "string") return null;
    cur = shapeMap.get(pid);
  }
  return null;
}

/** Effective bounds — includes growY for geo/note, plain w for text. */
function effectiveBoundsDelta(
  shape: TLShape,
  next: TLShape,
): { w?: number; h?: number } | null {
  const sp = shape.props as Record<string, unknown>;
  const np = next.props as Record<string, unknown>;
  const oldW = typeof sp.w === "number" ? sp.w : 0;
  const oldH = typeof sp.h === "number" ? sp.h : 0;
  const oldGrowY = typeof sp.growY === "number" ? sp.growY : 0;
  const newW = typeof np.w === "number" ? np.w : oldW;
  const newH = typeof np.h === "number" ? np.h : oldH;
  const newGrowY = typeof np.growY === "number" ? np.growY : 0;
  const effOldH = oldH + oldGrowY;
  const effNewH = newH + newGrowY;
  const out: { w?: number; h?: number } = {};
  if (newW !== oldW) out.w = newW;
  if (effNewH !== effOldH) out.h = effNewH;
  return Object.keys(out).length > 0 ? out : null;
}

async function postMeasuredBounds(
  frameId: string,
  bounds: Record<string, { w?: number; h?: number }>,
): Promise<void> {
  if (typeof fetch === "undefined") return;
  const space = readQueryParam("space", LEGACY_SPACE_ID);
  const room = readQueryParam("room", "default");
  const qs = new URLSearchParams({ space, room }).toString();
  try {
    await fetch(
      `/api/schema/${encodeURIComponent(frameId)}/measured-bounds?${qs}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bounds }),
      },
    );
  } catch (e) {
    // Network failure non-fatal — the local updateShape has already corrected
    // visible text; backend stays at estimate but no user-facing crash.
    console.warn("[shemma] measured-bounds POST failed:", e);
  }
}

export function triggerAutoSize(editor: Editor, ids?: Set<string>): void {
  const all = editor.getCurrentPageShapes();
  const shapes = all.filter(
    (s) =>
      AUTOSIZE_TYPES.has(s.type) && (ids === undefined || ids.has(s.id)),
  );
  if (shapes.length === 0) return;

  // Build map once so walk-up is O(depth) instead of N per query.
  const shapeMap = new Map<string, TLShape>();
  for (const s of all) shapeMap.set(s.id, s);

  const byFrame = new Map<string, Record<string, { w?: number; h?: number }>>();

  editor.run(() => {
    for (const s of shapes) {
      const util = editor.getShapeUtil(s.type);
      // biome-ignore lint/suspicious/noExplicitAny: tldraw onBeforeCreate signature
      const next = (util as any).onBeforeCreate?.(s) as TLShape | undefined;
      if (!next) continue;
      // biome-ignore lint/suspicious/noExplicitAny: TLShape union of props variants
      editor.updateShape({
        id: s.id,
        type: s.type,
        props: next.props,
      } as any);

      const frameId = findSchemaFrameAncestor(shapeMap, s.id);
      if (!frameId) continue;
      const delta = effectiveBoundsDelta(s, next);
      if (!delta) continue;
      const frameBounds = byFrame.get(frameId) ?? {};
      frameBounds[s.id] = delta;
      byFrame.set(frameId, frameBounds);
    }
  });

  for (const [frameId, bounds] of byFrame) {
    void postMeasuredBounds(frameId, bounds);
  }
}
