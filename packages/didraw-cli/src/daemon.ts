import { spawn } from "node:child_process";
import {
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { CanvasClient } from "@didraw/client";

const GRACEFUL_SHUTDOWN_MS = 2000; // matches backend default; override via DIDRAW_GRACEFUL_SHUTDOWN_MS
const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

import { type Profile, ALL_PROFILES, logFile, pidFile, portFor } from "./profile";

function logMaxBytes(): number {
  const raw = process.env.DIDRAW_LOG_MAX_MB;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n * 1024 * 1024;
  }
  return DEFAULT_LOG_MAX_BYTES;
}

function rotateLogIfNeeded(path: string): void {
  try {
    const size = statSync(path).size;
    if (size > logMaxBytes()) {
      const backup = `${path}.1`;
      try { unlinkSync(backup); } catch { /* no backup yet */ }
      renameSync(path, backup);
    }
  } catch {
    // file may not exist yet — that's fine
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isHealthy(port: number): Promise<boolean> {
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

export type StartOpts = {
  /**
   * Final resolved storage path для daemon child (включая profile subdir, если применимо).
   * Если задан — exported в child env как DIDRAW_STORAGE_DIR, overriding ambient env.
   */
  storageDir?: string;
};

export async function start(profile: Profile, opts: StartOpts = {}) {
  const s = await status(profile);
  if (s.running) {
    console.log(JSON.stringify({ ok: true, already: true, ...s }));
    return;
  }
  const port = portFor(profile);
  const lf = logFile(profile);
  rotateLogIfNeeded(lf);
  const logFd = openSync(lf, "a");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DIDRAW_PROFILE: profile,
    DIDRAW_PORT: String(port),
  };
  // Explicit --storage wins over ambient DIDRAW_STORAGE_DIR.
  if (opts.storageDir !== undefined) {
    env.DIDRAW_STORAGE_DIR = opts.storageDir;
  }
  const child = spawn(
    process.execPath,
    [process.argv[1], "internal-server", "--profile", profile],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env,
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
  const out: Record<string, unknown> = { ok: true, pid: child.pid, profile, port };
  if (opts.storageDir !== undefined) out.storage = opts.storageDir;
  console.log(JSON.stringify(out));
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

/**
 * Stop daemons across all profiles (or a single one if specified).
 * Idempotent: profiles that are not running produce {ok:true,already:true}.
 * Results are collected and printed as a JSON array.
 */
export async function stopAll(onlyProfile?: Profile) {
  const profiles = onlyProfile ? [onlyProfile] : [...ALL_PROFILES];
  const results: object[] = [];
  for (const p of profiles) {
    const file = pidFile(p);
    if (!existsSync(file)) {
      results.push({ ok: true, already: true, profile: p });
      continue;
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
      try { process.kill(pid, "SIGKILL"); } catch (_) {}
    }
    try { unlinkSync(file); } catch (_) { /* ignore */ }
    results.push({ ok: true, stopped: pid, profile: p });
  }
  console.log(JSON.stringify(results));
}
