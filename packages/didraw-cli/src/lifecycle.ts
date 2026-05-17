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

export async function exportRoom(
  room: string,
  to: string,
  profile: Profile,
) {
  await ensureSilent(profile);
  const res = await clientFor(profile).exportRoom(room, to);
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function importRoom(
  from: string,
  opts: { as?: string; force?: boolean },
  profile: Profile,
) {
  await ensureSilent(profile);
  const res = await clientFor(profile).importRoom(from, opts);
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function archiveRoom(room: string, profile: Profile) {
  await ensureSilent(profile);
  const res = await clientFor(profile).archiveRoom(room);
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function restoreRoom(room: string, profile: Profile) {
  await ensureSilent(profile);
  const res = await clientFor(profile).restoreRoom(room);
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function rmRoom(
  room: string,
  opts: { confirm?: boolean; archive?: boolean; force?: boolean } = {},
  profile: Profile,
) {
  await ensureSilent(profile);
  if (!opts.confirm) {
    console.error(
      JSON.stringify({ ok: false, error: "expected --confirm flag" }),
    );
    process.exit(1);
  }
  const mode = opts.archive ? "archive" : "hard";
  const res = await clientFor(profile).deleteRoom(room, true, {
    mode,
    force: opts.force,
  });
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function purgeArchive(
  opts: { confirm?: boolean } = {},
  profile: Profile,
) {
  await ensureSilent(profile);
  if (!opts.confirm) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "this is destructive, pass --confirm",
      }),
    );
    process.exit(1);
  }
  const res = await clientFor(profile).purgeArchive();
  console.log(
    JSON.stringify({
      ok: true,
      message: `Purged ${(res as { removed?: number }).removed ?? 0} archived rooms.`,
      removed: (res as { removed?: number }).removed ?? 0,
    }),
  );
}
