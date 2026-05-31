// DRW-194: regenerate colliding `meta.didrawId` on local duplicate / paste.
//
// tldraw Cmd+D / copy-paste clones `meta` verbatim, so a duplicated v2
// schema-frame's children inherit the original's `didrawId`. didrawId is the
// stable address of the overlay protocol (DRW-134) — a global collision makes
// deep-link-by-didrawId and AI addressing ambiguous. The proper backend
// `/api/schema/{id}/duplicate` path remaps via `nodeIdMap`, but the tldraw
// shortcut bypasses it. This restores per-copy uniqueness for that fast path.
//
// Overlay safety: a schema-frame keeps user edits in `frame.meta.didrawOverlays`
// keyed by didrawId. Regenerating a child's id without re-keying its frame's
// overlays would orphan those edits, so the two are remapped together.

import { type NodeId, generateNodeId } from "@shemma/domain";
import type { Editor, TLShape, TLShapeId } from "tldraw";

/** One regeneration: a created shape whose didrawId collided gets a fresh one. */
export type DidrawRegen = {
  shapeId: string;
  oldDidrawId: string;
  newDidrawId: string;
};

/** Slug part of a NodeId (`<slug>-<6char>`) — everything before the last dash. */
function slugOf(didrawId: string): string {
  const i = didrawId.lastIndexOf("-");
  return i > 0 ? didrawId.slice(0, i) : "e";
}

/**
 * Pure core: for each created shape whose `didrawId` already exists, plan a
 * fresh didrawId (same slug, new suffix). `gen` is injected so the regeneration
 * is deterministic in tests. `existing` is mutated to reserve issued ids.
 */
export function planDidrawRegen(
  created: ReadonlyArray<{ id: string; didrawId?: string }>,
  existing: Set<string>,
  gen: (slug: string, existingIds: ReadonlySet<string>) => string,
): DidrawRegen[] {
  const out: DidrawRegen[] = [];
  for (const s of created) {
    const did = s.didrawId;
    if (typeof did !== "string" || did === "") continue;
    if (!existing.has(did)) {
      existing.add(did); // first sighting — legitimate, keep it
      continue;
    }
    let next: string;
    try {
      next = gen(slugOf(did), existing);
    } catch {
      continue; // retry exhaustion (astronomically rare) — leave as-is
    }
    existing.add(next);
    out.push({ shapeId: s.id, oldDidrawId: did, newDidrawId: next });
  }
  return out;
}

/** Walk up to the nearest schema-frame (a frame carrying `didrawOverlays`). */
function schemaFrameAncestor(
  editor: Editor,
  id: TLShapeId,
): TLShape | undefined {
  let cur: TLShape | undefined = editor.getShape(id);
  while (cur) {
    if (cur.type === "frame" && cur.meta?.didrawOverlays) return cur;
    const p = cur.parentId;
    cur =
      typeof p === "string" && p.startsWith("shape:")
        ? editor.getShape(p as TLShapeId)
        : undefined;
  }
  return undefined;
}

/**
 * Register the dedup listener. `source:"user"` only — WS/AI-applied shapes
 * arrive via mergeRemoteChanges with correct ids and never fire this. Returns a
 * disposer.
 */
export function registerDidrawIdDedup(editor: Editor): () => void {
  return editor.store.listen(
    (entry) => {
      const added = Object.values(entry.changes.added).filter(
        (r) => (r as { typeName?: string }).typeName === "shape",
      ) as unknown as TLShape[];
      if (added.length === 0) return;

      const addedIds = new Set(added.map((s) => s.id));
      const existing = new Set<string>();
      for (const r of editor.store.allRecords()) {
        const s = r as unknown as TLShape & { typeName: string };
        if (s.typeName !== "shape" || addedIds.has(s.id)) continue;
        const d = s.meta?.didrawId;
        if (typeof d === "string" && d) existing.add(d);
      }

      const regens = planDidrawRegen(
        added.map((s) => ({
          id: s.id as string,
          didrawId:
            typeof s.meta?.didrawId === "string"
              ? (s.meta.didrawId as string)
              : undefined,
        })),
        existing,
        (slug, ex) =>
          generateNodeId({ slug, existingIds: ex as ReadonlySet<NodeId> }),
      );
      if (regens.length === 0) return;

      // Group old→new per affected schema-frame so we can re-key its overlays.
      const remapByFrame = new Map<TLShapeId, Map<string, string>>();
      const shapeUpdates: Array<Record<string, unknown>> = [];
      for (const r of regens) {
        const s = editor.getShape(r.shapeId as TLShapeId);
        if (!s) continue;
        shapeUpdates.push({
          id: s.id,
          type: s.type,
          meta: { ...(s.meta ?? {}), didrawId: r.newDidrawId },
        });
        const frame = schemaFrameAncestor(editor, s.id);
        if (frame) {
          let m = remapByFrame.get(frame.id);
          if (!m) {
            m = new Map();
            remapByFrame.set(frame.id, m);
          }
          m.set(r.oldDidrawId, r.newDidrawId);
        }
      }

      const frameUpdates: Array<Record<string, unknown>> = [];
      for (const [frameId, map] of remapByFrame) {
        const f = editor.getShape(frameId);
        const overlays = f?.meta?.didrawOverlays as
          | Record<string, unknown>
          | undefined;
        if (!f || !overlays) continue;
        const nextOverlays: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(overlays))
          nextOverlays[map.get(k) ?? k] = v;
        frameUpdates.push({
          id: frameId,
          type: "frame",
          meta: { ...(f.meta ?? {}), didrawOverlays: nextOverlays },
        });
      }

      editor.run(
        () => {
          for (const u of shapeUpdates) editor.updateShape(u as never);
          for (const u of frameUpdates) editor.updateShape(u as never);
        },
        { history: "ignore" },
      );
    },
    { source: "user", scope: "document" },
  );
}
