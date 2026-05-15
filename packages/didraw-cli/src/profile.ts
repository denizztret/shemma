import { homedir } from "node:os";
import { join } from "node:path";

export type Profile = "dev" | "release" | "debug";

const VALID_PROFILES: readonly Profile[] = ["dev", "release", "debug"];

function isProfile(v: unknown): v is Profile {
  return (
    typeof v === "string" && (VALID_PROFILES as readonly string[]).includes(v)
  );
}

export function parseProfile(argv: string[]): Profile {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") {
      const val = argv[i + 1];
      if (!isProfile(val)) {
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
  const env = process.env.DIDRAW_PROFILE;
  if (env !== undefined && !isProfile(env)) {
    console.error(
      JSON.stringify({
        ok: false,
        error: `Invalid DIDRAW_PROFILE env: "${env}". Expected one of: ${VALID_PROFILES.join("|")}`,
      }),
    );
    process.exit(1);
  }
  return env ?? "release";
}

export function applyProfile(p: Profile) {
  process.env.DIDRAW_PROFILE = p;
}

export function pidFile(p: Profile): string {
  return join(homedir(), ".claude", `.didraw-${p}.pid`);
}

const PORT_BY_PROFILE: Record<Profile, number> = {
  dev: 8788,
  release: 8787,
  debug: 8787,
};

export function portFor(p: Profile): number {
  const raw = process.env.DIDRAW_PORT;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error(
        `Invalid DIDRAW_PORT: "${raw}". Expected positive integer ≤ 65535`,
      );
    }
    return n;
  }
  return PORT_BY_PROFILE[p];
}
