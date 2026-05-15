import { promises as fs, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { parseFull, serialize } from "./envelope";
import type { RoomStore } from "./rooms";
import type { RoomId, RoomState } from "./types";

export class FilePersistence implements RoomStore {
  // pending хранит и timer, и сами данные — без этого flushAll не сможет записать debounce'нутые состояния
  private pending = new Map<
    RoomId,
    { timer: ReturnType<typeof setTimeout>; state: RoomState }
  >();
  constructor(private dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  pathFor(id: RoomId): string {
    return join(this.dir, `${id}.json`);
  }

  async load(id: RoomId): Promise<RoomState | null> {
    try {
      const raw = await fs.readFile(this.pathFor(id), "utf8");
      const env = parseFull(raw);
      return {
        canvas: env.canvas,
        prompts: env.prompts,
        version: env.version,
        opLog: [],
        dirty: false,
        lastTouched: Date.now(),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async save(id: RoomId, s: RoomState): Promise<void> {
    await fs.writeFile(this.pathFor(id), serialize(id, s), "utf8");
  }

  /**
   * Schedule a debounced save (default 300ms). The `state` argument MUST be
   * the live RoomState held by Rooms — the timer closure captures the reference,
   * so mutations applied between schedule and fire WILL be included in the write.
   * Passing a deep-clone here would silently freeze the persisted state.
   */
  scheduleSave(id: RoomId, s: RoomState): void {
    const existing = this.pending.get(id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      void this.save(id, s).catch((e) => console.error("[persistence]", e));
    }, config.autosaveDebounceMs);
    this.pending.set(id, { timer, state: s });
  }

  async flushIfDirty(id: RoomId): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    await this.save(id, pending.state);
  }

  /**
   * Immediately write all pending saves and clear the queue.
   * Called on graceful shutdown (SIGTERM/SIGINT) so debounce-300ms losses don't happen.
   */
  async flushAll(): Promise<void> {
    const entries = [...this.pending.entries()];
    for (const [, { timer }] of entries) clearTimeout(timer);
    this.pending.clear();
    await Promise.all(
      entries.map(([id, { state }]) =>
        this.save(id, state).catch((e) =>
          console.error("[persistence] flush", id, e),
        ),
      ),
    );
  }
}
