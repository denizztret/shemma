import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { CanvasClient } from "@shemma/client";
import {
  acquireLock,
  isLockAlive,
  readLockMetadata,
  releaseLock,
} from "@shemma/lockfile";

const GRACEFUL_SHUTDOWN_MS = 2000; // matches backend default; override via SHEMMA_GRACEFUL_SHUTDOWN_MS
const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const POLL_INTERVAL_MS = 100;
const ACQUIRE_TIMEOUT_MS = 5000;

import {
  ALL_PROFILES,
  type Profile,
  lockDir as lockDirFor,
  logFile,
  portFor,
} from "./profile";
import { getOutput, error as uiError, success as uiSuccess } from "./ui";

// Module-level guard: nudge is informational — print at most once per process,
// not once per ensureDaemon() call. Tests reset via __resetNudgeForTesting.
let mcpNudgePrinted = false;

function maybePrintMcpNudge(verbose: boolean): void {
  if (mcpNudgePrinted) return;
  if (!verbose) return;
  if (process.env.SHEMMA_NO_MCP_NUDGE === "1") return;
  const ui = getOutput();
  if (ui.mode === "json") return;
  console.error(
    "tip: register Shemma as MCP server in your agent client:\n" +
      "       Claude Code:  claude mcp add shemma --scope user -- shemma mcp start\n" +
      "       Codex:        codex mcp add shemma -- shemma mcp start\n" +
      "       Gemini CLI:   gemini mcp add shemma --scope user -- shemma mcp start\n" +
      "     Full guide: docs/mcp.md  (set SHEMMA_NO_MCP_NUDGE=1 to silence)",
  );
  mcpNudgePrinted = true;
}

/** Test-only: reset module-level guard between tests. */
export function __resetNudgeForTesting(): void {
  mcpNudgePrinted = false;
}

/** Test-only: expose internal function under stable name (it's not exported normally). */
export function __maybePrintMcpNudgeForTesting(verbose: boolean): void {
  maybePrintMcpNudge(verbose);
}

function logMaxBytes(): number {
  const raw = process.env.SHEMMA_LOG_MAX_MB;
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
      try {
        unlinkSync(backup);
      } catch {
        /* no backup yet */
      }
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

async function pollFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const startTs = Date.now();
  while (Date.now() - startTs < timeoutMs) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * DRW-132: pure decision branch for "is the lock metadata ours, and is the
 * holder still alive". Extracted so the cross-profile lock-share case
 * (release vs debug on port 8787) can be unit-tested without spinning up a
 * real daemon. Returns `null` for the not-running outcomes; the live-lock
 * details otherwise.
 */
export function evaluateLockOwnership(
  meta: { pid: number; profile: string; startedAt: string } | undefined,
  profile: Profile,
  isAliveFn: (pid: number) => boolean = isAlive,
): { pid: number; startedAt: string } | null {
  if (!meta) return null;
  if (!isAliveFn(meta.pid)) return null;
  if (meta.profile !== profile) return null;
  return { pid: meta.pid, startedAt: meta.startedAt };
}

export async function status(profile: Profile) {
  const port = portFor(profile);
  const dir = lockDirFor(port);
  const meta = readLockMetadata(dir);
  const owned = evaluateLockOwnership(meta, profile);
  if (!owned) return { running: false, profile, port };
  return {
    running: await isHealthy(port),
    pid: owned.pid,
    profile,
    port,
    startedAt: owned.startedAt,
  };
}

export type StartOpts = {
  /**
   * Final resolved storage path для daemon child (включая profile subdir, если применимо).
   * Если задан — exported в child env как SHEMMA_STORAGE_DIR, overriding ambient env.
   */
  storageDir?: string;
};

export type StartResult = {
  reused: boolean;
  pid: number;
  profile: Profile;
  port: number;
};

type SpawnEnvExtras = {
  lockDir: string;
  port: number;
  profile: Profile;
  storageDir?: string;
};

function spawnDetached(profile: Profile, extras: SpawnEnvExtras): ChildProcess {
  const lf = logFile(profile);
  rotateLogIfNeeded(lf);
  const logFd = openSync(lf, "a");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SHEMMA_PROFILE: profile,
    SHEMMA_PORT: String(extras.port),
    SHEMMA_LOCK_DIR: extras.lockDir,
  };
  if (extras.storageDir !== undefined) {
    env.SHEMMA_STORAGE_DIR = extras.storageDir;
  }
  // process.argv[1] differs by exec mode:
  //   bun source: ".../shemma-cli/src/index.ts" (script path needed by bun)
  //   compiled binary: first user arg (e.g. "daemon") — must NOT be passed through.
  // Detect bun source via execPath ending in "bun" / "bun-canary" / etc.
  const isBunSource = /\/bun(-[^/]+)?$/.test(process.execPath);
  const childArgs = isBunSource
    ? [process.argv[1], "internal-server", "--profile", profile]
    : ["internal-server", "--profile", profile];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
  });
  child.unref();
  return child;
}

