import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { arch, homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensure, stop } from "./daemon";
import { parseProfile } from "./profile";
import { fail } from "./util";
import { getOutput, success as uiSuccess } from "./ui";

export const VALID_CHANNELS = ["stable", "nightly", "dev"] as const;
type Channel = (typeof VALID_CHANNELS)[number];

function isChannel(s: string): s is Channel {
  return (VALID_CHANNELS as readonly string[]).includes(s);
}

const CURRENT_VERSION = process.env.SHEMMA_VERSION ?? "0.0.0";

const CONFIG_FILE = join(homedir(), ".claude", ".shemma-config.json");

function manifestUrl(): string {
  return (
    process.env.SHEMMA_MANIFEST_URL ??
    "https://github.com/example/shemma/releases/download/latest/release-manifest.json"
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
  // Strip pre-release/build suffix (e.g. "0.0.0-dev") so split(".").map(Number)
  // doesn't produce NaN — release-channel never compares pre-release ordering.
  const [ax] = a.split("-");
  const [bx] = b.split("-");
  const pa = ax.split(".").map(Number);
  const pb = bx.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function resolveChannel(): Channel {
  const fromConfig = readConfig().channel;
  if (fromConfig && isChannel(fromConfig)) return fromConfig;
  const fromEnv = process.env.SHEMMA_CHANNEL;
  if (fromEnv && isChannel(fromEnv)) return fromEnv;
  return "stable";
}

export async function cmdUpdateCheck() {
  const channel = resolveChannel();
  try {
    const r = await fetch(manifestUrl());
    if (!r.ok) throw new Error(`manifest ${r.status}`);
    const m = (await r.json()) as {
      channels?: Record<string, { version?: string }>;
    };
    const latest = m.channels?.[channel]?.version ?? null;
    const available = !!latest && semverCmp(latest, CURRENT_VERSION) > 0;
    const ui = getOutput();
    if (ui.mode === "json") {
      console.log(
        JSON.stringify({ current: CURRENT_VERSION, latest, available, channel }),
      );
    } else if (available) {
      uiSuccess(`update available: v${latest} (current v${CURRENT_VERSION}, channel ${channel})`);
    } else {
      uiSuccess(`already on latest v${CURRENT_VERSION} (channel ${channel})`);
    }
  } catch (e) {
    fail(e);
  }
}

export async function cmdUpdateSetChannel(channel: string) {
  if (!isChannel(channel))
    fail(
      `unknown channel "${channel}". Expected one of: ${VALID_CHANNELS.join("|")}`,
    );
  const cfg = readConfig();
  cfg.channel = channel;
  writeConfig(cfg);
  const ui = getOutput();
  if (ui.mode === "json") {
    console.log(JSON.stringify({ ok: true, channel }));
  } else {
    uiSuccess(`channel set to "${channel}"`);
  }
}

function platformKey(): string {
  const p = platform();
  const a = arch();
  if (p === "darwin" && a === "arm64") return "darwin-arm64";
  if (p === "darwin" && a === "x64") return "darwin-x64";
  if (p === "linux" && a === "x64") return "linux-x64";
  throw new Error(`unsupported platform ${p}-${a}`);
}

async function downloadAndVerify(
  url: string,
  sha256Expected: string,
): Promise<string> {
  const tmp = join(tmpdir(), `shemma-${Date.now()}.bin`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  await fs.writeFile(tmp, buf);
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== sha256Expected) {
    await fs.unlink(tmp).catch(() => {});
    throw new Error(`sha256 mismatch: expected ${sha256Expected}, got ${sha}`);
  }
  await fs.chmod(tmp, 0o755);
  return tmp;
}

type ManifestChannel = {
  version: string;
  assets: Array<{ platform: string; url: string; sha256: string }>;
};
type Manifest = { channels?: Record<string, ManifestChannel> };

async function fetchManifest(): Promise<Manifest> {
  const r = await fetch(manifestUrl());
  if (!r.ok) throw new Error(`manifest HTTP ${r.status}`);
  return r.json() as Promise<Manifest>;
}

export async function cmdUpdate(argv: string[]) {
  // Refuse to overwrite the bun interpreter when run as `bun src/index.ts` in dev.
  // Compiled binaries have execPath ending with the artifact name (shemma / shemma-*).
  if (!/shemma(-[^/]+)?$/.test(process.execPath))
    fail(
      "update is only available for compiled release binaries; use bun in dev",
    );

  const channel = resolveChannel();

  let manifest: Manifest;
  try {
    manifest = await fetchManifest();
  } catch (e) {
    fail(e);
  }

  const ch = manifest.channels?.[channel];
  if (!ch) fail(`channel "${channel}" not in manifest`);

  if (semverCmp(ch.version, CURRENT_VERSION) <= 0) {
    const ui = getOutput();
    if (ui.mode === "json") {
      console.log(
        JSON.stringify({
          ok: true,
          alreadyLatest: true,
          version: CURRENT_VERSION,
          channel,
        }),
      );
    } else {
      uiSuccess(`already on latest v${CURRENT_VERSION} (channel ${channel})`);
    }
    return;
  }

  const key = platformKey();
  const asset = ch.assets.find((a) => a.platform === key);
  if (!asset) fail(`no asset for ${key} in channel ${channel}`);

  const target = process.execPath;
  const dir = dirname(target);

  let tmpfile: string;
  try {
    tmpfile = await downloadAndVerify(asset.url, asset.sha256);
  } catch (e) {
    fail(e);
  }

  // copyFile + rename keeps target valid at all times:
  // there is a brief moment with two copies on disk, but target is never absent.
  // Plan's 3-step (rename tmp→.new; rename target→.old; rename .new→target) has
  // a window where target doesn't exist, which would break concurrent exec attempts.
  const oldPath = join(dir, "shemma.old");
  try {
    await fs.copyFile(target, oldPath);
    // rename is atomic on POSIX when src and dst are on the same filesystem.
    // If tmpdir() is on a different fs, rename throws EXDEV; fall back to copyFile.
    try {
      await fs.rename(tmpfile, target);
    } catch (renameErr) {
      if ((renameErr as NodeJS.ErrnoException).code === "EXDEV") {
        await fs.copyFile(tmpfile, target);
        await fs.unlink(tmpfile).catch(() => {});
      } else {
        throw renameErr;
      }
    }
  } catch (e) {
    fail(`atomic swap failed: ${e}`);
  }

  // Swap is complete and irreversible — emit success before restarting the daemon.
  // ensure() calls process.exit(3) directly on health timeout, which would suppress
  // this output if printed after; the caller reads stdout, not exit code, for success.
  const profile = parseProfile(argv);
  const ui = getOutput();
  if (ui.mode === "json") {
    console.log(
      JSON.stringify({
        ok: true,
        from: CURRENT_VERSION,
        to: ch.version,
        channel,
        profile,
        rollback: `mv '${oldPath}' '${target}'`,
      }),
    );
  } else {
    uiSuccess(`updated v${CURRENT_VERSION} → v${ch.version} (channel ${channel})`);
  }

  // ensure() self-spawns from process.execPath, which now points at the new binary.
  await stop(profile).catch(() => {});
  await ensure(profile);
  // Successful restart — drop the rollback backup to avoid accumulating ~70MB
  // per update. If ensure() throws (process.exit(3)), .old stays for manual rollback.
  await fs.unlink(oldPath).catch(() => {});
}
