import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { CanvasClient } from "@shemma/client";
import { openBrowser } from "./browser";
import { ensureSilent, isHealthy, start } from "./daemon";
import { getRunningDaemonStorage } from "./ps";
import type { Profile } from "./profile";
import { portFor } from "./profile";
import {
  type OpenStorageResolution,
  ensureStorageDir,
  resolveStorageForOpen,
} from "./storage";
import {
  banner,
  error as uiError,
  getOutput,
  info as uiInfo,
  printResponse,
  success as uiSuccess,
} from "./ui";

function clientFor(profile: Profile): CanvasClient {
  return new CanvasClient({
    baseUrl: `http://localhost:${portFor(profile)}`,
  });
}

function dieRequireFlag(error: string): never {
  uiError(error, { code: error });
  process.exit(1);
}

export type OpenOpts = {
  /** Optional room override. Default = "default". */
  room?: string;
  /** Explicit `--storage <path>` arg. Wins over env + auto-cwd. */
  storage?: string;
  /** Suppress browser launch (used by CI/tests + headless flows). */
  noBrowser?: boolean;
};

// ---------------------------------------------------------------------------
// Interactive prompt for missing .shemma/ (DRW-058)
// ---------------------------------------------------------------------------

/**
 * Returns true if shemma should run an interactive prompt when `.shemma/` is
 * missing in cwd. False for non-TTY (CI / piped / agent invocations).
 *
 * Both stdin AND stdout must be TTY: stdin alone-TTY would let prompts read,
 * but if stdout is piped we'd swallow the prompt output too. Both-or-nothing
 * matches conventional CLI prompt behaviour.
 */
