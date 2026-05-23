
import type { RoomState } from "../../types";
import {
  type ArrowEndpoints,
  buildArrowEndpointsIndex,
  buildConnectorPayload,
  buildShapeForFrame,
  buildShapePayload,
  buildStickyNotePayload,
  buildTextPayload,
  expandGroups,
} from "./builder";
import { MiroAuthError, MiroNotFoundError, MiroRateLimitError } from "./client";
import type { MiroBulkItem, MiroClient, MiroConnectorPayload } from "./client";
import { computeCentroid, resolvePageBounds, type RawShape } from "./coords";
import { commitBoardExport, commitBoardGroupExport } from "./tracking";

const BULK_CHUNK_SIZE = 20;
const CONNECTOR_CONCURRENCY = 10;

export interface RunExportParams {
  client: MiroClient;
  room: RoomState;
  boardId: string;
  boardName?: string;
  /** Element ids selected for export. Groups will be expanded. */
  selection: string[];
  /** Called after each commitBoardExport. Flush persistence here for partial-commit safety. */
  onCommit?: (room: RoomState) => void;
}

export interface SkippedItem {
  elementId: string;
  reason: "unsupported-type" | "cross-selection-connector" | "validation-error";
}

export interface RunExportResult {
  itemsCreated: number;
  connectorsCreated: number;
  skipped: SkippedItem[];
  error?: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isFrameLike(shape: RawShape): boolean {
  if (shape.type === "frame") return true;
  if (shape.meta && shape.meta.role === "boundary") return true;
  return false;
}

/** Partition selection into frames, leaf items, arrows, and unsupported shapes. */
function classify(
  selection: string[],
  store: Record<string, RawShape>,
): { frames: string[]; items: string[]; arrows: string[]; unsupported: string[] } {
  const frames: string[] = [];
  const items: string[] = [];
  const arrows: string[] = [];
  const unsupported: string[] = [];
  for (const id of selection) {
    const s = store[id];
    if (!s || s.typeName !== "shape") continue;
    if (isFrameLike(s)) {
      frames.push(id);
      continue;
    }
    if (s.type === "arrow") {
      arrows.push(id);
      continue;
    }
    if (s.type === "geo" || s.type === "note" || s.type === "text") {
      items.push(id);
      continue;
    }
    if (s.type === "group") {
      // Groups are pre-expanded by the caller; skip any that leak through.
      continue;
    }
    unsupported.push(id);
  }
  return { frames, items, arrows, unsupported };
}

function buildChildrenIndex(
  store: Record<string, RawShape>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id in store) {
    const r = store[id];
    if (r?.typeName !== "shape" || !r.parentId) continue;
    const list = out.get(r.parentId) ?? [];
    list.push(id);
    out.set(r.parentId, list);
  }
  return out;
}

function expandFrameDescendants(
  ids: string[],
  store: Record<string, RawShape>,
  childrenByParent: Map<string, string[]>,
): string[] {
  const out = new Set(ids);
  function walk(parentId: string): void {
    for (const cid of childrenByParent.get(parentId) ?? []) {
      if (out.has(cid)) continue;
      out.add(cid);
      walk(cid);
    }
  }
  for (const id of ids) {
    const s = store[id];
    if (s && isFrameLike(s)) walk(id);
  }
  return Array.from(out);
}

function expandImplicitArrows(
  ids: string[],
  endpointsIndex: Map<string, ArrowEndpoints>,
): string[] {
  const set = new Set(ids);
  for (const [arrowId, ep] of endpointsIndex) {
    if (ep.start && ep.end && set.has(ep.start.toId) && set.has(ep.end.toId)) {
      set.add(arrowId);
    }
  }
  return Array.from(set);
}

/**
 * Sort frames outer-first → inner-last (by parent depth).
 * Frames whose parentId is not in the set are treated as roots (depth 0).
 * Ensures Miro receives parent frames before their child frames in bulk create.
 */
export function framesInDepthFirstOrder<T extends { id: string; parentId?: string }>(
  frames: T[],
): T[] {
  const byId = new Map(frames.map(f => [f.id, f]));
  const depth = (f: T): number => {
    let d = 0;
    let cur: T | undefined = f;
    const seen = new Set<string>();
    while (cur?.parentId && byId.has(cur.parentId)) {
      if (seen.has(cur.id)) break; // cycle guard
      seen.add(cur.id);
      d++;
      cur = byId.get(cur.parentId);
    }
    return d;
  };
  return [...frames].sort((a, b) => depth(a) - depth(b));
}

