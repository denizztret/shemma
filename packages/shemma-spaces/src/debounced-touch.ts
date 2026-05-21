import { loadAndModify } from "./registry.js";
import type { SpaceId } from "./types.js";

const DEFAULT_FLUSH_MS = Number(process.env.SHEMMA_SPACES_FLUSH_MS ?? 10_000);

export class DebouncedTouch {
  private dirty = new Set<SpaceId>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private flushMs: number = DEFAULT_FLUSH_MS) {}

  touch(id: SpaceId): void {
    this.dirty.add(id);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.dirty.size === 0) return;
    const ids = Array.from(this.dirty);
    this.dirty.clear();
    const now = new Date().toISOString();
    loadAndModify(reg => {
      for (const id of ids) {
        const s = reg.spaces.find(r => r.id === id);
        if (s) s.lastUsedAt = now;
      }
      return reg;
    });
  }

  shutdown(): void { this.flush(); }
}
