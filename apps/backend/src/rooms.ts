import type { CanvasState, RoomId, RoomState } from "./types";

export type RoomStore = {
  load: (id: RoomId) => Promise<RoomState | null>;
  save: (id: RoomId, state: RoomState) => Promise<void>;
};

export function emptyCanvasState(): CanvasState {
  return { version: 1, nodes: [], edges: [], groups: [] };
}

export function makeRoomState(): RoomState {
  return {
    canvas: emptyCanvasState(),
    opLog: [],
    prompts: [],
    version: 0,
    dirty: false,
    lastTouched: Date.now(),
  };
}

export class Rooms {
  private map = new Map<RoomId, RoomState>();
  private loading = new Map<RoomId, Promise<RoomState>>();
  constructor(private store: RoomStore) {}

  async get(id: RoomId): Promise<RoomState> {
    const existing = this.map.get(id);
    if (existing) {
      existing.lastTouched = Date.now();
      return existing;
    }
    const pending = this.loading.get(id);
    if (pending) return pending;
    const p = (async () => {
      try {
        const loaded = await this.store.load(id);
        const s = loaded ?? makeRoomState();
        this.map.set(id, s);
        return s;
      } finally {
        this.loading.delete(id);
      }
    })();
    this.loading.set(id, p);
    return p;
  }

  touch(id: RoomId) {
    const s = this.map.get(id);
    if (s) s.lastTouched = Date.now();
  }
  has(id: RoomId) {
    return this.map.has(id);
  }
  ids() {
    return [...this.map.keys()];
  }

  async evictIdle(maxIdleMs: number): Promise<number> {
    const cutoff = Date.now() - maxIdleMs;
    const evicted: Array<[RoomId, RoomState]> = [];
    for (const [id, s] of this.map) {
      if (s.lastTouched < cutoff) {
        this.map.delete(id);
        evicted.push([id, s]);
      }
    }
    await Promise.all(
      evicted
        .filter(([, s]) => s.dirty)
        .map(([id, s]) => this.store.save(id, s)),
    );
    return evicted.length;
  }
}