function emitStartOutput(result: StartResult, storageDir?: string): void {
  const ui = getOutput();
  if (ui.mode === "json") {
    const out: Record<string, unknown> = {
      ok: true,
      pid: result.pid,
      profile: result.profile,
      port: result.port,
    };
    if (result.reused) out.already = true;
    if (storageDir !== undefined) out.storage = storageDir;
    console.log(JSON.stringify(out));
  } else if (result.reused) {
    uiSuccess(
      `daemon already running (pid ${result.pid}, profile ${result.profile}, port ${result.port})`,
    );
  } else {
    uiSuccess(
      `daemon started (pid ${result.pid}, profile ${result.profile}, port ${result.port})`,
    );
  }
}

/**
 * Acquire daemon lock and spawn a child. If a healthy daemon already holds the
 * lock, returns {reused:true,...}. If the lock dir exists but is stale (dead
 * pid OR no metadata after timeout), forcibly releases and re-acquires.
 *
 * Lock layout: ~/.claude/.shemma-port-<port>.lock/ (dir = mutex via mkdir).
 *   Inside: daemon.pid — JSON {pid, port, startedAt, profile} written by child
 *   after Bun.serve listens. Absent = "parent holds lock, child not ready yet".
 *
 * Failure paths:
 *   - acquire fails AND alive+healthy daemon present → reuse
 *   - acquire fails, no metadata, polling deadline → force-release + retry
 *   - acquire fails, metadata stale (pid dead) → force-release + retry
 *   - spawn succeeds but no healthcheck in time → SIGTERM child + release + error
 */
