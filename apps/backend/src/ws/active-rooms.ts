export type ActiveRoomEntry = {
  /**
   * DRW-116 Task 11: spaceId is included on every entry so multi-space
   * daemons can disambiguate two rooms that share the same `roomId` across
   * different spaces. Legacy single-space callers (still the production path
   * until WS plumbing wires per-connection space) receive the synthesized
   * `LEGACY_SPACE_ID` here.
   */
  space: string;
  room: string;
  clientCount: number;
  lastFocusedAt: number;
};

type Internal = {
  space: string;
  room: string;
  clients: Set<string>;
  lastFocusedAt: number;
};

export type ActiveRoomsOpts = {
  idleTimeoutMs?: number;       // default 30_000
  now?: () => number;           // injectable clock for tests
};

/**
 * Synthetic space id used when callers don't supply one (legacy WS plumbing
 * predating DRW-116 Task 11). Double-underscore wrapped so it cannot collide
 * with any real space id — `SPACE_ID_PATTERN` (`/^[a-z0-9][a-z0-9-]{0,62}$/`)
 * forbids underscores, so `__legacy__` is physically unreachable through the
 * `/api/spaces` registry path.
 */
export const LEGACY_SPACE_ID = "__legacy__";

function compositeKey(space: string, room: string): string {
  return `${space}\x00${room}`;
}

export class ActiveRoomsTracker {
  /** Composite-key map: `${space}\x00${room}` → entry. */
  private rooms = new Map<string, Internal>();
  /** client → composite key of currently-focused (space, room). */
  private clientToKey = new Map<string, string>();
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

  /**
   * Mark `clientId` as focused on `(space, room)`. The `space` argument is
   * optional — pre-Task-11 callers pass only `(room, clientId)` and get the
   * synthesized `LEGACY_SPACE_ID` bucket, preserving single-space semantics.
   */
  onFocus(
    room: string,
    clientId: string,
    space: string = LEGACY_SPACE_ID,
  ): void {
    const key = compositeKey(space, room);
    // Если client был focused на другую (space, room) — сначала blur её.
    const prevKey = this.clientToKey.get(clientId);
    if (prevKey !== undefined && prevKey !== key) {
      this.removeClient(prevKey, clientId);
    }
    let entry = this.rooms.get(key);
    if (!entry) {
      entry = {
        space,
        room,
        clients: new Set(),
        lastFocusedAt: this.nowFn(),
      };
      this.rooms.set(key, entry);
    }
    entry.clients.add(clientId);
    entry.lastFocusedAt = this.nowFn();
    this.clientToKey.set(clientId, key);
  }

  onBlur(
    room: string,
    clientId: string,
    space: string = LEGACY_SPACE_ID,
  ): void {
    const key = compositeKey(space, room);
    this.removeClient(key, clientId);
    if (this.clientToKey.get(clientId) === key) {
      this.clientToKey.delete(clientId);
    }
  }

  /** WS disconnect — blur по composite (space, room), на которой client был focused. */
  onDisconnect(clientId: string): void {
    const key = this.clientToKey.get(clientId);
    if (key !== undefined) {
      this.removeClient(key, clientId);
      this.clientToKey.delete(clientId);
    }
  }

  /**
   * List active (space, room) pairs sorted by `lastFocusedAt` desc.
   *
   * Optional `opts.space` filters to a single space — used by the
   * `/api/active-rooms?space=<id>` query so a UI can show only its own
   * gallery without leaking cross-space presence.
   */
  list(opts: { space?: string } = {}): ActiveRoomEntry[] {
    const filter = opts.space;
    const out: ActiveRoomEntry[] = [];
    for (const e of this.rooms.values()) {
      if (filter !== undefined && e.space !== filter) continue;
      out.push({
        space: e.space,
        room: e.room,
        clientCount: e.clients.size,
        lastFocusedAt: e.lastFocusedAt,
      });
    }
    return out.sort((a, b) => b.lastFocusedAt - a.lastFocusedAt);
  }

  /** No-op в v1 (idle timeout будет нужен только если появятся stale entries без disconnect). */
  stop(): void {
    this.rooms.clear();
    this.clientToKey.clear();
  }

  private removeClient(key: string, clientId: string): void {
    const entry = this.rooms.get(key);
    if (!entry) return;
    entry.clients.delete(clientId);
    if (entry.clients.size === 0) {
      this.rooms.delete(key);
    }
  }
}
