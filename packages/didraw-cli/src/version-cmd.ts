import { CanvasClient } from "@didraw/client";

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
      version: process.env.DIDRAW_VERSION ?? "unknown",
      channel: process.env.DIDRAW_CHANNEL ?? "dev",
      gitSha: process.env.DIDRAW_GIT_SHA ?? "unknown",
      buildDate: process.env.DIDRAW_BUILD_DATE ?? "unknown",
      daemonRunning: false,
    }),
  );
}
