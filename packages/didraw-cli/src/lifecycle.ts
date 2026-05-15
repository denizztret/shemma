import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
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
  const src = `${canvasDir()}/${room}.json`;
  if (!existsSync(src)) {
    console.error(JSON.stringify({ ok: false, error: "not found" }));
    process.exit(2);
  }
  copyFileSync(src, to);
  console.log(JSON.stringify({ ok: true, from: src, to }));
}

export async function rmRoom(room: string) {
  const p = `${canvasDir()}/${room}.json`;
  if (!existsSync(p)) {
    console.error(JSON.stringify({ ok: false, error: "not found" }));
    process.exit(2);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = await rl.question(
    `Delete ${room} (profile=${getConfig().profile})? [y/N] `,
  );
  rl.close();
  if (ans.toLowerCase() === "y") {
    unlinkSync(p);
    console.log(JSON.stringify({ ok: true, deleted: room }));
  } else console.log(JSON.stringify({ ok: false, error: "cancelled" }));
}
