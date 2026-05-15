import { VERSION } from "./version";

// Lazy to allow tests to override DIDRAW_MANIFEST_URL after module load.
function getManifestUrl(): string {
  return (
    process.env.DIDRAW_MANIFEST_URL ??
    "https://github.com/example/di.draw/releases/download/latest/release-manifest.json"
  );
}

type CacheEntry = { at: number; latest: string | null };
let cache: CacheEntry | null = null;
const TTL = 60 * 60 * 1000;

export async function checkLatest(): Promise<{
  updateAvailable: boolean;
  latest: string | null;
}> {
  if (cache && Date.now() - cache.at < TTL) {
    return {
      latest: cache.latest,
      updateAvailable: !!cache.latest && cache.latest !== VERSION.version,
    };
  }
  try {
    const r = await fetch(getManifestUrl());
    if (!r.ok) throw new Error(`manifest ${r.status}`);
    const m = (await r.json()) as {
      channels?: Record<string, { version?: string }>;
    };
    const latest = m.channels?.[VERSION.channel]?.version ?? null;
    cache = { at: Date.now(), latest };
    return { latest, updateAvailable: !!latest && latest !== VERSION.version };
  } catch {
    cache = { at: Date.now(), latest: null };
    return { latest: null, updateAvailable: false };
  }
}

// test-only: wipe the in-memory cache so each test starts clean.
export function __resetCache(): void {
  cache = null;
}
