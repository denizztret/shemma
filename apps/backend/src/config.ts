import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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
    process.env.DIDRAW_PROJECT_DIR ??
      process.env.CLAUDE_PROJECT_DIR ??
      process.cwd(),
  );
}

export function resolveWorkspaceDir(): string {
  return (
    process.env.DIDRAW_PROJECT_DIR ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd()
  );
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
        resolveProjectSlug(),
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
}
