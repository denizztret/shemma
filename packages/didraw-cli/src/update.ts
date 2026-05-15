import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail } from "./util";

export const VALID_CHANNELS = ["stable", "nightly", "dev"] as const;
type Channel = (typeof VALID_CHANNELS)[number];

const CONFIG_FILE = join(homedir(), ".claude", ".didraw-config.json");

function manifestUrl(): string {
  return (
    process.env.DIDRAW_MANIFEST_URL ??
    "https://github.com/example/di.draw/releases/download/latest/release-manifest.json"
  );
}

type Config = { channel?: Channel };

function readConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(cfg: Config) {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function semverCmp(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function resolveChannel(): Channel {
  const fromConfig = readConfig().channel;
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.DIDRAW_CHANNEL;
  if (fromEnv && (VALID_CHANNELS as readonly string[]).includes(fromEnv))
    return fromEnv as Channel;
  return "stable";
}

export async function cmdUpdateCheck() {
  const channel = resolveChannel();
  const current = process.env.DIDRAW_VERSION ?? "0.0.0";
  try {
    const r = await fetch(manifestUrl());
    if (!r.ok) throw new Error(`manifest ${r.status}`);
    const m = (await r.json()) as {
      channels?: Record<string, { version?: string }>;
    };
    const latest = m.channels?.[channel]?.version ?? null;
    const available = !!latest && semverCmp(latest, current) > 0;
    console.log(JSON.stringify({ current, latest, available, channel }));
  } catch (e) {
    fail(e);
  }
}

export async function cmdUpdateSetChannel(channel: string) {
  if (!(VALID_CHANNELS as readonly string[]).includes(channel))
    fail(
      `unknown channel "${channel}". Expected one of: ${VALID_CHANNELS.join("|")}`,
    );
  const cfg = readConfig();
  cfg.channel = channel as Channel;
  writeConfig(cfg);
  console.log(JSON.stringify({ ok: true, channel }));
}

export async function cmdUpdate() {
  fail("didraw update implemented in Task 37");
}
