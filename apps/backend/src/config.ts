import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// DRW-116 Task 10b: `config.storageDir` removed. Per-space storage is resolved
// through `@shemma/spaces.resolveRoomStorage(space, profile, roomId)` and cached
// by `RoomCache` per (space, room). Callers that used to read the global
// directory must now thread a `SpaceRecord` (or its derived path) explicitly.
//
// `SHEMMA_STORAGE_DIR` env still exists but is consumed only by:
//   1. CLI `shemma open` / `daemon start --storage` flag resolution (resolveStorageForOpen)
//   2. test-only `makeApp({ storageDir })` shortcut that mints a `direct` SpaceRecord
// The env var no longer leaks into `getConfig()` — `legacyStorageDirEnv()` exposes
// it for the legacy-space fallback path in `index.ts` only.

const VALID_PROFILES = ["dev", "release", "debug"] as const;
export type Profile = (typeof VALID_PROFILES)[number];

// Legacy env-var compatibility (0.9.x → 0.10.0 rename didraw → shemma).
// Single backfill layer: if user still has DIDRAW_* in scripts/shell rc, we
// accept it once and emit a deprecation warning. Removed in 1.0.0.
const LEGACY_ENV_ALIASES: Record<string, string> = {
  SHEMMA_PROFILE: "DIDRAW_PROFILE",
  SHEMMA_PORT: "DIDRAW_PORT",
  SHEMMA_STORAGE_DIR: "DIDRAW_STORAGE_DIR",
  SHEMMA_LOG_LEVEL: "DIDRAW_LOG_LEVEL",
  SHEMMA_PROJECT_DIR: "DIDRAW_PROJECT_DIR",
};
const _deprecationWarned = new Set<string>();
function envWithLegacy(
  name: keyof typeof LEGACY_ENV_ALIASES,
): string | undefined {
  const v = process.env[name];
  if (v !== undefined) return v;
  const legacy = LEGACY_ENV_ALIASES[name];
  const legacyValue = legacy ? process.env[legacy] : undefined;
  if (legacyValue !== undefined && !_deprecationWarned.has(legacy)) {
    _deprecationWarned.add(legacy);
    console.warn(
      `[shemma] ${legacy} is deprecated; use ${name} instead (legacy alias accepted until 1.0.0)`,
    );
  }
  return legacyValue;
}

const portByProfile: Record<Profile, number> = {
  dev: 8788,
  release: 8787,
  debug: 8787,
};
const logLevelByProfile: Record<Profile, "debug" | "info" | "error"> = {
  dev: "debug",
  release: "info",
  debug: "debug",
};

/**
 * Legacy default storage directory used by:
 *   - `makeApp({ storageDir })` test shortcut when caller doesn't pass a path
 *   - `startServer` direct-invocation banner
 *
 * Mirrors the historical `config.storageDir` resolution but is NOT exposed as a
 * cached singleton — every call re-reads env and recomputes (no Proxy). Callers
 * inside the request path MUST use `RoomCache.get(space, roomId)` instead; this
 * helper exists only for the legacy single-space daemon bootstrap until
 * Task 11/22 finishes the per-space routing.
 */
const STORAGE_SUBDIR_BY_PROFILE: Record<Profile, string> = {
  dev: "canvas-dev",
  release: "canvas",
  debug: "canvas",
};

export function resolveLegacyStorageDir(
  profile: Profile = getProfile(),
): string {
  return (
    envWithLegacy("SHEMMA_STORAGE_DIR") ??
    join(
      homedir(),
      ".claude",
      "projects",
      resolveProjectSlug(),
      STORAGE_SUBDIR_BY_PROFILE[profile],
    )
  );
}

export function getProfile(): Profile {
  const raw = envWithLegacy("SHEMMA_PROFILE") ?? "release";
  if (!VALID_PROFILES.includes(raw as Profile)) {
    throw new Error(
      `Invalid SHEMMA_PROFILE: "${raw}". Expected one of: ${VALID_PROFILES.join("|")}`,
    );
  }
  return raw as Profile;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(
      `Invalid SHEMMA_PORT: "${raw}". Expected positive integer ≤ 65535`,
    );
  }
  return n;
}

// Cap on the slug body so that `${body}-${8-char hash}` ≤ 255 bytes —
// иначе на длинных путях mkdir падает с ENAMETOOLONG (Phase 2.0 follow-up I1).
const MAX_SLUG_BODY = 246; // 246 + 1 ("-") + 8 (sha1[0:8]) = 255

export function slugifyProject(input: string | undefined): string {
  if (!input) return "default-project";
  const base = basename(input.replace(/[\\/]+$/, "")) || input;
  const body = base
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!body) return "default-project";
  const truncated =
    body.length > MAX_SLUG_BODY ? body.slice(0, MAX_SLUG_BODY) : body;
  const hash = createHash("sha1").update(input).digest("hex").slice(0, 8);
  return `${truncated}-${hash}`;
}

export function resolveProjectSlug(): string {
  return slugifyProject(
    envWithLegacy("SHEMMA_PROJECT_DIR") ??
      process.env.CLAUDE_PROJECT_DIR ??
      process.cwd(),
  );
}

export function resolveWorkspaceDir(): string {
  return (
    envWithLegacy("SHEMMA_PROJECT_DIR") ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd()
  );
}

export function getConfig() {
  const profile = getProfile();
  return {
    profile,
    port: parsePort(envWithLegacy("SHEMMA_PORT"), portByProfile[profile]),
    logLevel: (envWithLegacy("SHEMMA_LOG_LEVEL") ??
      logLevelByProfile[profile]) as "debug" | "info" | "error",
    autosaveDebounceMs: 300,
    roomEvictionMs: 60 * 60 * 1000,
    opLogMaxSize: 50,
    gracefulShutdownMs: 2000,
    sessionId: process.env.CLAUDE_SESSION_ID ?? null,
    projectSlug: resolveProjectSlug(),
    workspaceDir: resolveWorkspaceDir(),
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

// Test-only: drop the cached config so the next read re-evaluates env vars.
// Не вызывать в production-коде.
export function __resetConfigForTests(): void {
  _cache = null;
  _deprecationWarned.clear();
}

/** XDG-aware config file path resolver. */
export function configFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "shemma", "config.json");
}

export interface ConfigFile {
  miro?: {
    token?: string;
    createdAt?: string;
  };
}

/**
 * Read full config; returns `null` when file does not exist (ENOENT).
 * Throws Error with hint on EACCES or invalid JSON.
 */
export function readConfig(): ConfigFile | null {
  const p = configFilePath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as ConfigFile;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    if (err.code === "EACCES") {
      throw new Error(
        `Cannot read ${p}: permission denied. Try: chmod 600 ${p}`,
      );
    }
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${p}: ${e.message}`);
    }
    throw e;
  }
}

/** Write full config; creates directory if needed, enforces 0o600 permissions. */
export function writeConfig(cfg: ConfigFile): void {
  const p = configFilePath();
  fs.mkdirSync(dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

/** Read Miro token, or null if unset. */
export function readMiroToken(): string | null {
  const cfg = readConfig();
  return cfg?.miro?.token ?? null;
}

/** Write Miro token, merging with existing config. */
export function writeMiroToken(token: string): void {
  const cfg: ConfigFile = readConfig() ?? {};
  cfg.miro = { ...cfg.miro, token, createdAt: new Date().toISOString() };
  writeConfig(cfg);
}

/** Remove Miro token; keeps other config keys. */
export function unsetMiroToken(): void {
  const cfg = readConfig();
  if (!cfg?.miro?.token) return;
  delete cfg.miro.token;
  writeConfig(cfg);
}
