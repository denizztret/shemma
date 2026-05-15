// Filled by `bun build --compile --define DIDRAW_VERSION=...` at release time.
// At dev time falls back to package.json version → "0.0.0-dev".
import pkg from "../../../package.json" with { type: "json" };

export const VERSION = {
  version: process.env.DIDRAW_VERSION ?? pkg.version ?? "0.0.0-dev",
  channel: (process.env.DIDRAW_CHANNEL ?? "dev") as
    | "dev"
    | "stable"
    | "nightly",
  gitSha: process.env.DIDRAW_GIT_SHA ?? "unknown",
  buildDate: process.env.DIDRAW_BUILD_DATE ?? new Date().toISOString(),
} as const;
