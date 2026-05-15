import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { CanvasClient } from "@didraw/client";

const GRACEFUL_SHUTDOWN_MS = 2000; // matches backend default; override via DIDRAW_GRACEFUL_SHUTDOWN_MS
import { type Profile, pidFile, portFor } from "./profile";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isHealthy(port: number): Promise<boolean> {
  try {
    return await new CanvasClient({
      baseUrl: `http://localhost:${port}`,
    }).health();
  } catch {
    return false;
  }
}

export async function status(profile: Profile) {
  const port = portFor(profile);
  const file = pidFile(profile);
  if (!existsSync(file)) return { running: false, profile, port };
  const pid = Number(readFileSync(file, "utf8"));
  if (!isAlive(pid)) return { running: false, profile, port };
  return { running: await isHealthy(port), pid, profile, port };
}

export async function start(profile: Profile) {
  const s = await status(profile);
  if (s.running) {
    console.log(JSON.stringify({ ok: true, already: true, ...s }));
    return;
  }
  const port = portFor(profile);
  const child = spawn(
    process.execPath,
    [process.argv[1], "internal-server", "--profile", profile],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        DIDRAW_PROFILE: profile,
        DIDRAW_PORT: String(port),
      },
    },
  );
  child.unref();
  if (!child.pid) {
    console.error(
      JSON.stringify({ ok: false, error: "failed to spawn daemon: no PID" }),
    );
    process.exit(1);
  }
  writeFileSync(pidFile(profile), String(child.pid));
  console.log(JSON.stringify({ ok: true, pid: child.pid, profile, port }));
}

/**
 * Ensure the daemon is running. Prints status to stdout on success.
 * Used by the `daemon ensure` CLI command where the caller wants confirmation.
 */
export async function ensure(profile: Profile) {
  await ensureDaemon(profile, /* verbose */ true);
}

/**
 * Ensure the daemon is running without printing to stdout on success.
 * Used internally by lifecycle commands whose own output occupies stdout.
 */
export async function ensureSilent(profile: Profile) {
  await ensureDaemon(profile, /* verbose */ false);
}

async function ensureDaemon(profile: Profile, verbose: boolean) {
  // Fast path: if DIDRAW_PORT is explicitly set (e.g. in tests or when the
  // caller already knows the port), skip PID-file checks and just verify
  // the server is healthy. This avoids spurious daemon spawns when an
  // in-process test server is already listening on the target port.
  if (process.env.DIDRAW_PORT !== undefined) {
    const port = portFor(profile);
    if (await isHealthy(port)) {
      if (verbose) {
        console.log(JSON.stringify({ ok: true, already: true, profile, port }));
      }
      return;
    }
    console.error(
      JSON.stringify({
        ok: false,
        error: `didraw: DIDRAW_PORT is set but server not healthy on :${port}`,
      }),
    );
    process.exit(3);
  }
  const s = await status(profile);
  if (s.running) {
    if (verbose) {
      console.log(JSON.stringify({ ok: true, already: true, ...s }));
    }
    return;
  }
  await start(profile);
  const port = portFor(profile);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isHealthy(port)) return;
  }
  console.error(
    JSON.stringify({
      ok: false,
      error: `didraw: not healthy within 5s on :${port}`,
    }),
  );
  process.exit(3);
}

export async function stop(profile: Profile) {
  const file = pidFile(profile);
  if (!existsSync(file)) {
    console.log(JSON.stringify({ ok: true, already: true, profile }));
    return;
  }
  const pid = Number(readFileSync(file, "utf8"));
  try {
    process.kill(pid, "SIGTERM");
  } catch (_) {}
  const overrideMs = Number(process.env.DIDRAW_GRACEFUL_SHUTDOWN_MS);
  const gracefulMs =
    Number.isFinite(overrideMs) && overrideMs > 0
      ? overrideMs
      : GRACEFUL_SHUTDOWN_MS;
  const deadline = Date.now() + gracefulMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (_) {}
  }
  try {
    unlinkSync(file);
  } catch (_) {
    /* ignore — file may already be gone */
  }
  console.log(JSON.stringify({ ok: true, stopped: pid, profile }));
}
