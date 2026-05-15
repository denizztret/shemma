import { promises as fs, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { emptyCanvasState } from "./rooms";
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

  async load(id: RoomId): Promise<RoomState | null> {
    const path = join(this.dir, `${sanitize(id)}.json`);
    try {
      const raw = await fs.readFile(path, "utf8");
      const j = JSON.parse(raw) as Partial<RoomState>;
      return {
        canvas: j.canvas ?? emptyCanvasState(),
        prompts: j.prompts ?? [],
        version: j.version ?? 0,
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
    const path = join(this.dir, `${sanitize(id)}.json`);
    const dump = JSON.stringify(
      { canvas: s.canvas, prompts: s.prompts, version: s.version },
      null,
      2,
    );
    await fs.writeFile(path, dump, "utf8");
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

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
