import {
  type Profile,
  type SpaceRecord,
  resolveRoomStorage,
} from "@shemma/spaces";
import { FilePersistence } from "./persistence";

type Key = string;
type Entry = { persistence: FilePersistence; lastTouchedAt: number };

const TTL_MS = 5 * 60 * 1000;
const SWEEP_MS = 60_000;

/**
 * Daemon-wide singleton cache of `FilePersistence` instances keyed by
 * `(spaceId, roomId)`.
 *
 * Each `FilePersistence` owns a debounce buffer (`pending`) and must remain
 * the SAME instance for a given (space, room) pair across HTTP/WS requests —
 * a fresh instance per request would drop the in-flight debounced write.
 *
 * Idle entries (no `get()` in `TTL_MS`) are flushed via `flushAll` and dropped
 * by a sweep interval so long-lived daemons don't accumulate one buffer per
 * room they've ever seen.
 *
 * DRW-116 Task 10b — the daemon-wide singleton lives in `index.ts`
 * (`getRoomCache()`); `makeApp` wraps it with `SingleSpacePersistence` for the
 * legacy single-space flow. Task 11 will rewire routes/WS to read the per-
 * request `space` from `c.get("space")` and call `cache.get(space, roomId)`
 * directly.
 */
export class RoomCache {
  private cache = new Map<Key, Entry>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private profile: Profile) {
    this.timer = setInterval(() => {
      void this.evictIdle();
    }, SWEEP_MS);
    // unref() is critical — without it, the interval would keep the process
    // alive past idle-shutdown.
    this.timer.unref?.();
  }

  get(space: SpaceRecord, roomId: string): FilePersistence {
    const key = `${space.id}:${roomId}`;
    let entry = this.cache.get(key);
    if (!entry) {
      const filePath = resolveRoomStorage(space, this.profile, roomId);
      entry = {
        persistence: new FilePersistence(filePath),
        lastTouchedAt: Date.now(),
      };
      this.cache.set(key, entry);
    } else {
      entry.lastTouchedAt = Date.now();
    }
    return entry.persistence;
  }

  private async evictIdle(): Promise<void> {
    const cutoff = Date.now() - TTL_MS;
    const drained: Entry[] = [];
    for (const [k, e] of this.cache) {
      if (e.lastTouchedAt < cutoff) {
        drained.push(e);
        this.cache.delete(k);
      }
    }
    // Flush any pending debounced writes on eviction — otherwise the
    // 300ms window since the last scheduleSave is dropped on the floor.
    await Promise.all(
      drained.map((e) =>
        e.persistence.flushAll().catch((err) => {
          console.error("[room-cache] evict flush error:", err);
        }),
      ),
    );
  }

  /**
   * Flush every cached persistence WITHOUT stopping the sweep timer or
   * clearing the cache. Used by the per-makeApp `flushAll` facade so that
   * in-process tests (which may call `srv.close()` mid-suite and then
   * spin up another `makeApp`) preserve cache entries + the sweep interval.
   * The daemon's SIGTERM/IDLE handler still calls `shutdown()` for full
   * teardown.
   */
  async flushAll(): Promise<void> {
    const entries = [...this.cache.values()];
    await Promise.all(
      entries.map((e) =>
        e.persistence.flushAll().catch((err) => {
          console.error("[room-cache] flushAll error:", err);
        }),
      ),
    );
  }

  /**
   * Stop the sweep timer and flush every cached persistence synchronously
   * (well, by awaiting the returned promise). Called from the daemon's
   * SIGTERM/SIGINT/IDLE shutdown chain in Task 10b.
   */
  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const entries = [...this.cache.values()];
    this.cache.clear();
    await Promise.all(
      entries.map((e) =>
        e.persistence.flushAll().catch((err) => {
          console.error("[room-cache] shutdown flush error:", err);
        }),
      ),
    );
  }
}
