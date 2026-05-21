/**
 * `shemma <path> [<path>...]` top-level positional handler (DRW-116 Task 22).
 *
 * Detects when the first positional argument is an existing directory and:
 *   1. Registers up to 3 paths as spaces in the user-level registry,
 *   2. Ensures the daemon is running (unless --no-daemon),
 *   3. Opens the browser at the right URL:
 *        - single path  → /?space=<id>
 *        - multi-path   → /?cols=<id1>,<id2>,...
 *
 * Test-only flags:
 *   --no-daemon   skip daemon ensure (used by integration tests)
 *   --no-open     skip browser launch but still ensure daemon (parity with `open`)
 *
 * The detection lives in `looksLikePath` (stat + isDirectory) so subcommand
 * names like "daemon" or "s" never collide — they aren't directories under cwd.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { registerSpace } from "@shemma/spaces";
import { ensure as ensureDaemon } from "../daemon";
import { type Profile, portFor } from "../profile";

const MAX_PATHS = 3;

export function looksLikePath(arg: string | undefined): boolean {
  if (!arg) return false;
  if (arg.startsWith("-")) return false;
  try {
    return fs.statSync(arg).isDirectory();
  } catch {
    return false;
  }
}

export async function cmdTopLevelPath(
  args: string[],
  profile: Profile,
): Promise<number> {
  const noDaemon = args.includes("--no-daemon");
  const noOpen = args.includes("--no-open");
  const positional = args.filter((a) => !a.startsWith("-")).slice(0, MAX_PATHS);
  if (positional.length === 0) {
    console.error("No paths provided");
    return 1;
  }
  const spaceIds: string[] = [];
  for (const p of positional) {
    try {
      const { space } = registerSpace(p);
      spaceIds.push(space.id);
      console.log(`registered: ${space.id} → ${space.path}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to register ${p}: ${msg}`);
      return 1;
    }
  }
  const port = portFor(profile);
  const url =
    spaceIds.length === 1
      ? `http://localhost:${port}/?space=${encodeURIComponent(spaceIds[0]!)}`
      : `http://localhost:${port}/?cols=${spaceIds.map(encodeURIComponent).join(",")}`;
  if (noDaemon) {
    console.log(`URL: ${url}`);
    return 0;
  }
  await ensureDaemon(profile);
  if (noOpen) {
    console.log(`URL: ${url}`);
    return 0;
  }
  openBrowser(url);
  console.log(`Opened: ${url}`);
  return 0;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}