export async function runMiroExport(p: RunExportParams): Promise<RunExportResult> {
  const skipped: SkippedItem[] = [];
  const store = p.room.store.store as Record<string, RawShape>;

  const childrenByParent = buildChildrenIndex(store);
  const endpointsIndex = buildArrowEndpointsIndex(store);

  // Tldraw Cmd+A excludes frame children due to selection mutex. We bring them
  // back so the user's exported frame isn't an empty container in Miro.
  // Then pick up arrows whose both endpoints are now in the expanded selection
  // but were excluded by the same mutex (e.g. arrow between frame children).
  const withFrameChildren = expandFrameDescendants(p.selection, store, childrenByParent);
  const expanded = expandGroups(withFrameChildren, store);
  const expandedWithArrows = expandImplicitArrows(expanded, endpointsIndex);
  const { frames, items, arrows, unsupported } = classify(expandedWithArrows, store);
  for (const u of unsupported) skipped.push({ elementId: u, reason: "unsupported-type" });

  const boundsCache = new Map<string, NonNullable<ReturnType<typeof resolvePageBounds>>>();
  function bounds(id: string): ReturnType<typeof resolvePageBounds> {
    const cached = boundsCache.get(id);
    if (cached) return cached;
    const b = resolvePageBounds(id, store);
    if (b) boundsCache.set(id, b);
    return b;
  }
  const allBounds = [...frames, ...items, ...arrows]
    .map((id) => bounds(id))
    .filter((b): b is NonNullable<typeof b> => b !== null);
  const centroid = computeCentroid(allBounds);

  function miroPos(id: string): { x: number; y: number; w: number; h: number } | null {
    const b = bounds(id);
    if (!b) return null;
    return {
      x: b.x + b.w / 2 - centroid.x,
      y: b.y + b.h / 2 - centroid.y,
      w: b.w,
      h: b.h,
    };
  }

  const frameMap = new Map<string, string>();
  const itemMap = new Map<string, string>();
  let runError: string | undefined;

  if (frames.length > 0) {
    const orderedFrameIds = framesInDepthFirstOrder(
      frames.map(id => ({ id, parentId: store[id]?.parentId as string | undefined })),
    ).map(f => f.id);

    const payload: Array<{ id: string; item: MiroBulkItem }> = orderedFrameIds
      .map((id) => {
        const s = store[id];
        const pos = miroPos(id);
        if (!s || !pos) return null;
        const item = buildShapeForFrame(s, { miroX: pos.x, miroY: pos.y });
        item.geometry = { width: pos.w, height: pos.h };
        return { id, item };
      })
      .filter((r): r is { id: string; item: MiroBulkItem } => r !== null);

    try {
      for (const ch of chunk(payload, BULK_CHUNK_SIZE)) {
        const resp = await p.client.bulkItems(p.boardId, ch.map((r) => r.item));
        ch.forEach((r, i) => {
          const got = resp.data[i]?.id;
          if (got) frameMap.set(r.id, got);
        });
      }
      commitBoardExport(p.room, {
        boardId: p.boardId,
        boardName: p.boardName,
        itemMappings: Array.from(frameMap, ([elementId, miroItemId]) => ({ elementId, miroItemId })),
        connectorMappings: [],
      });
      p.onCommit?.(p.room);
    } catch (e) {
      runError = `pass-a1: ${(e as Error).message}`;
      return {
        itemsCreated: frameMap.size,
        connectorsCreated: 0,
        skipped,
        error: runError,
      };
    }
  }

  if (items.length > 0) {
    const payload: Array<{ id: string; item: MiroBulkItem }> = items
      .map((id) => {
        const s = store[id];
        const pos = miroPos(id);
        if (!s || !pos) return null;

        // Frame-as-shape mode: resolvePageBounds already returns absolute page
        // coordinates, so no parent-relative offset math is needed.
        const ctx = { miroX: pos.x, miroY: pos.y };
        let item: MiroBulkItem;
        if (s.type === "note") item = buildStickyNotePayload(s, ctx);
        else if (s.type === "text") item = buildTextPayload(s, ctx);
        else item = buildShapePayload(s, ctx);
        item.geometry = item.geometry ?? { width: pos.w, height: pos.h };
        return { id, item };
      })
      .filter((r): r is { id: string; item: MiroBulkItem } => r !== null);

    // Auth/not-found/rate-limit errors abort the pass; validation (4xx/422) skips the chunk.
    const a2Errors: string[] = [];
    for (const ch of chunk(payload, BULK_CHUNK_SIZE)) {
      try {
        const resp = await p.client.bulkItems(p.boardId, ch.map((r) => r.item));
        ch.forEach((r, i) => {
          const got = resp.data[i]?.id;
          if (got) itemMap.set(r.id, got);
        });
        commitBoardExport(p.room, {
          boardId: p.boardId,
          boardName: p.boardName,
          itemMappings: ch.map((r) => ({ elementId: r.id, miroItemId: itemMap.get(r.id) ?? "" }))
            .filter((m) => m.miroItemId !== ""),
          connectorMappings: [],
        });
        p.onCommit?.(p.room);
      } catch (e) {
        // Fatal errors abort the pass (re-throw to outer catch).
        if (
          e instanceof MiroAuthError ||
          e instanceof MiroNotFoundError ||
          e instanceof MiroRateLimitError
        ) {
          runError = `pass-a2: ${(e as Error).message}`;
          return {
            itemsCreated: frameMap.size + itemMap.size,
            connectorsCreated: 0,
            skipped,
            error: runError,
          };
        }
        a2Errors.push(`chunk(${ch.map((r) => r.id).join(",")}): ${(e as Error).message}`);
        for (const r of ch) {
          skipped.push({ elementId: r.id, reason: "validation-error" });
        }
      }
    }
    if (a2Errors.length > 0) {
      runError = `pass-a2 validation errors: ${a2Errors.join("; ")}`;
    }
  }

  const passAMap = new Map<string, string>([...frameMap, ...itemMap]);

  const connectorMappings: Array<{ elementId: string; miroConnectorId: string }> = [];

  const connectorTasks: Array<{ id: string; payload: MiroConnectorPayload }> = [];
  for (const id of arrows) {
    const s = store[id];
    if (!s) continue;
    const r = buildConnectorPayload(s, {
      store,
      passAMap,
      endpointsIndex,
    });
    if (r.kind === "skip") {
      skipped.push({ elementId: id, reason: r.reason });
      continue;
    }
    connectorTasks.push({ id, payload: r.payload });
  }

  let inFlight = 0;
  let nextIdx = 0;
  const errors: string[] = [];
  await new Promise<void>((resolve) => {
    const launch = () => {
      while (inFlight < CONNECTOR_CONCURRENCY && nextIdx < connectorTasks.length) {
        const task = connectorTasks[nextIdx++];
        inFlight += 1;
        p.client
          .postConnector(p.boardId, task.payload)
          .then((res) => {
            connectorMappings.push({ elementId: task.id, miroConnectorId: res.id });
          })
          .catch((e) => {
            errors.push(`${task.id}: ${(e as Error).message}`);
            skipped.push({ elementId: task.id, reason: "validation-error" });
          })
          .finally(() => {
            inFlight -= 1;
            if (nextIdx >= connectorTasks.length && inFlight === 0) {
              resolve();
            } else {
              launch();
            }
          });
      }
      if (connectorTasks.length === 0) resolve();
    };
    launch();
  });

  if (connectorMappings.length > 0) {
    commitBoardExport(p.room, {
      boardId: p.boardId,
      boardName: p.boardName,
      itemMappings: [],
      connectorMappings,
    });
    p.onCommit?.(p.room);
  }

  const passBError = errors.length > 0 ? `pass-b errors: ${errors.join("; ")}` : undefined;

  // Pass C — group widgets (DRW-111).
  // Miro constraint: each widget belongs to AT MOST one group.
  // Process frames deepest-first; outer groups skip widgets already claimed by
  // inner groups (otherwise 400 "Widgets are already grouped").
  // Outer group items = frame rectangle + descendants NOT yet in alreadyGrouped set.
  // Skip createGroup call when result has < 2 items (Miro min).
  let passCError: string | undefined;
  if (frames.length > 0) {
    const orderedFrames = framesInDepthFirstOrder(
      frames.map(id => ({ id, parentId: store[id]?.parentId as string | undefined })),
    );
    const framesDeepestFirst = [...orderedFrames].reverse();

    const selectionSet = new Set([...frames, ...items]);

    function descendantsOf(rootId: string): string[] {
      const out: string[] = [];
      for (const id of selectionSet) {
        if (id === rootId) continue;
        let cur: string | undefined = store[id]?.parentId as string | undefined;
        while (cur) {
          if (cur === rootId) { out.push(id); break; }
          cur = store[cur]?.parentId as string | undefined;
        }
      }
      return out;
    }

    const groupMappings: Array<{ elementId: string; miroGroupId: string }> = [];
    const alreadyGrouped = new Set<string>();
    for (const f of framesDeepestFirst) {
      const frameMiroId = frameMap.get(f.id);
      if (!frameMiroId) continue;
      const descendants = descendantsOf(f.id);
      const descendantMiroIds = descendants
        .map(d => frameMap.get(d) ?? itemMap.get(d))
        .filter((id): id is string => Boolean(id))
        .filter(id => !alreadyGrouped.has(id)); // skip widgets already claimed by inner groups
      if (descendantMiroIds.length === 0) continue; // need ≥1 ungrouped child + frame rect to reach Miro min 2
      const itemsPayload = [frameMiroId, ...descendantMiroIds];
      try {
        const resp = await p.client.createGroup(p.boardId, itemsPayload);
        groupMappings.push({ elementId: f.id, miroGroupId: resp.id });
        // Mark all included widgets as grouped so outer frames skip them
        alreadyGrouped.add(frameMiroId);
        for (const id of descendantMiroIds) alreadyGrouped.add(id);
      } catch (e) {
        if (
          e instanceof MiroAuthError ||
          e instanceof MiroNotFoundError ||
          e instanceof MiroRateLimitError
        ) {
          passCError = `pass-c: ${(e as Error).message}`;
          break;
        }
        const msg = `pass-c group(${f.id}): ${(e as Error).message}`;
        passCError = passCError ? `${passCError}; ${msg}` : msg;
      }
    }
    if (groupMappings.length > 0) {
      commitBoardGroupExport(p.room, { boardId: p.boardId, groupMappings });
      p.onCommit?.(p.room);
    }
  }

  const combinedError = [runError, passBError, passCError].filter((e): e is string => Boolean(e)).join(" | ") || undefined;

  return {
    itemsCreated: frameMap.size + itemMap.size,
    connectorsCreated: connectorMappings.length,
    skipped,
    error: combinedError,
  };
}
