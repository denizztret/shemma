import { spawnSync } from "node:child_process";
import path from "node:path";
import pkg from "../../../package.json" with { type: "json" };

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

export function gitDescribe(cwd: string = REPO_ROOT): string | null {
  try {
    const r = spawnSync(
      "git",
      ["describe", "--tags", "--abbrev=7", "--always", "--dirty"],
      { cwd, encoding: "utf8" },
    );
    if (r.status !== 0) return null;
    const out = r.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface ResolveVersionDeps {
  // Override SHEMMA_VERSION lookup for tests. Pass "" to simulate "no env".
  // Omit to read real process.env (production path).
  envVersion?: string;
  describe?: () => string | null;
  pkgVersion?: string;
}

export function resolveVersion(deps: ResolveVersionDeps = {}): string {
  // Compiled binaries: `bun build --compile --define "process.env.SHEMMA_VERSION='X.Y.Z'"`
  // substitutes this LITERAL token at build time, so the env-shortcut wins. Renaming
  // the access (e.g. via a destructured variable) defeats --define — the substitution
  // is purely textual.
  const envVersion =
    deps.envVersion !== undefined ? deps.envVersion : process.env.SHEMMA_VERSION;
  if (envVersion) return envVersion;

  const describe = deps.describe ?? gitDescribe;
  const git = describe();
  if (git) return git;

  const fallback = deps.pkgVersion ?? pkg.version ?? "0.0.0";
  return `${fallback}-dev`;
}

export const VERSION = {
  version: resolveVersion(),
  channel: (process.env.SHEMMA_CHANNEL ?? "dev") as
    | "dev"
    | "stable"
    | "nightly",
  gitSha: process.env.SHEMMA_GIT_SHA ?? "unknown",
  buildDate: process.env.SHEMMA_BUILD_DATE ?? new Date().toISOString(),
} as const;
