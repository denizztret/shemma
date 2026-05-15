import { homedir } from "node:os";
import { join } from "node:path";

const VALID_PROFILES = ["dev", "release", "debug"] as const;
export type Profile = (typeof VALID_PROFILES)[number];

const portByProfile: Record<Profile, number> = {
  dev: 8788,
  release: 8787,
  debug: 8787,
};
const storageSubdir: Record<Profile, string> = {
  dev: "canvas-dev",
  release: "canvas",
  debug: "canvas",
};
const logLevelByProfile: Record<Profile, "debug" | "info" | "error"> = {
  dev: "debug",
  release: "info",
  debug: "debug",
};

export function getProfile(): Profile {
  const raw = process.env.DIDRAW_PROFILE ?? "release";
  if (!VALID_PROFILES.includes(raw as Profile)) {
    throw new Error(
      `Invalid DIDRAW_PROFILE: "${raw}". Expected one of: ${VALID_PROFILES.join("|")}`,
    );
  }
  return raw as Profile;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(
      `Invalid DIDRAW_PORT: "${raw}". Expected positive integer ≤ 65535`,
    );
  }
  return n;
}

export function getConfig() {
  const profile = getProfile();
  return {
    profile,
    port: parsePort(process.env.DIDRAW_PORT, portByProfile[profile]),
    storageDir:
      process.env.DIDRAW_STORAGE_DIR ??
      join(
        homedir(),
        ".claude",
        "projects",
        "default-project",
        storageSubdir[profile],
      ),
    logLevel: (process.env.DIDRAW_LOG_LEVEL ?? logLevelByProfile[profile]) as
      | "debug"
      | "info"
      | "error",
    autosaveDebounceMs: 300,
    roomEvictionMs: 60 * 60 * 1000,
    opLogMaxSize: 50,
    gracefulShutdownMs: 2000,
  } as const;
}

// Lazy singleton: первое обращение читает env и кеширует;
// сохраняет stable-семантику `const config` без race на каждое чтение.
let _cache: ReturnType<typeof getConfig> | null = null;
export const config = new Proxy({} as ReturnType<typeof getConfig>, {
  get: (_, k) => {
    if (_cache === null) _cache = getConfig();
    return _cache[k as keyof ReturnType<typeof getConfig>];
  },
});
