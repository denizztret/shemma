import { room } from "./api";

export type AiActivity = {
  actor: string;
  task: string;
  startedAt: number;
};

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
      `ws://${location.host}/ws?room=${encodeURIComponent(room)}`,
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
