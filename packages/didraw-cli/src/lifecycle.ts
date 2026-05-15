import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { getConfig } from "@didraw/backend/src/config";
import { ensure } from "./daemon";
import type { Profile } from "./profile";
import { portFor } from "./profile";

const canvasDir = () => getConfig().storageDir;

export async function open(room: string, profile: Profile) {
  await ensure(profile);
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

export function list() {
  const dir = canvasDir();
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    console.log(
      JSON.stringify({
        ok: true,
        rooms: files.map((f) => f.replace(/\.json$/, "")),
        dir,
      }),
    );
  } catch {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    console.log(JSON.stringify({ ok: true, rooms: [], dir }));
  }
}

export function exportRoom(room: string, to: string) {
  const src = join(canvasDir(), `${room}.json`);
  if (!existsSync(src)) {
    console.error(JSON.stringify({ ok: false, error: "not found" }));
    process.exit(2);
  }
  copyFileSync(src, to);
  console.log(JSON.stringify({ ok: true, from: src, to }));
}

export function rmRoom(room: string, opts: { confirm?: boolean } = {}) {
  const p = join(canvasDir(), `${room}.json`);
  if (!existsSync(p)) {
    console.error(JSON.stringify({ ok: false, error: "not found" }));
    process.exit(2);
  }
  if (!opts.confirm) {
    console.error(
      JSON.stringify({ ok: false, error: "expected --confirm flag" }),
    );
    process.exit(1);
  }
  unlinkSync(p);
  console.log(JSON.stringify({ ok: true, deleted: room }));
}
