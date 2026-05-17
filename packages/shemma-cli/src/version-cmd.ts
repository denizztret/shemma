import { CanvasClient } from "@shemma/client";
import { getOutput } from "./ui";

interface VersionInfo {
  version: string;
  channel: string;
  gitSha?: string;
  buildDate?: string;
  daemonRunning?: boolean;
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
  emit({
    version: process.env.SHEMMA_VERSION ?? "unknown",
    channel: process.env.SHEMMA_CHANNEL ?? "dev",
    gitSha: process.env.SHEMMA_GIT_SHA ?? "unknown",
    buildDate: process.env.SHEMMA_BUILD_DATE ?? "unknown",
    daemonRunning: false,
  });
}
