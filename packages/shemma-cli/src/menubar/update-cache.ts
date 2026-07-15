// Кеш update-badge: `update --check` — сетевой, а render дергается каждые 5 с.
// TTL 6 ч; протух — перепроверка прямо в рендере с жёстким таймаутом (caller
// оборачивает check в withTimeout). Упавшая проверка тоже кешируется как
// «нет обновления», чтобы офлайн не превращался в fetch на каждый рефреш.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CachedBadge {
  available: boolean;
  latest: string | null;
}

interface CacheFile {
  checkedAt: number;
  badge: CachedBadge;
}

export function updateCachePath(): string {
  return join(homedir(), ".claude", ".shemma-menubar-update.json");
}

export async function getUpdateBadge(opts: {
  cachePath: string;
  ttlMs: number;
  now: number;
  check: () => Promise<CachedBadge>;
}): Promise<CachedBadge> {
  const cached = readCache(opts.cachePath);
  if (cached && opts.now - cached.checkedAt < opts.ttlMs) return cached.badge;
  let badge: CachedBadge;
  try {
    badge = await opts.check();
  } catch {
    badge = { available: false, latest: null };
  }
  try {
    mkdirSync(dirname(opts.cachePath), { recursive: true });
    writeFileSync(
      opts.cachePath,
      JSON.stringify({ checkedAt: opts.now, badge } satisfies CacheFile),
    );
  } catch {
    // кеш — best-effort
  }
  return badge;
}

function readCache(path: string): CacheFile | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (typeof parsed?.checkedAt !== "number" || parsed.badge === undefined) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
