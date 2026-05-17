/**
 * GitHub PAT resolution for private-repo distribution (DRW-059 B2).
 *
 * Auth chain (first hit wins):
 *   1. process.env.SHEMMA_GITHUB_TOKEN
 *   2. ~/.config/shemma/auth.json → { "github_token": "ghp_..." }
 *   3. `gh auth token` (best-effort, 1.5s timeout)
 *   4. null (anonymous fetch — works only for public repo)
 *
 * Designed for both compiled binary (`shemma update`) и backend (startup
 * update-check). saveToken() persists with chmod 600 — secrets stay user-only.
 */

import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AUTH_DIR = join(homedir(), ".config", "shemma");
export const AUTH_FILE = join(AUTH_DIR, "auth.json");

interface AuthFile {
  github_token?: string;
}

function readFromFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as AuthFile;
    if (typeof parsed.github_token === "string" && parsed.github_token.length > 0) {
      return parsed.github_token;
    }
  } catch {
    // malformed file → treat as absent
  }
  return null;
}

function readFromGhCli(): string | null {
  try {
    const out = execSync("gh auth token", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    })
      .toString()
      .trim();
    if (out.length > 0) return out;
  } catch {
    // gh not installed / not authenticated / timed out → skip
  }
  return null;
}

/**
 * Resolve GitHub PAT through the configured chain.
 * @param opts.skipGhCli — for tests / hot-path callers that want to avoid the
 *   1.5s subprocess timeout. Default false (full chain).
 * @param opts.authFile — override path (used by tests).
 */
export function readToken(
  opts: { skipGhCli?: boolean; authFile?: string } = {},
): string | null {
  const envToken = process.env.SHEMMA_GITHUB_TOKEN;
  if (envToken && envToken.length > 0) return envToken;

  const fileToken = readFromFile(opts.authFile ?? AUTH_FILE);
  if (fileToken) return fileToken;

  if (opts.skipGhCli) return null;
  return readFromGhCli();
}

/**
 * Persist token to ~/.config/shemma/auth.json with chmod 600.
 * Idempotent. Creates parent dir if absent.
 */
export function saveToken(token: string, opts: { authFile?: string } = {}): void {
  const path = opts.authFile ?? AUTH_FILE;
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const payload: AuthFile = { github_token: token };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  chmodSync(path, 0o600);
}

/**
 * Build `Authorization` + `Accept` headers for GitHub API. Returns empty
 * object if no token — caller still emits Accept header through spread.
 */
export function authHeaders(token: string | null): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}
