import { promises as fs, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { parseFull, parseHeader, parseV2OrThrow, serialize } from "./envelope";
import { migrateV2ToV3 } from "./migrate-v2";
import type { RoomStore } from "./rooms";
import { rebuildDidrawIndex } from "./store-ops";
import type { RoomId, RoomState } from "./types";

/**
 * Atomic file write: пишем в `<file>.tmp` и переименовываем в `<file>`.
 * `rename` атомарен на POSIX — частично записанный файл не виден консьюмерам.
 * При ошибке записи попытаемся удалить tmp, чтобы не оставлять мусор.
 */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`;
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, file);
  } catch (e) {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore: tmp может не существовать
    }
    throw e;
  }
}

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
    const schemaVersion =
      header?.schemaVersion ??
      ((): number | undefined => {
        try {
          return (JSON.parse(raw) as { schemaVersion?: number }).schemaVersion;
        } catch {
          return undefined;
        }
      })();
    // v2/v1 envelope → migrate to v3, backup original as .v2.bak, atomic rewrite v3.
    if (schemaVersion === 2 || schemaVersion === 1) {
      const v2 = parseV2OrThrow(raw);
      const v3 = migrateV2ToV3(v2 as Parameters<typeof migrateV2ToV3>[0]);
      const backupPath = `${file}.v2.bak`;
      // Backup ДО переименования: если backup уже есть (повторный load после crash),
      // не перезатираем его. rename(file → backup) удаляет file атомарно.
      if (!existsSync(backupPath)) {
        try {
          await fs.rename(file, backupPath);
        } catch {
          // best-effort: concurrent rename / FS error — пропускаем
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
      try {
        await writeAtomic(file, serialize(id, state));
        state.dirty = false;
      } catch {
        // оставляем dirty=true; следующий flush допишет v3 на диск
      }
      return state;
    }
    const env = parseFull(raw);
    const state: RoomState = {
      store: env.store,
      prompts: env.prompts,
      version: env.version,
      opLog: env.opLog ?? [],
      dirty: false,
      lastTouched: Date.now(),
      didrawIndex: rebuildDidrawIndex(env.store),
    };
    if (env.linkedSession !== undefined) state.linkedSession = env.linkedSession;
    return state;
  }

  async save(id: RoomId, s: RoomState): Promise<void> {
    await writeAtomic(this.pathFor(id), serialize(id, s));
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
