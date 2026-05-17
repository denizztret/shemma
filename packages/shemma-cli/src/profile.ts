import { homedir } from "node:os";
import { join } from "node:path";

export type Profile = "dev" | "release" | "debug";

export const ALL_PROFILES: readonly Profile[] = ["dev", "release", "debug"];

const VALID_PROFILES: readonly Profile[] = ALL_PROFILES;

function isProfile(v: unknown): v is Profile {
  return (
    typeof v === "string" && (VALID_PROFILES as readonly string[]).includes(v)
  );
}

export function parseProfile(argv: string[]): Profile {
  // --debug shortcut = --profile debug
  if (argv.includes("--debug")) return "debug";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") {
      const val = argv[i + 1];
      if (!isProfile(val)) {
        // ui module not yet initialized at parseProfile time — emit raw JSON
        // to stderr for backward compat. This runs before `initOutput()`.
        console.error(
          JSON.stringify({
            ok: false,
            error: `Invalid --profile: "${val}". Expected one of: ${VALID_PROFILES.join("|")}`,
          }),
        );
        process.exit(1);
      }
      return val;
    }
  }
  // Legacy compat: accept DIDRAW_PROFILE (pre-0.10.0). Removed in 1.0.0.
  let env = process.env.SHEMMA_PROFILE;
  if (env === undefined && process.env.DIDRAW_PROFILE !== undefined) {
    console.warn(
      `[shemma] DIDRAW_PROFILE is deprecated; use SHEMMA_PROFILE instead (legacy alias accepted until 1.0.0)`,
    );
    env = process.env.DIDRAW_PROFILE;
  }
  if (env !== undefined && !isProfile(env)) {
    console.error(
      JSON.stringify({
        ok: false,
        error: `Invalid SHEMMA_PROFILE env: "${env}". Expected one of: ${VALID_PROFILES.join("|")}`,
      }),
    );
    process.exit(1);
  }
  return env ?? "release";
}

export function applyProfile(p: Profile) {
  process.env.SHEMMA_PROFILE = p;
}

export function pidFile(p: Profile): string {
  return join(homedir(), ".claude", `.shemma-${p}.pid`);
}

export function logFile(p: Profile): string {
  return join(homedir(), ".claude", `.shemma-${p}.log`);
}

const PORT_BY_PROFILE: Record<Profile, number> = {
  dev: 8788,
  release: 8787,
  debug: 8787,
};

export function portFor(p: Profile): number {
  // Legacy compat: accept DIDRAW_PORT (pre-0.10.0). Removed in 1.0.0.
  const raw = process.env.SHEMMA_PORT ?? process.env.DIDRAW_PORT;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error(
        `Invalid SHEMMA_PORT: "${raw}". Expected positive integer ≤ 65535`,
      );
    }
    return n;
  }
  return PORT_BY_PROFILE[p];
}
