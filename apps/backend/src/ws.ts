import type { StoreChangeBatch } from "./store-types";
import type { AiActivity, Prompt, StoreChangeBus, WsMessage } from "./types";
import { ActiveRoomsTracker } from "./ws/active-rooms";

export type Sock = { send: (data: string) => void; readyState: number };
const OPEN = 1;

const IMPORT_MERMAID_TIMEOUT_MS = 10_000;

export type ImportMermaidResult = {
  ok: boolean;
  shape_ids?: string[];
  didraw_names?: string[];
  root_ids?: string[];
  error?: string;
};

export class WsHub implements StoreChangeBus {
  private rooms = new Map<string, Set<Sock>>();
  private readonly _activeRooms = new ActiveRoomsTracker();
  /** Pending import-mermaid requests awaiting frontend result. */
  private pendingImports = new Map<string, {
    resolve: (result: ImportMermaidResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  attach(room: string, sock: Sock) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    // biome-ignore lint/style/noNonNullAssertion: just-checked-with-has
    this.rooms.get(room)!.add(sock);
  }
  detach(room: string, sock: Sock) {
    const set = this.rooms.get(room);
    if (!set) return;
    set.delete(sock);
    if (set.size === 0) this.rooms.delete(room);
  }

  getActiveRooms(): ActiveRoomsTracker {
    return this._activeRooms;
  }

  publish(
    room: string,
    msg: {
      changes: StoreChangeBatch;
      source: "ai" | "user";
      version: number;
      originClientId?: string;
    },
  ) {
    this.broadcast(room, { kind: "store-change", ...msg });
  }
  publishPrompt(room: string, prompt: Prompt) {
    this.broadcast(room, { kind: "prompt-created", prompt });
  }
  publishPromptResolved(room: string, id: string, response?: string) {
    this.broadcast(room, { kind: "prompt-resolved", id, response });
  }
  publishPromptRemoved(room: string, ids: string[]) {
    this.broadcast(room, { kind: "prompt-removed", ids });
  }
  publishAiActivity(room: string, activity: AiActivity | null) {
    this.broadcast(room, { kind: "ai-activity", activity });
  }

  /**
   * Returns the number of open WS connections in the room.
   * Used by the import-mermaid endpoint to check if a browser tab is connected.
   */
  subscriberCount(room: string): number {
    const set = this.rooms.get(room);
    if (!set) return 0;
    let count = 0;
    for (const s of set) if (s.readyState === OPEN) count++;
    return count;
  }

  /**
   * Send an import-mermaid command to the first open subscriber in the room.
   * Returns a Promise that resolves with the frontend result or rejects on timeout.
   * Caller must check subscriberCount() > 0 first.
   *
   * Append-only by design (DRW-083): no mode parameter — frontend always
   * appends. AI must never wipe existing canvas state.
   */
  sendImportMermaid(
    room: string,
    requestId: string,
    source: string,
  ): Promise<ImportMermaidResult> {
    return new Promise<ImportMermaidResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingImports.delete(requestId);
        reject(new Error("client did not respond"));
      }, IMPORT_MERMAID_TIMEOUT_MS);

      this.pendingImports.set(requestId, { resolve, reject, timer });

      // Send to first open subscriber (simple: first from iterator)
      const set = this.rooms.get(room);
      if (!set) {
        clearTimeout(timer);
        this.pendingImports.delete(requestId);
        reject(new Error("no client connected"));
        return;
      }
      let sent = false;
      for (const s of set) {
        if (s.readyState === OPEN) {
          s.send(JSON.stringify({ kind: "import-mermaid", source, requestId }));
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

  private broadcast(room: string, msg: WsMessage) {
    const set = this.rooms.get(room);
    if (!set) return;
    const data = JSON.stringify(msg);
    for (const s of set) if (s.readyState === OPEN) s.send(data);
  }
}