export async function start(
  profile: Profile,
  opts: StartOpts = {},
): Promise<StartResult> {
  const port = portFor(profile);
  const dir = lockDirFor(port);

  /** Force-release a stale lock dir and reacquire; throws on contention. */
  const forceReacquire = (): void => {
    releaseLock(dir);
    if (!acquireLock(dir)) {
      uiError("daemon-lock-contention");
      throw new Error("daemon-lock-contention");
    }
  };

  if (!acquireLock(dir)) {
    // EEXIST — probe the existing holder.
    const meta = readLockMetadata(dir);
    if (!meta) {
      // Parent holds lock but child hasn't written PID yet. Wait bounded.
      const appeared = await pollFor(
        () => existsSync(path.join(dir, "daemon.pid")),
        ACQUIRE_TIMEOUT_MS,
      );
      if (!appeared) {
        // Stale acquire — force-release and retry once.
        forceReacquire();
      } else {
        const refreshed = readLockMetadata(dir);
        if (refreshed && (await isHealthy(refreshed.port))) {
          const result: StartResult = {
            reused: true,
            pid: refreshed.pid,
            profile,
            port: refreshed.port,
          };
          emitStartOutput(result, opts.storageDir);
          return result;
        }
        forceReacquire();
      }
    } else {
      if (isLockAlive(dir) && (await isHealthy(meta.port))) {
        const result: StartResult = {
          reused: true,
          pid: meta.pid,
          profile,
          port: meta.port,
        };
        emitStartOutput(result, opts.storageDir);
        return result;
      }
      forceReacquire();
    }
  }

  // Lock acquired. Spawn detached child.
  const child = spawnDetached(profile, {
    lockDir: dir,
    port,
    profile,
    storageDir: opts.storageDir,
  });
  if (!child.pid) {
    releaseLock(dir);
    uiError("failed to spawn daemon: no PID");
    throw new Error("failed to spawn daemon: no PID");
  }

  // Wait for child to (1) write PID metadata, (2) pass health check.
  const ready = await pollFor(async () => {
    if (!existsSync(path.join(dir, "daemon.pid"))) return false;
    return isHealthy(port);
  }, ACQUIRE_TIMEOUT_MS);

  if (!ready) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    releaseLock(dir);
    const lf = logFile(profile);
    const msg = `daemon failed to start within 5s; check ${lf}`;
    uiError(msg);
    // Preserve historic CLI exit-code contract: health-timeout = exit 3
    // (declared in usage help-text as "daemon-not-healthy"). The top-level
    // main().catch in index.ts reads `exitCode` off thrown errors.
    const err = new Error(msg) as Error & { exitCode?: number };
    err.exitCode = 3;
    throw err;
  }

  const final = readLockMetadata(dir);
  const childPid = final?.pid ?? child.pid;
  const result: StartResult = {
    reused: false,
    pid: childPid,
    profile,
    port,
  };
  emitStartOutput(result, opts.storageDir);
  return result;
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
  // Fast path: SHEMMA_PORT is set externally (tests / explicit caller override).
  // We must NOT spawn a competing daemon — caller owns the listening server
  // (e.g. in-process Bun.serve in lifecycle.http.test). Just verify health.
  //
  // SHEMMA_PORT_AUTOSET=1 marker (set by index.ts when port was derived from
  // --profile, not externally provided) signals "fast path doesn't apply" —
  // fall through to normal status/start flow. Otherwise post-update restart
  // (cmdUpdate calls stop() then ensure() in the same process where index.ts
  // had already populated SHEMMA_PORT) would exit(3) instead of relaunching.
  const portFromEnv =
    process.env.SHEMMA_PORT !== undefined &&
    process.env.SHEMMA_PORT_AUTOSET !== "1";
  if (portFromEnv) {
    const port = portFor(profile);
    if (await isHealthy(port)) {
      if (verbose) {
        const ui = getOutput();
        if (ui.mode === "json") {
          console.log(
            JSON.stringify({ ok: true, already: true, profile, port }),
          );
        } else {
          uiSuccess(
            `daemon already running (profile ${profile}, port ${port})`,
          );
        }
      }
      maybePrintMcpNudge(verbose);
      return;
    }
    uiError(`shemma: SHEMMA_PORT is set but server not healthy on :${port}`);
    process.exit(3);
  }
  const s = await status(profile);
  if (s.running) {
    if (verbose) {
      const ui = getOutput();
      if (ui.mode === "json") {
        console.log(JSON.stringify({ ok: true, already: true, ...s }));
      } else {
        uiSuccess(
          `daemon already running (pid ${(s as { pid?: number }).pid}, profile ${profile}, port ${(s as { port?: number }).port})`,
        );
      }
    }
    maybePrintMcpNudge(verbose);
    return;
  }
  // start() already polls for health up to 5s and emits its own output;
  // on success the daemon is healthy, on failure it throws.
  await start(profile);
  maybePrintMcpNudge(verbose);
}

/**
 * Best-effort wait for the lock dir to disappear (child removed it on SIGTERM).
 * Returns true if the dir is gone before deadline.
 */
async function waitForLockGone(
  dir: string,
  deadlineMs: number,
): Promise<boolean> {
  return pollFor(() => !existsSync(dir), deadlineMs);
}

