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
import { CanvasClient } from "@shemma/client";

const GRACEFUL_SHUTDOWN_MS = 2000; // matches backend default; override via SHEMMA_GRACEFUL_SHUTDOWN_MS
const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

import { type Profile, ALL_PROFILES, logFile, pidFile, portFor } from "./profile";
import { error as uiError, getOutput, success as uiSuccess } from "./ui";

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
   * Если задан — exported в child env как SHEMMA_STORAGE_DIR, overriding ambient env.
   */
  storageDir?: string;
};

export async function start(profile: Profile, opts: StartOpts = {}) {
  const s = await status(profile);
  if (s.running) {
    const ui = getOutput();
    if (ui.mode === "json") {
      console.log(JSON.stringify({ ok: true, already: true, ...s }));
    } else {
      uiSuccess(
        `daemon already running (pid ${(s as { pid?: number }).pid}, profile ${profile}, port ${(s as { port?: number }).port})`,
      );
    }
    return;
  }
  const port = portFor(profile);
  const lf = logFile(profile);
  rotateLogIfNeeded(lf);
  const logFd = openSync(lf, "a");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SHEMMA_PROFILE: profile,
    SHEMMA_PORT: String(port),
  };
  // Explicit --storage wins over ambient SHEMMA_STORAGE_DIR.
  if (opts.storageDir !== undefined) {
    env.SHEMMA_STORAGE_DIR = opts.storageDir;
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
  if (!child.pid) {
    uiError("failed to spawn daemon: no PID");
    process.exit(1);
  }
  writeFileSync(pidFile(profile), String(child.pid));
  const ui = getOutput();
  if (ui.mode === "json") {
    const out: Record<string, unknown> = { ok: true, pid: child.pid, profile, port };
    if (opts.storageDir !== undefined) out.storage = opts.storageDir;
    console.log(JSON.stringify(out));
  } else {
    uiSuccess(`daemon started (pid ${child.pid}, profile ${profile}, port ${port})`);
  }
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
          console.log(JSON.stringify({ ok: true, already: true, profile, port }));
        } else {
          uiSuccess(`daemon already running (profile ${profile}, port ${port})`);
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
  await start(profile);
  const port = portFor(profile);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isHealthy(port)) {
      maybePrintMcpNudge(verbose);
      return;
    }
  }
  uiError(`shemma: not healthy within 5s on :${port}`);
  process.exit(3);
}

export async function stop(profile: Profile) {
  const ui = getOutput();
  const file = pidFile(profile);
  if (!existsSync(file)) {
    if (ui.mode === "json") {
      console.log(JSON.stringify({ ok: true, already: true, profile }));
    } else {
      uiSuccess(`daemon not running (profile ${profile})`);
    }
    return;
  }
  const pid = Number(readFileSync(file, "utf8"));
  try {
    process.kill(pid, "SIGTERM");
  } catch (_) {}
  const overrideMs = Number(process.env.SHEMMA_GRACEFUL_SHUTDOWN_MS);
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
  if (ui.mode === "json") {
    console.log(JSON.stringify({ ok: true, stopped: pid, profile }));
  } else {
    uiSuccess(`daemon stopped (pid ${pid}, profile ${profile})`);
  }
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
    const overrideMs = Number(process.env.SHEMMA_GRACEFUL_SHUTDOWN_MS);
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
  const ui = getOutput();
  if (ui.mode === "json") {
    console.log(JSON.stringify(results));
  } else {
    for (const r of results) {
      const e = r as { already?: boolean; stopped?: number; profile: Profile };
      if (e.already) {
        uiSuccess(`daemon not running (profile ${e.profile})`);
      } else {
        uiSuccess(`daemon stopped (pid ${e.stopped}, profile ${e.profile})`);
      }
    }
  }
}
