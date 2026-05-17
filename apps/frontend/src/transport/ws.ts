import type { Editor, RecordsDiff, TLRecord } from "tldraw";

export type AiActivity = {
  actor: string;
  task: string;
  startedAt: number;
};

// ---------------------------------------------------------------------------
// Phase 3.0 store-sync (Task 13). Mirrors backend's StoreChangeBatch verbatim:
//   added/removed: Record<id, Record>
//   updated: Record<id, [from, to]>
// Identical to tldraw's RecordsDiff<TLRecord> — helpers are identity-shaped but
// kept as named exports so unit tests can target the seam.
// ---------------------------------------------------------------------------

export type StoreChangeBatch = {
  added: Record<string, TLRecord>;
  updated: Record<string, [TLRecord, TLRecord]>;
  removed: Record<string, TLRecord>;
};

export type TLStoreDiff = RecordsDiff<TLRecord>;

export function batchToDiff(batch: StoreChangeBatch): TLStoreDiff {
  // Shape match: StoreChangeBatch ≡ RecordsDiff<TLRecord>. Cast (no clone) —
  // mergeRemoteChanges() snapshots its argument internally, so aliasing is safe.
  return batch as unknown as TLStoreDiff;
}

export function diffToBatch(diff: TLStoreDiff): StoreChangeBatch {
  return diff as unknown as StoreChangeBatch;
}

function batchIsEmpty(b: StoreChangeBatch): boolean {
  return (
    Object.keys(b.added).length === 0 &&
    Object.keys(b.updated).length === 0 &&
    Object.keys(b.removed).length === 0
  );
}

function mergeBatch(into: StoreChangeBatch, next: StoreChangeBatch): void {
  // Naïve coalescer: later wins. Sufficient for the 50ms debounce window —
  // tldraw never replays a stale tuple within a single user gesture.
  for (const id in next.added) into.added[id] = next.added[id]!;
  for (const id in next.updated) {
    const pair = next.updated[id]!;
    const prior = into.updated[id];
    // Preserve the original "from" if we've seen this id earlier in the window
    // so the server gets a single [from, latest-to] entry, not a fragmented chain.
    into.updated[id] = prior ? [prior[0], pair[1]] : pair;
  }
  for (const id in next.removed) into.removed[id] = next.removed[id]!;
}

type StoreSyncMessage =
  | { kind: "hello"; version: number }
  | { kind: "sync-ack"; version: number }
  | {
      kind: "replay";
      changes: StoreChangeBatch[];
      version: number;
    }
  | { kind: "truncated"; version: number }
  | {
      kind: "store-change";
      source: "ai" | "user";
      changes: StoreChangeBatch;
      version: number;
      originClientId?: string;
    }
  | { kind: "prompt-created"; prompt: unknown }
  | { kind: "prompt-resolved"; id: string; response?: string }
  | { kind: "prompt-removed"; ids: string[] }
  | { kind: "ai-activity"; activity: AiActivity | null };

export type StoreSyncDeps = {
  editor: Editor;
  wsUrl: string;
  initialVersion: number;
  /**
   * Called when the server reports the client is too far behind to replay.
   * Caller is expected to re-fetch `/api/state` and reload the snapshot;
   * this transport stops processing further frames after the call.
   */
  onTruncated: () => void;
  /**
   * Debounce window for outgoing user-change batches (ms). Default 50ms —
   * coalesces a single mouse-drag into one frame without noticeable latency.
   * Exposed for tests.
   */
  debounceMs?: number;
  /**
   * Injectable WebSocket factory — tests can pass a mock socket here.
   * Defaults to the global `WebSocket`.
   */
  socketFactory?: (url: string) => WebSocket;
};

/**
 * Start the WS store-change sync loop.
 *
 * Outbound: user-driven document changes from `editor.store.listen` are
 * debounced (50ms) into a single `user-change` frame stamped with our
 * `clientOpId`.
 *
 * Inbound: `store-change` frames are applied via `mergeRemoteChanges` →
 * `applyDiff` so the listener does NOT re-fire (avoids feedback). Frames whose
 * `originClientId` matches our `clientOpId` are dropped (echo-guard).
 *
 * Non-store frames (prompt-*, ai-activity) are forwarded to chrome layers via
 * a `shemma:ws-message` window event so transport stays decoupled.
 *
 * DRW-018 — pause gate:
 *   `setPaused(true)` causes inbound `replay` / `store-change` frames to be
 *   dropped instead of applied to `editor.store`. Used by App.tsx during the
 *   `truncated → seedSchema → getState → loadSnapshot` recovery window to
 *   prevent stale-baseline diffs from flickering between the truncated
 *   detection and the fresh full snapshot.
 *
 *   Outbound `user-change` flow stays ENABLED while paused: the user may keep
 *   drawing during recovery, and those mutations are real new state that the
 *   server's fresh snapshot does not contain. They get flushed by the new
 *   syncer instance once recovery completes. (Note: any mutations queued in
 *   THIS syncer's `pending` at `stop()` time are dropped — pending is local
 *   to each syncer instance. This pre-dates DRW-018.)
 */
