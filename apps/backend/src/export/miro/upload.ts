// apps/backend/src/export/miro/upload.ts
//
// DRW-103: three-phase upload orchestrator.
// Pass A1 (frames only) → frameMap → Pass A2 (non-frame items with parent.id)
// → passAMap → Pass B (connectors). Tracking committed after each pass for
// partial-commit semantics (see §6).

import type { RoomState } from "../../types";
import {
  buildConnectorPayload,
  buildFramePayload,
  buildShapePayload,
  buildStickyNotePayload,
  buildTextPayload,
  expandGroups,
  type TrackingField,
} from "./builder";
import { MiroAuthError, MiroNotFoundError, MiroRateLimitError } from "./client";
import type { MiroBulkItem, MiroClient, MiroConnectorPayload } from "./client";
import { computeCentroid, resolvePageBounds, type RawShape } from "./coords";
import { commitBoardExport } from "./tracking";

const BULK_CHUNK_SIZE = 50; // §6.2 conservative; refine after Task 1 probe
const CONNECTOR_CONCURRENCY = 10; // §6.4

export interface RunExportParams {
  client: MiroClient;
  room: RoomState;
  boardId: string;
  boardName?: string;
  /** Element ids selected for export. Groups will be expanded. */
  selection: string[];
  trackingField: TrackingField;
  shemmaRoom: string;
  shemmaVersion: string;
  /**
   * Called immediately after each `commitBoardExport` mutation (Pass A1
   * complete, every A2 chunk, Pass B aggregate). Routes wire this to
   * persistence flush so partial-committed tracking survives mid-flight
   * crashes / aborts (see §6 partial-commit semantics).
   */
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

/** Classify selection into frames / leaf-items / arrows + drop unsupported. */
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
      // Expanded by caller; if it leaked here — skip.
      continue;
    }
    // draw, line, image, video, highlight — explicitly unsupported (§5.2)
    unsupported.push(id);
  }
  return { frames, items, arrows, unsupported };
}

export async function runMiroExport(p: RunExportParams): Promise<RunExportResult> {
  const skipped: SkippedItem[] = [];
  const store = p.room.store.store as Record<string, RawShape>;

  // Step 1: expand groups → leaf list. Drops group itself.
  const expanded = expandGroups(p.selection, store);

  // Step 2: classify into frames / non-frame items / arrows.
  const { frames, items, arrows, unsupported } = classify(expanded, store);
  for (const u of unsupported) skipped.push({ elementId: u, reason: "unsupported-type" });

  // Step 3: resolve page-space bounds and compute centroid.
  const allBounds = [...frames, ...items, ...arrows]
    .map((id) => resolvePageBounds(id, store))
    .filter((b): b is NonNullable<typeof b> => b !== null);
  const centroid = computeCentroid(allBounds);

  // Helper to compute Miro position for a shape (centroid-translated).
  function miroPos(id: string): { x: number; y: number; w: number; h: number } | null {
    const b = resolvePageBounds(id, store);
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

  // ---- Pass A1: frames ----
  if (frames.length > 0) {
    const payload: Array<{ id: string; item: MiroBulkItem }> = frames
      .map((id) => {
        const s = store[id];
        const pos = miroPos(id);
        if (!s || !pos) return null;
        const item = buildFramePayload(s, {
          miroX: pos.x,
          miroY: pos.y,
          trackingField: p.trackingField,
          elementId: id,
          shemmaRoom: p.shemmaRoom,
          shemmaVersion: p.shemmaVersion,
        });
        // Frame geometry is set inside buildFramePayload from props.w/h, but
        // confirm width/height from resolved bounds (defensive).
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
      // Commit tracking after Pass A1.
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

  // ---- Pass A2: non-frame items ----
  if (items.length > 0) {
    const payload: Array<{ id: string; item: MiroBulkItem }> = items
      .map((id) => {
        const s = store[id];
        const pos = miroPos(id);
        if (!s || !pos) return null;

        // If parent is a frame in our A1 set, compute frame-relative position.
        const parentMiroId = s.parentId && frameMap.has(s.parentId)
          ? frameMap.get(s.parentId)
          : undefined;
        let miroX = pos.x;
        let miroY = pos.y;
        if (parentMiroId && s.parentId) {
          // Subtract parent's miro center from absolute centroid-translated coords.
          const parentPos = miroPos(s.parentId);
          if (parentPos) {
            miroX = pos.x - parentPos.x;
            miroY = pos.y - parentPos.y;
          }
        }
        const ctx = {
          miroX, miroY,
          parentMiroId,
          trackingField: p.trackingField,
          elementId: id,
          shemmaRoom: p.shemmaRoom,
          shemmaVersion: p.shemmaVersion,
        };
        let item: MiroBulkItem;
        if (s.type === "note") item = buildStickyNotePayload(s, ctx);
        else if (s.type === "text") item = buildTextPayload(s, ctx);
        else item = buildShapePayload(s, ctx);
        item.geometry = item.geometry ?? { width: pos.w, height: pos.h };
        return { id, item };
      })
      .filter((r): r is { id: string; item: MiroBulkItem } => r !== null);

    // Per-chunk error handling: validation errors (generic 4xx/422) → skip
    // entire chunk with reason="validation-error" and continue with the next.
    // Auth / not-found / rate-limit are fatal and abort the pass (consistent
    // with route-level error mapping in Task 11).
    const a2Errors: string[] = [];
    for (const ch of chunk(payload, BULK_CHUNK_SIZE)) {
      try {
        const resp = await p.client.bulkItems(p.boardId, ch.map((r) => r.item));
        ch.forEach((r, i) => {
          const got = resp.data[i]?.id;
          if (got) itemMap.set(r.id, got);
        });
        // Partial commit after each chunk.
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
        // Validation / other 4xx: skip whole chunk, continue with remaining.
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

  // ---- Pass B: connectors (throttled, per-item POST) ----
  const passAMap = new Map<string, string>();
  for (const [k, v] of frameMap) passAMap.set(k, v);
  for (const [k, v] of itemMap) passAMap.set(k, v);

  const connectorMappings: Array<{ elementId: string; miroConnectorId: string }> = [];

  // Build all payloads up-front; skip unbindable ones.
  const connectorTasks: Array<{ id: string; payload: MiroConnectorPayload }> = [];
  for (const id of arrows) {
    const s = store[id];
    if (!s) continue;
    const r = buildConnectorPayload(s, {
      store,
      passAMap,
      trackingField: p.trackingField,
      shemmaRoom: p.shemmaRoom,
      shemmaVersion: p.shemmaVersion,
    });
    if (r.kind === "skip") {
      skipped.push({ elementId: id, reason: r.reason });
      continue;
    }
    connectorTasks.push({ id, payload: r.payload });
  }

  // Throttle with simple semaphore loop.
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
  const combinedError = [runError, passBError].filter((e): e is string => Boolean(e)).join(" | ") || undefined;

  return {
    itemsCreated: frameMap.size + itemMap.size,
    connectorsCreated: connectorMappings.length,
    skipped,
    error: combinedError,
  };
}
