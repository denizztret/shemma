// Filled by `bun build --compile --define SHEMMA_VERSION=...` at release time.
// At dev time falls back to package.json version → "0.0.0-dev".
import pkg from "../../../package.json" with { type: "json" };

export const VERSION = {
  version: process.env.SHEMMA_VERSION ?? pkg.version ?? "0.0.0-dev",
  channel: (process.env.SHEMMA_CHANNEL ?? "dev") as
    | "dev"
    | "stable"
    | "nightly",
  gitSha: process.env.SHEMMA_GIT_SHA ?? "unknown",
  buildDate: process.env.SHEMMA_BUILD_DATE ?? new Date().toISOString(),
} as const;