export function startStoreSync(
  deps: StoreSyncDeps,
): { stop: () => void; setPaused: (p: boolean) => void } {
  const debounceMs = deps.debounceMs ?? 50;
  const clientOpId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let currentVersion = deps.initialVersion;
  let stopped = false;
  let paused = false;

  const factory = deps.socketFactory ?? ((url: string) => new WebSocket(url));
  const ws = factory(deps.wsUrl);

  const pending: StoreChangeBatch = {
    added: {},
    updated: {},
    removed: {},
  };
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushPending = () => {
    flushTimer = null;
    if (stopped) return;
    if (batchIsEmpty(pending)) return;
    if (ws.readyState !== ws.OPEN) return;
    const changes: StoreChangeBatch = {
      added: { ...pending.added },
      updated: { ...pending.updated },
      removed: { ...pending.removed },
    };
    // Reset before send so listener events during ws.send don't get lost.
    pending.added = {};
    pending.updated = {};
    pending.removed = {};
    ws.send(JSON.stringify({ kind: "user-change", changes, clientOpId }));
  };

  // Subscribe to local user-driven document changes. Filter is critical:
  // mergeRemoteChanges() marks applied diffs with source='remote', so this
  // listener naturally ignores echo without an explicit guard.
  const unlisten = deps.editor.store.listen(
    (entry) => {
      if (stopped) return;
      mergeBatch(pending, entry.changes as unknown as StoreChangeBatch);
      if (flushTimer === null) {
        flushTimer = setTimeout(flushPending, debounceMs);
      }
    },
    { source: "user", scope: "document" },
  );

  ws.addEventListener("open", () => {
    if (stopped) return;
    // Include the editor's current schema so the backend can persist it on
    // first connect (replacing the V1 placeholder from defaultSchema()).
    // Serialising is cheap (≤2KB, called only on WS open/reconnect).
    const schema = deps.editor.store.schema.serialize();
    ws.send(
      JSON.stringify({ kind: "hello", lastVersion: currentVersion, schema }),
    );
  });

  ws.addEventListener("message", (e: MessageEvent) => {
    if (stopped) return;
    let msg: StoreSyncMessage;
    try {
      msg = JSON.parse(String(e.data)) as StoreSyncMessage;
    } catch {
      return;
    }
    switch (msg.kind) {
      case "sync-ack":
        if (msg.version > currentVersion) currentVersion = msg.version;
        break;
      case "replay":
        if (paused) {
          // DRW-018: stale-baseline gate — drop the batch entirely. We don't
          // advance currentVersion either: the caller will tear this syncer
          // down and restart with fresh /api/state version anyway.
          console.debug(
            "[shemma] dropping inbound 'replay' while paused (recovery)",
          );
          break;
        }
        deps.editor.store.mergeRemoteChanges(() => {
          for (const batch of msg.changes) {
            deps.editor.store.applyDiff(batchToDiff(batch));
          }
        });
        if (msg.version > currentVersion) currentVersion = msg.version;
        break;
      case "truncated":
        stopped = true;
        deps.onTruncated();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        break;
      case "store-change":
        if (msg.originClientId === clientOpId) {
          // Echo of our own user-change — version still advances.
          if (msg.version > currentVersion) currentVersion = msg.version;
          break;
        }
        if (paused) {
          // DRW-018: see 'replay' case. The recovery snapshot will subsume
          // this change (it's already in the server's authoritative state),
          // applying it now against the stale store would just flicker.
          console.debug(
            "[shemma] dropping inbound 'store-change' while paused (recovery)",
          );
          break;
        }
        deps.editor.store.mergeRemoteChanges(() => {
          deps.editor.store.applyDiff(batchToDiff(msg.changes));
        });
        if (msg.version > currentVersion) currentVersion = msg.version;
        break;
      case "hello":
        // Legacy initial frame — no action; initial state already loaded.
        break;
      case "prompt-created":
      case "prompt-resolved":
      case "prompt-removed":
      case "ai-activity":
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("shemma:ws-message", { detail: msg }),
          );
        }
        break;
    }
  });

  return {
    stop() {
      stopped = true;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      unlisten();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
    setPaused(p: boolean) {
      paused = p;
    },
  };
}

