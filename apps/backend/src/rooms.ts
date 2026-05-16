import { defaultDocument, defaultPage, defaultSchema } from "./migrate-v2";
import type { FilePersistence } from "./persistence";
import type { TLStoreSnapshot } from "./store-types";
import type { RoomId, RoomState } from "./types";
import { DEFAULT_ROOM } from "./types";

const ROOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
// Stored viewport hints expire after this window of inactivity so a stale
// hint can't bias `/api/agent/context` long after the user has navigated away.
const VIEWPORT_TTL_MS = 30 * 60 * 1000;

export function validateRoomId(id: string): boolean {
  return ROOM_ID_RE.test(id);
}

export function resolveRoomId(
  raw: string | undefined,
):
  | { ok: true; id: string }
  | { ok: false; reason: string } {
  // Resolution chain per spec §2.1: explicit > URL > CLAUDE_SESSION_ID > default.
  const id = raw ?? process.env.CLAUDE_SESSION_ID ?? DEFAULT_ROOM;
  if (!validateRoomId(id)) {
    return {
      ok: false,
      reason: `invalid room id "${id}": expected /^[a-zA-Z0-9_-]{1,64}$/`,
    };
  }
  return { ok: true, id };
}

export type RoomStore = {
  load: (id: RoomId) => Promise<RoomState | null>;
  save: (id: RoomId, state: RoomState) => Promise<void>;
};

export function emptyTLStore(): TLStoreSnapshot {
  return {
    schema: defaultSchema() as TLStoreSnapshot["schema"],
    store: {
      "document:document": defaultDocument(),
      "page:page": defaultPage(),
    },
  };
}

export function makeRoomState(): RoomState {
  return {
    store: emptyTLStore(),
    opLog: [],
    prompts: [],
    version: 0,
    dirty: false,
    lastTouched: Date.now(),
    didrawIndex: new Map(),
  };
}

export class Rooms {
  private map = new Map<RoomId, RoomState>();
  private loading = new Map<RoomId, Promise<RoomState>>();
  private persistence?: FilePersistence;
  private viewports = new Map<string, { x: number; y: number; w: number; h: number; zoom?: number; at: number }>();

  constructor(private store: RoomStore) {}

  setViewport(id: string, vp: { x: number; y: number; w: number; h: number; zoom?: number }): void {
    this.viewports.set(id, { ...vp, at: Date.now() });
  }

  getViewport(id: string): { x: number; y: number; w: number; h: number; zoom?: number } | null {
    const v = this.viewports.get(id);
    if (!v) return null;
    if (Date.now() - v.at > VIEWPORT_TTL_MS) {
      this.viewports.delete(id);
      return null;
    }
    const { at, ...rest } = v;
    return rest;
  }

  setPersistence(p: FilePersistence) {
    this.persistence = p;
  }

  async flushIfDirty(id: RoomId): Promise<void> {
    if (!this.persistence) return;
    await this.persistence.flushIfDirty(id);
  }

  async evict(id: RoomId): Promise<void> {
    await this.flushIfDirty(id);
    this.map.delete(id);
  }

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
    // Use flushIfDirty (not store.save) so the pending debounce timer is
    // cancelled — otherwise a second write fires after eviction.
    await Promise.all(evicted.map(([id]) => this.flushIfDirty(id)));
    return evicted.length;
  }
}
