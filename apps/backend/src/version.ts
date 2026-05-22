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
  env?: NodeJS.ProcessEnv;
  describe?: () => string | null;
  pkgVersion?: string;
}

export function resolveVersion(deps: ResolveVersionDeps = {}): string {
  const env = deps.env ?? process.env;
  if (env.SHEMMA_VERSION) return env.SHEMMA_VERSION;
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
