import { defaultDocument, defaultPage, defaultSchema } from "./migrate-v2";
import type { StoreOpLogEntry, TLStoreSnapshot } from "./store-types";
import type { RoomId, RoomState } from "./types";
import { DEFAULT_ROOM } from "./types";
import { config, resolveWorkspaceDir } from "./config";

/**
 * Subset of `FilePersistence` (and the per-daemon multi-room adapter) needed
 * by `Rooms` to flush debounced writes around lifecycle events. Decoupled
 * from the concrete `FilePersistence` type so the daemon entry point can
 * inject a multi-room facade without `Rooms` importing the bridge class.
 *
 * DRW-116 Task 10b will likely fold this into a richer `Persistence`
 * interface once `RoomCache` is plumbed through.
 */
export type RoomPersistence = {
  scheduleSave: (id: RoomId, s: RoomState) => void;
  flushIfDirty: (id: RoomId) => Promise<void>;
};

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

export function pushOpLog(
  room: RoomState,
  entry: StoreOpLogEntry,
  max: number,
): void {
  room.opLog.push(entry);
  if (room.opLog.length > max) {
    room.opLog.splice(0, room.opLog.length - max);
  }
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
  private persistence?: RoomPersistence;
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

  setPersistence(p: RoomPersistence) {
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
        const isNew = loaded === null;
        const s = loaded ?? makeRoomState();
        let autoFieldsDirty = false;
        // Auto-populate linkedSession on first creation/load if not already set
        // and the env session matches this room id.
        if (s.linkedSession === undefined && config.sessionId !== null && config.sessionId === id) {
          s.linkedSession = id;
          autoFieldsDirty = true;
        }
        // DRW-033: auto-populate projectDir on first creation/load if not set.
        if (s.projectDir === undefined) {
          s.projectDir = resolveWorkspaceDir();
          autoFieldsDirty = true;
        }
        if (autoFieldsDirty) {
          s.dirty = true;
          // For existing rooms on disk, schedule a back-fill save immediately so
          // flushIfDirty (e.g. in archive route) can flush the new auto-fields.
          // For brand-new rooms (no file yet), skip: the save will happen with
          // the first real mutation — scheduling now would race with archive/restore.
          if (!isNew && this.persistence) {
            this.persistence.scheduleSave(id, s);
          }
        }
        this.map.set(id, s);
        return s;
      } finally {
        this.loading.delete(id);
      }
    })();
    this.loading.set(id, p);
    return p;
  }

  /** Synchronous in-memory peek — returns state only if already loaded. */
  peek(id: RoomId): RoomState | undefined {
    return this.map.get(id);
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
