import { CanvasClient } from "@shemma/client";

export async function cmdVersion() {
  try {
    const v = await new CanvasClient().getVersion();
    console.log(JSON.stringify(v));
    return;
  } catch {
    // Daemon not reachable — fall back to env (populated by `bun build --compile --define`)
  }
  console.log(
    JSON.stringify({
      version: process.env.SHEMMA_VERSION ?? "unknown",
      channel: process.env.SHEMMA_CHANNEL ?? "dev",
      gitSha: process.env.SHEMMA_GIT_SHA ?? "unknown",
      buildDate: process.env.SHEMMA_BUILD_DATE ?? "unknown",
      daemonRunning: false,
    }),
  );
}
