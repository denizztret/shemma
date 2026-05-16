import { promises as fs, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { parseFull, parseHeader, parseV2OrThrow, serialize } from "./envelope";
import { migrateV2ToV3 } from "./migrate-v2";
import type { RoomStore } from "./rooms";
import { rebuildDidrawIndex } from "./store-ops";
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
    const file = this.pathFor(id);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const header = parseHeader(raw);
    // v2/v1 → мигрируем в v3 в памяти. Phase 3.0 Task 11 добавит .v2.bak + rewrite на диск.
    if (header?.schemaVersion === 2 || (header as { schemaVersion?: number } | null)?.schemaVersion === 1) {
      const v2 = parseV2OrThrow(raw);
      const v3 = migrateV2ToV3(v2 as Parameters<typeof migrateV2ToV3>[0]);
      const backupPath = `${file}.v2.bak`;
      if (!existsSync(backupPath)) {
        try {
          await fs.rename(file, backupPath);
        } catch {
          // best-effort: если backup не получился (concurrent rename, FS-error) — продолжаем
        }
      }
      const state: RoomState = {
        store: v3.store,
        opLog: [],
        prompts: v3.prompts,
        version: v3.version,
        dirty: true,
        lastTouched: Date.now(),
        didrawIndex: rebuildDidrawIndex(v3.store),
      };
      // Atomic rewrite as v3 — best-effort. Не критично для load: пусть дебаунс/flush сохранят.
      try {
        await fs.writeFile(file, serialize(id, state), "utf8");
        state.dirty = false;
      } catch {
        // оставляем dirty=true; следующий flush допишет
      }
      return state;
    }
    const env = parseFull(raw);
    return {
      store: env.store,
      prompts: env.prompts,
      version: env.version,
      opLog: env.opLog ?? [],
      dirty: false,
      lastTouched: Date.now(),
      didrawIndex: rebuildDidrawIndex(env.store),
    };
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
