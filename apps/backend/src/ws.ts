import type { StoreChangeBatch } from "./store-types";
import type { AiActivity, Prompt, StoreChangeBus, WsMessage } from "./types";
import { ActiveRoomsTracker } from "./ws/active-rooms";

export type Sock = { send: (data: string) => void; readyState: number };
const OPEN = 1;

export class WsHub implements StoreChangeBus {
  private rooms = new Map<string, Set<Sock>>();
  private readonly _activeRooms = new ActiveRoomsTracker();

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

  private broadcast(room: string, msg: WsMessage) {
    const set = this.rooms.get(room);
    if (!set) return;
    const data = JSON.stringify(msg);
    for (const s of set) if (s.readyState === OPEN) s.send(data);
  }
}