/** Resolve graceful shutdown deadline honouring `SHEMMA_GRACEFUL_SHUTDOWN_MS`. */
function gracefulShutdownMs(): number {
  const overrideMs = Number(process.env.SHEMMA_GRACEFUL_SHUTDOWN_MS);
  return Number.isFinite(overrideMs) && overrideMs > 0
    ? overrideMs
    : GRACEFUL_SHUTDOWN_MS;
}

type StopOutcome =
  | { profile: Profile; already: true }
  | { profile: Profile; stopped: number };

/**
 * Stop a single profile's daemon and release its lock dir. Returns an outcome
 * descriptor used by both `stop` (single-profile UI) and `stopAll` (batched).
 *
 * Sequence: SIGTERM → poll for exit up to `gracefulShutdownMs()` → SIGKILL if
 * still alive → wait briefly for lock dir to be removed by the child → force
 * release as fallback (idempotent).
 */
async function stopOneProfile(profile: Profile): Promise<StopOutcome> {
  const port = portFor(profile);
  const dir = lockDirFor(port);
  const meta = readLockMetadata(dir);
  if (!meta) {
    // Lock dir may exist as an "acquire-in-progress" stub; clean it up
    // regardless (releaseLock is idempotent — no-op if absent).
    releaseLock(dir);
    return { profile, already: true };
  }
  try {
    process.kill(meta.pid, "SIGTERM");
  } catch (_) {
    /* already dead */
  }
  // Wait for the child to disappear OR for the lock dir to be removed
  // (the backend removes it on SIGTERM as part of graceful shutdown).
  const deadline = Date.now() + gracefulShutdownMs();
  while (Date.now() < deadline) {
    if (!isAlive(meta.pid)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (isAlive(meta.pid)) {
    try {
      process.kill(meta.pid, "SIGKILL");
    } catch (_) {
      /* ignore */
    }
  }
  // Give the child a tiny extra window to delete the lock dir cleanly, then
  // force-release as a fallback (idempotent).
  await waitForLockGone(dir, 500);
  releaseLock(dir);
  return { profile, stopped: meta.pid };
}

export async function stop(profile: Profile) {
  const ui = getOutput();
  const outcome = await stopOneProfile(profile);
  if ("already" in outcome) {
    if (ui.mode === "json") {
      console.log(JSON.stringify({ ok: true, already: true, profile }));
    } else {
      uiSuccess(`daemon not running (profile ${profile})`);
    }
    return;
  }
  if (ui.mode === "json") {
    console.log(
      JSON.stringify({ ok: true, stopped: outcome.stopped, profile }),
    );
  } else {
    uiSuccess(`daemon stopped (pid ${outcome.stopped}, profile ${profile})`);
  }
}

export type StopAllResult = {
  ok: true;
  profile: Profile;
  stopped?: number;
  already?: boolean;
};

/**
 * Stop daemons across all profiles (or a single one if specified).
 * Idempotent: profiles that are not running produce {ok:true,already:true}.
 * Results are collected, printed as a JSON array and returned (menubar notify).
 */
export async function stopAll(onlyProfile?: Profile): Promise<StopAllResult[]> {
  const profiles = onlyProfile ? [onlyProfile] : [...ALL_PROFILES];
  const results: StopAllResult[] = [];
  for (const p of profiles) {
    const outcome = await stopOneProfile(p);
    if ("already" in outcome) {
      results.push({ ok: true, already: true, profile: p });
    } else {
      results.push({ ok: true, stopped: outcome.stopped, profile: p });
    }
  }
  const ui = getOutput();
  if (ui.mode === "json") {
    console.log(JSON.stringify(results));
  } else {
    for (const r of results) {
      if (r.already) {
        uiSuccess(`daemon not running (profile ${r.profile})`);
      } else {
        uiSuccess(`daemon stopped (pid ${r.stopped}, profile ${r.profile})`);
      }
    }
  }
  return results;
}
