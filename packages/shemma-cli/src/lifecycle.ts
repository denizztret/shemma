import fs, { existsSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath, sep as pathSep } from "node:path";
import { CanvasClient } from "@shemma/client";
import { listSpaces, registerSpace } from "@shemma/spaces";
import { openBrowser } from "./browser";
import { ensureSilent, isHealthy } from "./daemon";
import type { Profile } from "./profile";
import { portFor } from "./profile";
import { ensureStorageDir } from "./storage";
import {
  banner,
  error as uiError,
  getOutput,
  info as uiInfo,
  printResponse,
  responseHasError,
  success as uiSuccess,
} from "./ui";

// DRW-130/DRW-125 gap: lifecycle commands (rooms list/archive/restore/...)
// were never threading the top-level --space flag, so they always shipped
// `?space=__legacy__` and 400'd against space middleware — same root cause
// as the DRW-125 domain-command silent noop. Only `list` is rewired here
// since that's what DRW-130 needs end-to-end; the rest of lifecycle.ts
// stays on the original signature pending DRW-131.
function clientFor(profile: Profile, space?: string): CanvasClient {
  return new CanvasClient({
    baseUrl: `http://localhost:${portFor(profile)}`,
    ...(space !== undefined ? { space } : {}),
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

/**
 * Implements zero-arg `shemma` и `shemma open [<room>]` (DRW-121, replaces
 * pre-DRW-116 storageDir-based flow).
 *
 * Steps:
 *   1. Resolve cwd → registered space (exact path or containing space).
 *      • If matched → open gallery (or room) of that space.
 *      • If unmatched but `.shemma/canvas/` exists at cwd → auto-register
 *        as a project-layout space + open its gallery.
 *      • If `--storage <path>` provided → register as direct-layout (legacy
 *        compat, warns).
 *      • Otherwise (no match, no `.shemma/`, no --storage) → open landing
 *        (`/`) so the user picks/adds a space via the SpacesPage card.
 *   2. Ensure daemon is healthy (singleton — no SHEMMA_STORAGE_DIR leak).
 *   3. Print startup banner + open browser at the resolved URL.
 */
export async function open(profile: Profile, opts: OpenOpts = {}) {
  const cwd = process.cwd();
  const port = portFor(profile);

  let target = await resolveOpenTarget(cwd, opts);

  await ensureSilent(profile);
  let healthy = false;
  for (let i = 0; i < 50; i++) {
    if (await isHealthy(port)) {
      healthy = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!healthy) {
    uiError(`daemon not healthy within 5s on :${port}`, {
      code: `daemon not healthy within 5s on :${port}`,
    });
    process.exit(3);
  }

  const room = opts.room;
  const url = buildTargetUrl(port, target, room);

  // ---- DRW-057: startup banner (human mode only) ----
  await printStartupBanner({
    profile,
    port,
    storage: target.kind === "space" ? target.path : "(no space — landing)",
    room: room ?? (target.kind === "space" ? "(gallery)" : "(landing)"),
    url,
    freshDaemon: false, // singleton daemon — fresh/reused distinction is moot in DRW-121
    noBrowser: !!opts.noBrowser,
  });

  if (!opts.noBrowser) openBrowser(url);

  // JSON mode preserves machine-readable payload (byte-compat-ish).
  const out = getOutput();
  if (out.mode === "json") {
    const result: Record<string, unknown> = {
      ok: true,
      url,
      profile,
      room: room ?? null,
      space: target.kind === "space" ? target.id : null,
      storage: target.kind === "space" ? target.path : null,
    };
    if (opts.noBrowser) result.browser = false;
    process.stdout.write(JSON.stringify(result) + "\n");
  }
}

type OpenTarget =
  | { kind: "space"; id: string; path: string }
  | { kind: "landing" };

async function resolveOpenTarget(cwd: string, opts: OpenOpts): Promise<OpenTarget> {
  const cwdReal = existsSync(cwd) ? fs.realpathSync(cwd) : resolvePath(cwd);

  // Legacy --storage / SHEMMA_STORAGE_DIR explicit path.
  if (opts.storage || process.env.SHEMMA_STORAGE_DIR) {
    const explicit = opts.storage ?? process.env.SHEMMA_STORAGE_DIR!;
    const abs = isAbsolute(explicit) ? explicit : resolvePath(cwd, explicit);
    const mkdirErr = ensureStorageDir(abs);
    if (mkdirErr) {
      uiError(mkdirErr, { code: mkdirErr });
      process.exit(1);
    }
    try {
      const { space } = registerSpace(abs, { storageLayout: "direct" });
      return { kind: "space", id: space.id, path: space.path };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      uiError(`failed to register storage path: ${msg}`);
      process.exit(1);
    }
  }

  // cwd → registered-space lookup (exact path or containing).
  const match = listSpaces().find((s) => {
    if (s.path === cwdReal) return true;
    const sPath = s.path.endsWith(pathSep) ? s.path : s.path + pathSep;
    return cwdReal.startsWith(sPath);
  });
  if (match) return { kind: "space", id: match.id, path: match.path };

  // cwd not registered but has a gallery → auto-register as project-layout.
  if (existsSync(join(cwdReal, ".shemma", "canvas"))) {
    try {
      const { space } = registerSpace(cwdReal);
      uiInfo(`registered current directory as space '${space.id}'`);
      return { kind: "space", id: space.id, path: space.path };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      uiError(`failed to register cwd as space: ${msg}`);
      process.exit(1);
    }
  }

  // No space here — land on the SpacesPage so the user adds one explicitly.
  return { kind: "landing" };
}

function buildTargetUrl(port: number, target: OpenTarget, room?: string): string {
  if (target.kind === "landing") return `http://localhost:${port}/`;
  const space = encodeURIComponent(target.id);
  return room
    ? `http://localhost:${port}/?space=${space}&room=${encodeURIComponent(room)}`
    : `http://localhost:${port}/?space=${space}`;
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

// DRW-130 (P2.6): `shemma rooms list` used to print `✔ ok` in friendly mode
// because the generic `printResponse` doesn't know how to render an array.
// Render a small table here instead, scoped to the rooms shape:
//   { ok: true, rooms: [{id, version, elementCount, lastTouched, archived?}],
//     dir: string }
type RoomListItem = {
  id: string;
  version: number;
  elementCount: number;
  lastTouched: string;
  schemaVersion?: number;
  archived?: boolean;
  linkedSession?: string;
  projectDir?: string;
  projectName?: string;
};
type RoomListRes = {
  ok?: boolean;
  rooms?: RoomListItem[];
  dir?: string;
  error?: string;
};

function relativeTime(iso: string, nowMs = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Math.max(0, nowMs - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return iso.slice(0, 10);
}

function renderRoomsTable(rooms: RoomListItem[]): string {
  const headers = ["id", "version", "elements", "last touched"];
  const rows = rooms.map((r) => [
    r.id + (r.archived ? " (archived)" : ""),
    String(r.version),
    String(r.elementCount),
    relativeTime(r.lastTouched),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const pad = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("  ");
  return [pad(headers), sep, ...rows.map(pad)].join("\n");
}

export async function list(profile: Profile, space?: string) {
  await ensureSilent(profile);
  const res = (await clientFor(profile, space).listRooms()) as RoomListRes;
  const ui = getOutput();
  if (ui.mode === "json") {
    process.stdout.write(JSON.stringify(res) + "\n");
    if (responseHasError(res)) process.exit(1);
    return;
  }
  if (responseHasError(res)) {
    printResponse(res);
    process.exit(1);
  }
  const rooms = res.rooms ?? [];
  if (rooms.length === 0) {
    uiInfo(`no rooms in this space${res.dir ? ` (storage: ${res.dir})` : ""}`);
    return;
  }
  uiSuccess(`${rooms.length} room${rooms.length === 1 ? "" : "s"}${res.dir ? ` (storage: ${res.dir})` : ""}`);
  process.stdout.write(`${renderRoomsTable(rooms)}\n`);
}

// DRW-131: thread top-level --space through every room-management command.
// Pattern: receive optional `space`, hand to clientFor(profile, space), then
// use responseHasError (DRW-125) so middleware envelopes without `ok` exit 1
// in both JSON and human modes — same symmetry as domain commands.
export async function exportRoom(
  room: string,
  to: string,
  profile: Profile,
  space?: string,
) {
  await ensureSilent(profile);
  const res = await clientFor(profile, space).exportRoom(room, to);
  printResponse(res, { humanSuccess: `exported room "${room}" → ${to}` });
  if (responseHasError(res)) process.exit(1);
}

export async function importRoom(
  from: string,
  opts: { as?: string; force?: boolean },
  profile: Profile,
  space?: string,
) {
  await ensureSilent(profile);
  const res = await clientFor(profile, space).importRoom(from, opts);
  printResponse(res, { humanSuccess: `imported room from ${from}` });
  if (responseHasError(res)) process.exit(1);
}

export async function archiveRoom(room: string, profile: Profile, space?: string) {
  await ensureSilent(profile);
  const res = await clientFor(profile, space).archiveRoom(room);
  printResponse(res, { humanSuccess: `archived room "${room}"` });
  if (responseHasError(res)) process.exit(1);
}

export async function restoreRoom(room: string, profile: Profile, space?: string) {
  await ensureSilent(profile);
  const res = await clientFor(profile, space).restoreRoom(room);
  printResponse(res, { humanSuccess: `restored room "${room}"` });
  if (responseHasError(res)) process.exit(1);
}

export async function rmRoom(
  room: string,
  opts: { confirm?: boolean; archive?: boolean; force?: boolean } = {},
  profile: Profile,
  space?: string,
) {
  await ensureSilent(profile);
  if (!opts.confirm) dieRequireFlag("expected --confirm flag");
  const mode = opts.archive ? "archive" : "hard";
  const res = await clientFor(profile, space).deleteRoom(room, true, {
    mode,
    force: opts.force,
  });
  printResponse(res, { humanSuccess: `removed room "${room}"` });
  if (responseHasError(res)) process.exit(1);
}

export async function renameRoom(
  oldId: string,
  newId: string,
  opts: { force?: boolean } = {},
  profile: Profile,
  space?: string,
) {
  await ensureSilent(profile);
  const res = await clientFor(profile, space).renameRoom(oldId, newId, opts);
  printResponse(res, { humanSuccess: `renamed "${oldId}" → "${newId}"` });
  if (responseHasError(res)) process.exit(1);
}

export async function duplicateRoom(
  id: string,
  as: string,
  profile: Profile,
  space?: string,
) {
  await ensureSilent(profile);
  const res = await clientFor(profile, space).duplicateRoom(id, as);
  printResponse(res, { humanSuccess: `duplicated "${id}" → "${as}"` });
  if (responseHasError(res)) process.exit(1);
}

export async function duplicateRoomAuto(
  id: string,
  profile: Profile,
  space?: string,
) {
  await ensureSilent(profile);
  const res = await clientFor(profile, space).duplicateAuto(id);
  printResponse(res, { humanSuccess: `duplicated "${id}"` });
  if (responseHasError(res)) process.exit(1);
}

export async function purgeArchive(
  opts: { confirm?: boolean } = {},
  profile: Profile,
  space?: string,
) {
  await ensureSilent(profile);
  if (!opts.confirm) dieRequireFlag("this is destructive, pass --confirm");
  const res = await clientFor(profile, space).purgeArchive();
  if (responseHasError(res)) {
    printResponse(res);
    process.exit(1);
  }
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
