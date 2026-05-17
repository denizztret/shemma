import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { arch, homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { authHeaders, readToken } from "./auth";
import { ensure, stop } from "./daemon";
import { parseProfile } from "./profile";
import { fail } from "./util";
import { getOutput, success as uiSuccess } from "./ui";

export const VALID_CHANNELS = ["stable", "nightly", "dev"] as const;
type Channel = (typeof VALID_CHANNELS)[number];

function isChannel(s: string): s is Channel {
  return (VALID_CHANNELS as readonly string[]).includes(s);
}

// Resolve current version: prefer SHEMMA_VERSION injected by build-release.sh
// (compiled binary); in dev fall back to package.json with a `-dev` suffix so
// the channel comparison still parses, and the user sees something useful.
function resolveCurrentVersion(): string {
  const env = process.env.SHEMMA_VERSION;
  if (env && env.length > 0) return env;
  try {
    // packages/shemma-cli/src/update.ts → ../package.json
    const pkgPath = join(import.meta.dir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (pkg.version) return `${pkg.version}-dev`;
  } catch {
    // ignore — caller treats "0.0.0" as "pre-release"
  }
  return "0.0.0";
}

const CURRENT_VERSION = resolveCurrentVersion();

const CONFIG_FILE = join(homedir(), ".claude", ".shemma-config.json");

// GitHub repo for distribution. Override via SHEMMA_GITHUB_REPO for forks/tests.
const DEFAULT_REPO = "denizztret/shemma";

function githubRepo(): string {
  return process.env.SHEMMA_GITHUB_REPO ?? DEFAULT_REPO;
}

/**
 * GitHub API endpoint for the latest release. We resolve the asset list from
 * here at fetch time — this dodges the missing-tag-`latest` issue with raw
 * `releases/download/latest/...` URLs and works seamlessly for both public
 * and private repos (PAT decides access).
 *
 * `SHEMMA_MANIFEST_URL` env override is still honoured (legacy + tests):
 *   - If it contains "api.github.com/repos/.../releases/latest" → use as-is.
 *   - If it points at a static manifest JSON (raw URL) → fetch directly.
 */
function latestReleaseUrl(): string {
  if (process.env.SHEMMA_MANIFEST_URL) return process.env.SHEMMA_MANIFEST_URL;
  return `https://api.github.com/repos/${githubRepo()}/releases/latest`;
}

interface GitHubAsset {
  id: number;
  name: string;
  url: string; // API URL for octet-stream download
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
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

type ManifestChannel = {
  version: string;
  assets: Array<{ platform: string; url: string; sha256: string }>;
};
type Manifest = { channels?: Record<string, ManifestChannel> };

/**
 * Detect whether `SHEMMA_MANIFEST_URL` points at a static manifest JSON
 * (legacy / test) vs a GitHub API release endpoint. Static URLs are fetched
 * directly without the assets-id round trip.
 */
function isStaticManifestUrl(url: string): boolean {
  // GitHub API releases endpoint pattern:
  //   https://api.github.com/repos/<owner>/<repo>/releases/(latest|<id>)
  if (/^https?:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\//.test(url)) {
    return false;
  }
  return true;
}

async function fetchJson<T>(url: string, token: string | null, accept: string): Promise<T> {
  const r = await fetch(url, {
    headers: {
      Accept: accept,
      "User-Agent": "shemma-cli",
      ...authHeaders(token),
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return (await r.json()) as T;
}

/**
 * Fetch the release manifest. Two paths:
 *   A) static URL (SHEMMA_MANIFEST_URL → manifest.json) — direct fetch, parse
 *   B) GitHub API → resolve `release-manifest.json` asset → fetch via
 *      `assets/<id>` with `Accept: application/octet-stream`
 *
 * Token (PAT) injected on both paths when available.
 */
async function fetchManifest(): Promise<{ manifest: Manifest; release?: GitHubRelease }> {
  const url = latestReleaseUrl();
  const token = readToken({ skipGhCli: false });

  if (isStaticManifestUrl(url)) {
    const manifest = await fetchJson<Manifest>(url, token, "application/json");
    return { manifest };
  }

  const release = await fetchJson<GitHubRelease>(url, token, "application/vnd.github+json");
  const manifestAsset = release.assets.find((a) => a.name === "release-manifest.json");
  if (!manifestAsset) {
    throw new Error(`release ${release.tag_name} has no release-manifest.json asset`);
  }
  const manifest = await fetchJson<Manifest>(
    manifestAsset.url,
    token,
    "application/octet-stream",
  );
  return { manifest, release };
}

export async function cmdUpdateCheck() {
  const channel = resolveChannel();
  try {
    const { manifest } = await fetchManifest();
    const latest = manifest.channels?.[channel]?.version ?? null;
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

/**
 * Resolve the actual download URL for a binary asset.
 *
 * Manifest URLs (set by generate-manifest.sh) point at browser-download
 * URLs — those work for public repos but 404 for private. When we have a
 * GitHub API release object we prefer asset.url (`/releases/assets/<id>`)
 * with `Accept: application/octet-stream`, which honours the PAT.
 *
 * Falls back to the manifest URL when API metadata is unavailable (static
 * manifest path).
 */
function resolveAssetDownloadUrl(
  manifestUrl: string,
  platformKey: string,
  release?: GitHubRelease,
): { url: string; accept: string } {
  if (release) {
    const apiAsset = release.assets.find((a) => a.name === `shemma-${platformKey}`);
    if (apiAsset) {
      return { url: apiAsset.url, accept: "application/octet-stream" };
    }
  }
  return { url: manifestUrl, accept: "application/octet-stream" };
}

async function downloadAndVerify(
  url: string,
  accept: string,
  sha256Expected: string,
): Promise<string> {
  const tmp = join(tmpdir(), `shemma-${Date.now()}.bin`);
  const token = readToken({ skipGhCli: false });
  const r = await fetch(url, {
    headers: {
      Accept: accept,
      "User-Agent": "shemma-cli",
      ...authHeaders(token),
    },
    redirect: "follow",
  });
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

export async function cmdUpdate(argv: string[]) {
  // Refuse to overwrite the bun interpreter when run as `bun src/index.ts` in dev.
  // Compiled binaries have execPath ending with the artifact name (shemma / shemma-*).
  if (!/shemma(-[^/]+)?$/.test(process.execPath))
    fail(
      "update is only available for compiled release binaries; use bun in dev",
    );

  const channel = resolveChannel();

  let manifest: Manifest;
  let release: GitHubRelease | undefined;
  try {
    const r = await fetchManifest();
    manifest = r.manifest;
    release = r.release;
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

  const { url: downloadUrl, accept } = resolveAssetDownloadUrl(asset.url, key, release);

  const target = process.execPath;
  const dir = dirname(target);

  let tmpfile: string;
  try {
    tmpfile = await downloadAndVerify(downloadUrl, accept, asset.sha256);
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
