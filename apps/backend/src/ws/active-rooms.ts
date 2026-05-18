export type ActiveRoomEntry = {
  room: string;
  clientCount: number;
  lastFocusedAt: number;
};

type Internal = {
  clients: Set<string>;
  lastFocusedAt: number;
};

export type ActiveRoomsOpts = {
  idleTimeoutMs?: number;       // default 30_000
  now?: () => number;           // injectable clock for tests
};

export class ActiveRoomsTracker {
  private rooms = new Map<string, Internal>();
  private clientToRoom = new Map<string, string>(); // client → currently-focused room
  /**
   * v1: removal is immediate on the last client's disconnect/blur.
   * Spec §17.2 specifies a 30s idle grace window for stale entries
   * (browser crash / network drop with no WS close event). §15 OQ11
   * classifies the immediate-removal gap as acceptable for v1.
   * `idleTimeoutMs` is reserved for the future implementation.
   *
   * TODO: implement a real idle-timeout sweep using `idleTimeoutMs` so that
   * entries for crashed/disconnected clients age out gracefully.
   */
  private readonly idleTimeoutMs: number;
  private readonly nowFn: () => number;

  constructor(opts: ActiveRoomsOpts = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  onFocus(room: string, clientId: string): void {
    // Если client был focused на другой room — сначала blur её.
    const prev = this.clientToRoom.get(clientId);
    if (prev !== undefined && prev !== room) {
      this.removeClient(prev, clientId);
    }
    let entry = this.rooms.get(room);
    if (!entry) {
      entry = { clients: new Set(), lastFocusedAt: this.nowFn() };
      this.rooms.set(room, entry);
    }
    entry.clients.add(clientId);
    entry.lastFocusedAt = this.nowFn();
    this.clientToRoom.set(clientId, room);
  }

  onBlur(room: string, clientId: string): void {
    this.removeClient(room, clientId);
    if (this.clientToRoom.get(clientId) === room) {
      this.clientToRoom.delete(clientId);
    }
  }

  /** WS disconnect — blur по всем room'ам, на которых client был focused. */
  onDisconnect(clientId: string): void {
    const room = this.clientToRoom.get(clientId);
    if (room !== undefined) {
      this.removeClient(room, clientId);
      this.clientToRoom.delete(clientId);
    }
  }

  list(): ActiveRoomEntry[] {
    return [...this.rooms.entries()]
      .map(([room, e]) => ({
        room,
        clientCount: e.clients.size,
        lastFocusedAt: e.lastFocusedAt,
      }))
      .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt);
  }

  /** No-op в v1 (idle timeout будет нужен только если появятся stale entries без disconnect). */
  stop(): void {
    this.rooms.clear();
    this.clientToRoom.clear();
  }

  private removeClient(room: string, clientId: string): void {
    const entry = this.rooms.get(room);
    if (!entry) return;
    entry.clients.delete(clientId);
    if (entry.clients.size === 0) {
      this.rooms.delete(room);
    }
  }
}
