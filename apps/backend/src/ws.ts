import type { StoreChangeBatch } from "./store-types";
import type { AiActivity, Prompt, StoreChangeBus, WsMessage } from "./types";
import { ActiveRoomsTracker, LEGACY_SPACE_ID } from "./ws/active-rooms";

export type Sock = { send: (data: string) => void; readyState: number };
const OPEN = 1;

const IMPORT_MERMAID_TIMEOUT_MS = 10_000;
const FIT_TEXT_TIMEOUT_MS = 10_000;

export type ImportMermaidResult = {
  ok: boolean;
  shape_ids?: string[];
  didraw_names?: string[];
  root_ids?: string[];
  error?: string;
};

// DRW-228: result of a frontend fit-text command.
export type FitTextResult = {
  ok: boolean;
  count?: number;
  shape_ids?: string[];
  error?: string;
};

/**
 * Composite subscription key: `${spaceId}\x00${roomId}`.
 *
 * Using `\x00` (NUL) as the separator keeps the key collision-free vs. any
 * legal space/room id — `SPACE_ID_PATTERN` and `ROOM_ID_PATTERN` both forbid
 * control chars, so no legitimate input can pretend to be a different key.
 */
function compositeKey(space: string, room: string): string {
  return `${space}\x00${room}`;
}

/**
 * WebSocket pub/sub hub.
 *
 * DRW-116 Task 12: every subscriber set is scoped by `(spaceId, roomId)`.
 * Two WS connections to the same `roomId` in different spaces are isolated —
 * publishes never cross the space boundary. Legacy callers (pre-Task-12 WS
 * handshake that doesn't pass `?space=`) land in the synthesized
 * `LEGACY_SPACE_ID` bucket, preserving the pre-multi-space single-bundle
 * semantics that older tests assert against.
 */
export class WsHub implements StoreChangeBus {
  /** Composite-key map: `${space}\x00${room}` → set of sockets. */
  private subs = new Map<string, Set<Sock>>();
  private readonly _activeRooms = new ActiveRoomsTracker();
  /** Pending import-mermaid requests awaiting frontend result. */
  private pendingImports = new Map<string, {
    resolve: (result: ImportMermaidResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** DRW-228: pending fit-text requests awaiting frontend result. */
  private pendingFits = new Map<string, {
    resolve: (result: FitTextResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  attach(space: string, room: string, sock: Sock) {
    const key = compositeKey(space, room);
    let set = this.subs.get(key);
    if (!set) {
      set = new Set();
      this.subs.set(key, set);
    }
    set.add(sock);
  }
  detach(space: string, room: string, sock: Sock) {
    const key = compositeKey(space, room);
    const set = this.subs.get(key);
    if (!set) return;
    set.delete(sock);
    if (set.size === 0) this.subs.delete(key);
  }

  getActiveRooms(): ActiveRoomsTracker {
    return this._activeRooms;
  }

  publish(
    space: string,
    room: string,
    msg: {
      changes: StoreChangeBatch;
      source: "ai" | "user";
      version: number;
      originClientId?: string;
      /** DRW-149: layout-selection broadcasts carry this flag so the frontend
       * routes through markHistoryStoppingPoint + editor.run for Cmd+Z support. */
      layoutAction?: true;
    },
  ) {
    this.broadcast(space, room, { kind: "store-change", ...msg });
  }
  publishPrompt(space: string, room: string, prompt: Prompt) {
    this.broadcast(space, room, { kind: "prompt-created", prompt });
  }
  publishPromptResolved(
    space: string,
    room: string,
    id: string,
    response?: string,
  ) {
    this.broadcast(space, room, { kind: "prompt-resolved", id, response });
  }
  publishPromptRemoved(space: string, room: string, ids: string[]) {
    this.broadcast(space, room, { kind: "prompt-removed", ids });
  }
  publishAiActivity(
    space: string,
    room: string,
    activity: AiActivity | null,
  ) {
    this.broadcast(space, room, { kind: "ai-activity", activity });
  }

  /**
   * Returns the number of open WS connections in `(space, room)`.
   * Used by the import-mermaid endpoint to check if a browser tab is connected.
   */
  subscriberCount(space: string, room: string): number {
    const set = this.subs.get(compositeKey(space, room));
    if (!set) return 0;
    let count = 0;
    for (const s of set) if (s.readyState === OPEN) count++;
    return count;
  }

  /**
   * Send an import-mermaid command to the first open subscriber in
   * `(space, room)`. Returns a Promise that resolves with the frontend result
   * or rejects on timeout. Caller must check `subscriberCount() > 0` first.
   *
   * Append-only by design (DRW-083): no mode parameter — frontend always
   * appends. AI must never wipe existing canvas state.
   */
  sendImportMermaid(
    space: string,
    room: string,
    requestId: string,
    source: string,
    focus?: "new" | "fit-all" | "none",
  ): Promise<ImportMermaidResult> {
    return new Promise<ImportMermaidResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingImports.delete(requestId);
        reject(new Error("client did not respond"));
      }, IMPORT_MERMAID_TIMEOUT_MS);

      this.pendingImports.set(requestId, { resolve, reject, timer });

      // Send to first open subscriber (simple: first from iterator).
      const set = this.subs.get(compositeKey(space, room));
      if (!set) {
        clearTimeout(timer);
        this.pendingImports.delete(requestId);
        reject(new Error("no client connected"));
        return;
      }
      let sent = false;
      for (const s of set) {
        if (s.readyState === OPEN) {
          // DRW-086: include focus only when explicitly provided (omit to preserve
          // backward-compat: frontend defaults to "new" when field absent).
          const frame: { kind: string; source: string; requestId: string; focus?: string } = {
            kind: "import-mermaid",
            source,
            requestId,
          };
          if (focus !== undefined) frame.focus = focus;
          s.send(JSON.stringify(frame));
          sent = true;
          break;
        }
      }
      if (!sent) {
        clearTimeout(timer);
        this.pendingImports.delete(requestId);
        reject(new Error("no client connected"));
      }
    });
  }

