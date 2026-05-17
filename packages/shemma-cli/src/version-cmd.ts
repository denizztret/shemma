import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CanvasClient } from "@shemma/client";
import { getOutput } from "./ui";

interface VersionInfo {
  version: string;
  channel: string;
  gitSha?: string;
  buildDate?: string;
  daemonRunning?: boolean;
}

/**
 * Dev-mode fallback: read package.json:version when SHEMMA_VERSION env injection
 * (set by `build-release.sh --define`) is absent. Suffix `-dev` distinguishes
 * source-run from compiled release. Avoids the legacy `[unknown]` banner.
 */
function devVersionFromPackage(): string {
  try {
    const pkgPath = join(import.meta.dir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (pkg.version) return `${pkg.version}-dev`;
  } catch {
    // fall through
  }
  return "unknown";
}

function emit(v: VersionInfo): void {
  const ui = getOutput();
  if (ui.mode === "json") {
    process.stdout.write(JSON.stringify(v) + "\n");
    return;
  }
  process.stdout.write(
    `shemma v${v.version} [${v.channel}]${v.daemonRunning === false ? " (daemon not running)" : ""}\n`,
  );
  if (v.gitSha && v.gitSha !== "unknown") {
    process.stdout.write(`  git: ${v.gitSha}\n`);
  }
  if (v.buildDate && v.buildDate !== "unknown") {
    process.stdout.write(`  built: ${v.buildDate}\n`);
  }
}

export async function cmdVersion() {
  try {
    const v = (await new CanvasClient().getVersion()) as VersionInfo;
    emit(v);
    return;
  } catch {
    // Daemon not reachable — fall back to env (populated by `bun build --compile --define`)
  }
  const envVersion = process.env.SHEMMA_VERSION;
  emit({
    version: envVersion && envVersion.length > 0 ? envVersion : devVersionFromPackage(),
    channel: process.env.SHEMMA_CHANNEL ?? "dev",
    gitSha: process.env.SHEMMA_GIT_SHA ?? "unknown",
    buildDate: process.env.SHEMMA_BUILD_DATE ?? "unknown",
    daemonRunning: false,
  });
}