function isInteractive(): boolean {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Run the interactive 3-option prompt when `.shemma/` is missing in cwd.
 * Returns the user-chosen base path (absolute) or null if cancelled.
 *
 * Re-prompts on empty input up to 3 times; Ctrl-C / EOF / 3-empty-tries → null.
 */
async function promptForMissingStorage(cwd: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\nNo .shemma/ in current directory: ${cwd}\n\n`);
    process.stdout.write(`What to do?\n`);
    process.stdout.write(`  [1] Create .shemma/ here\n`);
    process.stdout.write(`  [2] Specify storage path\n`);
    process.stdout.write(`  [3] Cancel\n\n`);

    for (let attempt = 0; attempt < 3; attempt++) {
      let answer: string;
      try {
        answer = (await rl.question("> ")).trim();
      } catch {
        // EOF / Ctrl-C
        return null;
      }
      if (answer === "1") {
        return join(cwd, ".shemma");
      }
      if (answer === "2") {
        let path: string;
        try {
          path = (await rl.question("Storage path: ")).trim();
        } catch {
          return null;
        }
        if (!path) return null;
        return isAbsolute(path) ? path : resolvePath(cwd, path);
      }
      if (answer === "3") {
        return null;
      }
      if (answer === "") {
        // re-prompt up to 3 attempts
        continue;
      }
      process.stdout.write(`Please enter 1, 2, or 3.\n`);
    }
    return null;
  } finally {
    rl.close();
  }
}

/**
 * Implements zero-arg `shemma` и `shemma open [<room>]` (DRW-052 / DRW-056/057/058).
 *
 * Steps:
 *   1. Resolve target storage (--storage > SHEMMA_STORAGE_DIR > cwd/.shemma)
 *   2. Detect missing-`.shemma/` in cwd → prompt (TTY) or fail-fast (non-TTY)
 *   3. Auto-create storage dir (`<base>/canvas` или `canvas-dev`)
 *   4. Check для running-daemon-on-other-storage → exit 1 conflict
 *   5. If no daemon → start with resolved storage + wait until healthy
 *   6. Print startup banner + open browser (unless --no-browser)
 */
export async function open(profile: Profile, opts: OpenOpts = {}) {
  const cwd = process.cwd();
  let resolution = resolveStorageForOpen(
    { explicit: opts.storage },
    cwd,
    // Legacy compat: accept DIDRAW_STORAGE_DIR (pre-0.10.0) as fallback.
    { SHEMMA_STORAGE_DIR: process.env.SHEMMA_STORAGE_DIR ?? process.env.DIDRAW_STORAGE_DIR },
    profile,
  );

  // DRW-058: when source is "auto-cwd" AND .shemma/ doesn't exist, gate behind
  // a confirmation step. Explicit --storage / env path → skip (user already
  // chose a target). Existing .shemma/ → silent reuse.
  if (resolution.source === "auto-cwd" && !existsSync(resolution.base)) {
    if (isInteractive()) {
      const chosen = await promptForMissingStorage(cwd);
      if (chosen === null) {
        uiError("cancelled by user");
        process.exit(1);
      }
      // Re-resolve using the chosen path as explicit base.
      resolution = resolveStorageForOpen({ explicit: chosen }, cwd, {}, profile);
    } else {
      uiError(`no .shemma/ directory in ${cwd}`, {
        code: "no-storage",
        hint: [
          "run with --storage <path> or SHEMMA_STORAGE_DIR=<path>",
          "or run 'shemma init' to create .shemma/ here",
        ],
      });
      process.exit(1);
    }
  }

  // Best-effort mkdir. Bail out with structured error if FS rejects.
  const mkdirErr = ensureStorageDir(resolution.storageDir);
  if (mkdirErr) {
    uiError(mkdirErr, { code: mkdirErr });
    process.exit(1);
  }

  // Conflict detection: если daemon уже запущен на другом storage —
  // exit 1 с понятным error. См. spec variant C.
  const running = await getRunningDaemonStorage(profile);
  if (running !== null) {
    const runningAbs = resolvePath(running);
    const targetAbs = resolvePath(resolution.storageDir);
    if (runningAbs !== targetAbs) {
      uiError(`daemon already running on storage "${runningAbs}"`, {
        code: "daemon-conflict",
        data: {
          running: runningAbs,
          target: targetAbs,
          profile,
        },
        hint: `run 'shemma daemon stop --profile ${profile}' first`,
      });
      process.exit(1);
    }
  }

  // Info-log на cwd-auto, чтобы user видел "doski этого проекта живут здесь".
  if (resolution.source === "auto-cwd") {
    uiInfo(`using local storage: ${resolution.base}`);
  }

  // Ensure daemon. Если уже healthy с тем же storage — no-op.
  // Если нет — spawn с resolved storage path.
  const freshDaemon = running === null;
  if (freshDaemon) {
    await start(profile, { storageDir: resolution.storageDir });
    // Wait for health (poll up to 5s — same as ensureDaemon).
    const port = portFor(profile);
    let healthy = false;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (await isHealthy(port)) {
        healthy = true;
        break;
      }
    }
    if (!healthy) {
      uiError(`daemon not healthy within 5s on :${port}`, {
        code: `daemon not healthy within 5s on :${port}`,
      });
      process.exit(3);
    }
  }

  const room = opts.room ?? "default";
  const port = portFor(profile);
  const url = `http://localhost:${port}/?room=${encodeURIComponent(room)}`;
  const storageAbs = resolvePath(resolution.storageDir);

  // ---- DRW-057: startup banner (human mode only) ----
  await printStartupBanner({
    profile,
    port,
    storage: storageAbs,
    room,
    url,
    freshDaemon,
    noBrowser: !!opts.noBrowser,
  });

  if (!opts.noBrowser) openBrowser(url);

  // JSON mode preserves the pre-Group-A machine-readable payload (byte-compat).
  const out = getOutput();
  if (out.mode === "json") {
    const result: Record<string, unknown> = {
      ok: true,
      url,
      profile,
      room,
      storage: storageAbs,
      storageSource: resolution.source,
    };
    if (opts.noBrowser) result.browser = false;
    process.stdout.write(JSON.stringify(result) + "\n");
  }
}

interface StartupBannerOpts {
  profile: Profile;
  port: number;
  storage: string;
  room: string;
  url: string;
  freshDaemon: boolean;
  noBrowser: boolean;
}

async function printStartupBanner(opts: StartupBannerOpts): Promise<void> {
  const out = getOutput();
  if (out.mode === "json") return; // banner suppressed in JSON mode

  // Resolve current version. Compiled binaries have SHEMMA_VERSION injected;
  // dev/source falls back to package.json (or "0.0.0-dev").
  let version = process.env.SHEMMA_VERSION;
  if (!version) {
    try {
      const pkg = await import("../package.json", { with: { type: "json" } });
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import
      version = ((pkg as any).default ?? pkg).version;
    } catch {
      version = undefined;
    }
  }
  const versionLabel = version && version !== "unknown" ? `v${version}` : "(dev)";

  const lines: Parameters<typeof banner>[0] = [];
  lines.push({
    kind: "headline",
    text: `shemma ${versionLabel} [${opts.profile}] listening on http://localhost:${opts.port}`,
  });
  lines.push({ kind: "kv", key: "storage:", value: opts.storage });
  lines.push({ kind: "kv", key: "room:", value: opts.room });

  // Fresh vs reused daemon distinction.
  if (opts.freshDaemon) {
    lines.push({ kind: "info", text: "daemon started" });
  } else {
    lines.push({ kind: "info", text: "daemon already running" });
  }

  // Update line (best-effort; failures silenced).
  const update = await checkForUpdateSilent();
  if (update) {
    lines.push({ kind: "update", text: update });
  }

  if (!opts.noBrowser) {
    lines.push({ kind: "action", text: `opening ${opts.url}` });
  }
  banner(lines);
}

/**
 * Returns a brief "update available: vX.Y.Z (run 'shemma update')" line, or
 * `null` if no update / unreachable / errored. Best-effort, никогда не throws.
 */
async function checkForUpdateSilent(): Promise<string | null> {
  try {
    const mod = await import("../../../apps/backend/src/update-check");
    const r = await mod.checkLatest();
    if (r.updateAvailable && r.latest) {
      return `update available: v${r.latest} (run 'shemma update')`;
    }
  } catch {
    // ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// `shemma init [<path>]` — non-interactive bootstrap (DRW-058 bonus)
// ---------------------------------------------------------------------------

export function cmdInit(targetArg?: string): void {
  const cwd = process.cwd();
  const target = targetArg
    ? isAbsolute(targetArg)
      ? targetArg
      : resolvePath(cwd, targetArg)
    : cwd;
  const base = target.endsWith(".shemma") ? target : join(target, ".shemma");
  const err = ensureStorageDir(base);
  if (err) {
    uiError(err, { code: err });
    process.exit(1);
  }
  uiSuccess(`initialized .shemma/ in ${base}`, { ok: true, path: base });
}

/**
 * Internal export — used by tests to verify resolution без side-effects.
 */
export function _resolveOpenStorage(
  opts: { storage?: string },
  cwd: string,
  env: { SHEMMA_STORAGE_DIR?: string | undefined },
  profile: Profile,
): OpenStorageResolution {
  return resolveStorageForOpen({ explicit: opts.storage }, cwd, env, profile);
}

export async function list(profile: Profile) {
  await ensureSilent(profile);
  const res = await clientFor(profile).listRooms();
  printResponse(res, { humanSuccess: "ok" });
}

export async function exportRoom(room: string, to: string, profile: Profile) {
  await ensureSilent(profile);
  const res = await clientFor(profile).exportRoom(room, to);
  printResponse(res, { humanSuccess: `exported room "${room}" → ${to}` });
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function importRoom(
  from: string,
  opts: { as?: string; force?: boolean },
  profile: Profile,
) {
  await ensureSilent(profile);
  const res = await clientFor(profile).importRoom(from, opts);
  printResponse(res, { humanSuccess: `imported room from ${from}` });
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function archiveRoom(room: string, profile: Profile) {
  await ensureSilent(profile);
  const res = await clientFor(profile).archiveRoom(room);
  printResponse(res, { humanSuccess: `archived room "${room}"` });
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function restoreRoom(room: string, profile: Profile) {
  await ensureSilent(profile);
  const res = await clientFor(profile).restoreRoom(room);
  printResponse(res, { humanSuccess: `restored room "${room}"` });
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function rmRoom(
  room: string,
  opts: { confirm?: boolean; archive?: boolean; force?: boolean } = {},
  profile: Profile,
) {
  await ensureSilent(profile);
  if (!opts.confirm) dieRequireFlag("expected --confirm flag");
  const mode = opts.archive ? "archive" : "hard";
  const res = await clientFor(profile).deleteRoom(room, true, {
    mode,
    force: opts.force,
  });
  printResponse(res, { humanSuccess: `removed room "${room}"` });
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function renameRoom(
  oldId: string,
  newId: string,
  opts: { force?: boolean } = {},
  profile: Profile,
) {
  await ensureSilent(profile);
  const res = await clientFor(profile).renameRoom(oldId, newId, opts);
  printResponse(res, { humanSuccess: `renamed "${oldId}" → "${newId}"` });
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function duplicateRoom(id: string, as: string, profile: Profile) {
  await ensureSilent(profile);
  const res = await clientFor(profile).duplicateRoom(id, as);
  printResponse(res, { humanSuccess: `duplicated "${id}" → "${as}"` });
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function duplicateRoomAuto(id: string, profile: Profile) {
  await ensureSilent(profile);
  const res = await clientFor(profile).duplicateAuto(id);
  printResponse(res, { humanSuccess: `duplicated "${id}"` });
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function purgeArchive(
  opts: { confirm?: boolean } = {},
  profile: Profile,
) {
  await ensureSilent(profile);
  if (!opts.confirm) dieRequireFlag("this is destructive, pass --confirm");
  const res = await clientFor(profile).purgeArchive();
  const removed = (res as { removed?: number }).removed ?? 0;
  const out = getOutput();
  if (out.mode === "json") {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        message: `Purged ${removed} archived rooms.`,
        removed,
      }) + "\n",
    );
  } else {
    uiSuccess(`Purged ${removed} archived rooms.`);
  }
}
