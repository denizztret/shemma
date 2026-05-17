import { resolve as resolvePath } from "node:path";
import { CanvasClient } from "@didraw/client";
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

function clientFor(profile: Profile): CanvasClient {
  return new CanvasClient({
    baseUrl: `http://localhost:${portFor(profile)}`,
  });
}

// Print response JSON; exit(1) if the backend reported ok:false.
function printAndExitOnFail(res: unknown): void {
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

function dieRequireFlag(error: string): never {
  console.error(JSON.stringify({ ok: false, error }));
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

/**
 * Implements zero-arg `didraw` и `didraw open [<room>]` (DRW-052).
 *
 * Steps:
 *   1. Resolve target storage (--storage > DIDRAW_STORAGE_DIR > cwd/.didraw)
 *   2. Auto-create storage dir (`<base>/canvas` или `canvas-dev`)
 *   3. Check для running-daemon-on-other-storage → exit 1 conflict
 *   4. If no daemon → start with resolved storage + wait until healthy
 *   5. Print info line + open browser (unless --no-browser)
 */
export async function open(profile: Profile, opts: OpenOpts = {}) {
  const cwd = process.cwd();
  const resolution = resolveStorageForOpen(
    { explicit: opts.storage },
    cwd,
    { DIDRAW_STORAGE_DIR: process.env.DIDRAW_STORAGE_DIR },
    profile,
  );

  // Best-effort mkdir. Bail out with structured error if FS rejects.
  const mkdirErr = ensureStorageDir(resolution.storageDir);
  if (mkdirErr) {
    console.error(JSON.stringify({ ok: false, error: mkdirErr }));
    process.exit(1);
  }

  // Conflict detection: если daemon уже запущен на другом storage —
  // exit 1 с понятным error. См. spec variant C.
  const running = await getRunningDaemonStorage(profile);
  if (running !== null) {
    const runningAbs = resolvePath(running);
    const targetAbs = resolvePath(resolution.storageDir);
    if (runningAbs !== targetAbs) {
      const payload = {
        ok: false,
        error: "daemon-conflict",
        running: runningAbs,
        target: targetAbs,
        profile,
      };
      console.error(JSON.stringify(payload));
      console.error(
        `daemon already running on storage "${runningAbs}"; expected "${targetAbs}". Run 'didraw daemon stop' first.`,
      );
      process.exit(1);
    }
  }

  // Info-log на cwd-auto, чтобы user видел "doski этого проекта живут здесь".
  if (resolution.source === "auto-cwd") {
    console.error(`[didraw] using local storage: ${resolution.base}`);
  }

  // Ensure daemon. Если уже healthy с тем же storage — no-op.
  // Если нет — spawn с resolved storage path.
  if (running === null) {
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
      console.error(
        JSON.stringify({
          ok: false,
          error: `daemon not healthy within 5s on :${port}`,
        }),
      );
      process.exit(3);
    }
  }

  const room = opts.room ?? "default";
  const url = `http://localhost:${portFor(profile)}/?room=${encodeURIComponent(room)}`;
  if (!opts.noBrowser) openBrowser(url);

  const result: Record<string, unknown> = {
    ok: true,
    url,
    profile,
    room,
    storage: resolvePath(resolution.storageDir),
    storageSource: resolution.source,
  };
  if (opts.noBrowser) result.browser = false;
  console.log(JSON.stringify(result));
}

/**
 * Internal export — used by tests to verify resolution без side-effects.
 */
export function _resolveOpenStorage(
  opts: { storage?: string },
  cwd: string,
  env: { DIDRAW_STORAGE_DIR?: string | undefined },
  profile: Profile,
): OpenStorageResolution {
  return resolveStorageForOpen({ explicit: opts.storage }, cwd, env, profile);
}

export async function list(profile: Profile) {
  await ensureSilent(profile);
  const res = await clientFor(profile).listRooms();
  console.log(JSON.stringify(res));
}

export async function exportRoom(room: string, to: string, profile: Profile) {
  await ensureSilent(profile);
  printAndExitOnFail(await clientFor(profile).exportRoom(room, to));
}

export async function importRoom(
  from: string,
  opts: { as?: string; force?: boolean },
  profile: Profile,
) {
  await ensureSilent(profile);
  printAndExitOnFail(await clientFor(profile).importRoom(from, opts));
}

export async function archiveRoom(room: string, profile: Profile) {
  await ensureSilent(profile);
  printAndExitOnFail(await clientFor(profile).archiveRoom(room));
}

export async function restoreRoom(room: string, profile: Profile) {
  await ensureSilent(profile);
  printAndExitOnFail(await clientFor(profile).restoreRoom(room));
}

export async function rmRoom(
  room: string,
  opts: { confirm?: boolean; archive?: boolean; force?: boolean } = {},
  profile: Profile,
) {
  await ensureSilent(profile);
  if (!opts.confirm) dieRequireFlag("expected --confirm flag");
  const mode = opts.archive ? "archive" : "hard";
  printAndExitOnFail(
    await clientFor(profile).deleteRoom(room, true, {
      mode,
      force: opts.force,
    }),
  );
}

export async function renameRoom(
  oldId: string,
  newId: string,
  opts: { force?: boolean } = {},
  profile: Profile,
) {
  await ensureSilent(profile);
  printAndExitOnFail(await clientFor(profile).renameRoom(oldId, newId, opts));
}

export async function duplicateRoom(id: string, as: string, profile: Profile) {
  await ensureSilent(profile);
  printAndExitOnFail(await clientFor(profile).duplicateRoom(id, as));
}

export async function duplicateRoomAuto(id: string, profile: Profile) {
  await ensureSilent(profile);
  printAndExitOnFail(await clientFor(profile).duplicateAuto(id));
}

export async function purgeArchive(
  opts: { confirm?: boolean } = {},
  profile: Profile,
) {
  await ensureSilent(profile);
  if (!opts.confirm) dieRequireFlag("this is destructive, pass --confirm");
  const res = await clientFor(profile).purgeArchive();
  const removed = (res as { removed?: number }).removed ?? 0;
  console.log(
    JSON.stringify({
      ok: true,
      message: `Purged ${removed} archived rooms.`,
      removed,
    }),
  );
}
