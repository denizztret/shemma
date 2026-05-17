import { VERSION } from "./version";

// Repo for distribution. Override via SHEMMA_GITHUB_REPO for forks/tests.
const DEFAULT_REPO = "denizztret/shemma";

function githubRepo(): string {
  return process.env.SHEMMA_GITHUB_REPO ?? DEFAULT_REPO;
}

// Lazy to allow tests to override SHEMMA_MANIFEST_URL after module load.
// Default points at GitHub Releases API for the latest release — works for
// both public and private repos when a PAT is available.
function getManifestUrl(): string {
  return (
    process.env.SHEMMA_MANIFEST_URL ??
    `https://api.github.com/repos/${githubRepo()}/releases/latest`
  );
}

interface GitHubAsset {
  id: number;
  name: string;
  url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

type Manifest = { channels?: Record<string, { version?: string }> };

type CacheEntry = { at: number; latest: string | null };
let cache: CacheEntry | null = null;
const TTL = 60 * 60 * 1000;

/**
 * Read PAT from env / config file / gh CLI. Mirrors CLI auth chain — backend
 * runs in the same user context, so the same precedence applies.
 *
 * Imported lazily to keep startup cheap when env token is present.
 */
async function readBackendToken(): Promise<string | null> {
  if (process.env.SHEMMA_GITHUB_TOKEN) return process.env.SHEMMA_GITHUB_TOKEN;
  try {
    // Avoid hard-coupling backend → CLI package at module-load time. The
    // function is only invoked once per TTL window in checkLatest().
    const auth = await import("../../../packages/shemma-cli/src/auth");
    // Backend runs in long-lived daemon — skip the 1.5s gh subprocess call
    // so a missing PAT never blocks the request loop on first miss.
    return auth.readToken({ skipGhCli: true });
  } catch {
    return null;
  }
}

function isStaticManifestUrl(url: string): boolean {
  if (/^https?:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\//.test(url)) {
    return false;
  }
  return true;
}

async function fetchManifest(url: string, token: string | null): Promise<Manifest> {
  const baseHeaders: Record<string, string> = {
    "User-Agent": "shemma-backend",
  };
  if (token) baseHeaders.Authorization = `Bearer ${token}`;

  if (isStaticManifestUrl(url)) {
    const r = await fetch(url, {
      headers: { ...baseHeaders, Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`manifest ${r.status}`);
    return (await r.json()) as Manifest;
  }

  // GitHub API release endpoint → resolve release-manifest.json asset.
  const r = await fetch(url, {
    headers: { ...baseHeaders, Accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`release ${r.status}`);
  const release = (await r.json()) as GitHubRelease;
  const asset = release.assets.find((a) => a.name === "release-manifest.json");
  if (!asset) throw new Error(`no release-manifest.json in ${release.tag_name}`);
  const r2 = await fetch(asset.url, {
    headers: { ...baseHeaders, Accept: "application/octet-stream" },
  });
  if (!r2.ok) throw new Error(`asset ${r2.status}`);
  return (await r2.json()) as Manifest;
}

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
    const token = await readBackendToken();
    const m = await fetchManifest(getManifestUrl(), token);
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