  /**
   * Called by the WS message handler when it receives an import-mermaid-result
   * frame from a client. Resolves the pending Promise.
   */
  resolveImportMermaid(requestId: string, result: ImportMermaidResult): void {
    const pending = this.pendingImports.get(requestId);
    if (!pending) return; // already timed out — ignore
    clearTimeout(pending.timer);
    this.pendingImports.delete(requestId);
    pending.resolve(result);
  }

  /**
   * DRW-228: send a fit-text command to the first open subscriber in
   * `(space, room)`. Returns a Promise that resolves with the frontend result
   * or rejects on timeout / no client. Caller checks `subscriberCount() > 0`
   * first so a clean 503 with room_url can be surfaced.
   *
   * `targets` (shape ids or didrawNames) limits the fit scope; omitted → all
   * fittable geo/note shapes that the user has not size-pinned.
   */
  sendFitText(
    space: string,
    room: string,
    requestId: string,
    targets?: string[],
  ): Promise<FitTextResult> {
    return new Promise<FitTextResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFits.delete(requestId);
        reject(new Error("client did not respond"));
      }, FIT_TEXT_TIMEOUT_MS);

      this.pendingFits.set(requestId, { resolve, reject, timer });

      const set = this.subs.get(compositeKey(space, room));
      if (!set) {
        clearTimeout(timer);
        this.pendingFits.delete(requestId);
        reject(new Error("no client connected"));
        return;
      }
      let sent = false;
      for (const s of set) {
        if (s.readyState === OPEN) {
          const frame: { kind: string; requestId: string; targets?: string[] } = {
            kind: "fit-text",
            requestId,
          };
          if (targets !== undefined) frame.targets = targets;
          s.send(JSON.stringify(frame));
          sent = true;
          break;
        }
      }
      if (!sent) {
        clearTimeout(timer);
        this.pendingFits.delete(requestId);
        reject(new Error("no client connected"));
      }
    });
  }

  /**
   * DRW-228: resolve a pending fit-text request when the client replies.
   */
  resolveFitText(requestId: string, result: FitTextResult): void {
    const pending = this.pendingFits.get(requestId);
    if (!pending) return; // already timed out — ignore
    clearTimeout(pending.timer);
    this.pendingFits.delete(requestId);
    pending.resolve(result);
  }

  private broadcast(space: string, room: string, msg: WsMessage) {
    const set = this.subs.get(compositeKey(space, room));
    if (!set) return;
    const data = JSON.stringify(msg);
    for (const s of set) if (s.readyState === OPEN) s.send(data);
  }
}

// Re-export so callers can refer to the legacy sentinel via `./ws` without
// reaching into the internal `./ws/active-rooms` module.
export { LEGACY_SPACE_ID };
