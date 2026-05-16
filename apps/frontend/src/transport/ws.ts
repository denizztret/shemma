import type { Editor, RecordsDiff, TLRecord } from "tldraw";

// `room` was previously imported from `./api`, but that module reads
// `location.search` at top-level which crashes under non-browser test
// runners (bun:test). Inline a lazy reader so this module stays
// import-safe outside the browser; callers from the browser still see
// the same `room` value as the rest of the app.
function legacyRoom(): string {
  if (typeof location === "undefined") return "default";
  return new URLSearchParams(location.search).get("room") ?? "default";
}

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
 * a `didraw:ws-message` window event so transport stays decoupled.
 */
export function startStoreSync(deps: StoreSyncDeps): { stop: () => void } {
  const debounceMs = deps.debounceMs ?? 50;
  const clientOpId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let currentVersion = deps.initialVersion;
  let stopped = false;

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
    ws.send(
      JSON.stringify({ kind: "hello", lastVersion: currentVersion }),
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
            new CustomEvent("didraw:ws-message", { detail: msg }),
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
  };
}

export type PatchFrame = {
  kind: "patch";
  source: "ai" | "user";
  // biome-ignore lint/suspicious/noExplicitAny: patch ops are opaque backend schema
  ops: any[];
  version: number;
  originClientId?: string;
};

export type OpLogEntry = {
  // biome-ignore lint/suspicious/noExplicitAny: patch ops are opaque backend schema
  ops: any[];
  source: "ai" | "user";
  version: number;
  at: number;
  clientOpId?: string;
};

export type WsMessage =
  | { kind: "hello"; version: number } // legacy initial frame
  | { kind: "sync-ack"; version: number }
  | { kind: "replay"; ops: OpLogEntry[]; version: number }
  | { kind: "truncated"; version: number }
  | PatchFrame
  // biome-ignore lint/suspicious/noExplicitAny: prompt schema is opaque backend type
  | { kind: "prompt-created"; prompt: any }
  | { kind: "prompt-resolved"; id: string; response?: string }
  | { kind: "prompt-removed"; ids: string[] }
  | { kind: "ai-activity"; activity: AiActivity | null };

export function openWs(
  handlers: {
    onPatch?: (m: PatchFrame) => void;
    // biome-ignore lint/suspicious/noExplicitAny: prompt message passed through opaquely
    onPromptCreated?: (m: any) => void;
    // biome-ignore lint/suspicious/noExplicitAny: prompt-resolved message passed through opaquely
    onPromptResolved?: (m: any) => void;
    onPromptRemoved?: (ids: string[]) => void;
    onAiActivity?: (activity: AiActivity | null) => void;
    // Called when the server reports the client is too far behind to replay.
    // Implementation should re-fetch full state and replace canvas contents.
    onTruncated?: () => void;
  },
  // Seed the high-water-mark from the initial GET /api/state.version so the
  // first `hello` frame reports our actual baseline (spec §4.1). Without this
  // a reconnect to a non-fresh room would request replay-from-0 and re-apply
  // ops for shapes the initial state already created → duplicate-id errors.
  options: { initialLastVersion?: number } = {},
) {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;
  // Tracks the highest room version this client has observed. Sent in the
  // `hello` frame on each (re)connect so the server can decide between
  // sync-ack / replay / truncated.
  let lastReceivedVersion = options.initialLastVersion ?? 0;
  const dispatchEntry = (entry: OpLogEntry) => {
    handlers.onPatch?.({
      kind: "patch",
      source: entry.source,
      ops: entry.ops,
      version: entry.version,
      // Replay entries carry clientOpId (server's view) — surface it as
      // originClientId so the echo-guard suppresses our own re-applied ops.
      originClientId: entry.clientOpId,
    });
  };
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(
      `ws://${location.host}/ws?room=${encodeURIComponent(legacyRoom())}`,
    );
    ws.onopen = () => {
      attempt = 0;
      ws?.send(JSON.stringify({ kind: "hello", lastVersion: lastReceivedVersion }));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as WsMessage;
      // Track high-water-mark version for any frame that carries one (except
      // the legacy initial `hello`, which is intentionally ignored — initial
      // state already came through GET /api/state on App mount).
      if (
        m.kind !== "hello" &&
        "version" in m &&
        m.version > lastReceivedVersion
      ) {
        lastReceivedVersion = m.version;
      }
      switch (m.kind) {
        case "patch":
          handlers.onPatch?.(m);
          break;
        case "replay":
          for (const entry of m.ops) dispatchEntry(entry);
          break;
        case "truncated":
          handlers.onTruncated?.();
          break;
        case "prompt-created":
          handlers.onPromptCreated?.(m);
          break;
        case "prompt-resolved":
          handlers.onPromptResolved?.(m);
          break;
        case "prompt-removed":
          handlers.onPromptRemoved?.(m.ids);
          break;
        case "ai-activity":
          handlers.onAiActivity?.(m.activity);
          break;
        // "sync-ack" and legacy "hello": no handler side-effect beyond the
        // version-tracking above.
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      const d = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
      attempt++;
      setTimeout(connect, d);
    };
    ws.onerror = () => ws?.close();
  };
  connect();
  return () => {
    stopped = true;
    ws?.close();
  };
}
