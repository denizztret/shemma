import type { PatchBus } from "./routes/patch";
import type { PatchOp, Prompt, WsMessage } from "./types";

type Sock = { send: (data: string) => void; readyState: number };
const OPEN = 1;

export class WsHub implements PatchBus {
  private rooms = new Map<string, Set<Sock>>();

  attach(room: string, sock: Sock) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    // biome-ignore lint/style/noNonNullAssertion: just-checked-with-has
    this.rooms.get(room)!.add(sock);
  }
  detach(room: string, sock: Sock) {
    this.rooms.get(room)?.delete(sock);
  }

  publish(
    room: string,
    msg: {
      ops: PatchOp[];
      source: "ai" | "user";
      version: number;
      originClientId?: string;
    },
  ) {
    this.broadcast(room, { kind: "patch", ...msg });
  }
  publishPrompt(room: string, prompt: Prompt) {
    this.broadcast(room, { kind: "prompt-created", prompt });
  }
  publishPromptResolved(room: string, id: string, response?: string) {
    this.broadcast(room, { kind: "prompt-resolved", id, response });
  }

  private broadcast(room: string, msg: WsMessage) {
    const set = this.rooms.get(room);
    if (!set) return;
    const data = JSON.stringify(msg);
    for (const s of set) if (s.readyState === OPEN) s.send(data);
  }
}
