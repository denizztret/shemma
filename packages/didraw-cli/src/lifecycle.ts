import { spawn } from "node:child_process";
import { CanvasClient } from "@didraw/client";
import { ensureSilent } from "./daemon";
import type { Profile } from "./profile";
import { portFor } from "./profile";

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

export async function open(room: string, profile: Profile) {
  await ensureSilent(profile);
  const url = `http://localhost:${portFor(profile)}/?room=${encodeURIComponent(room)}`;
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  console.log(JSON.stringify({ ok: true, url, profile }));
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
