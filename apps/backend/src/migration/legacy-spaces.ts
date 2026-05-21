import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerSpace, spacesJsonPath } from "@shemma/spaces";

const SLUG_PREFIX = "legacy-";

export type LegacyMigrationResult = { migrated: number; defaultId?: string };
export type StartupMigrationResult = LegacyMigrationResult & { skipped?: boolean };

/**
 * Auto-register existing `~/.claude/projects/<slug>/canvas/` directories as
 * legacy-layout spaces when the daemon starts and no `spaces.json` exists yet.
 *
 * The most-recently modified canvas project becomes `default` (so the MCP
 * resolver's default fallback maps to the user's most active CC project on
 * first boot after upgrade). Other projects get `legacy-<slug>` ids.
 *
 * Idempotent: subsequent calls short-circuit because `spaces.json` already
 * exists.
 */
export function migrateLegacySpacesIfNeeded(
  opts: { homeDir?: string } = {},
): LegacyMigrationResult {
  if (fs.existsSync(spacesJsonPath())) return { migrated: 0 };

  const home = opts.homeDir ?? os.homedir();
  const projectsRoot = path.join(home, ".claude", "projects");

  if (!fs.existsSync(projectsRoot)) {
    writeEmptyRegistry();
    return { migrated: 0 };
  }

  const candidates = scanLegacyCandidates(projectsRoot);

  if (candidates.length === 0) {
    writeEmptyRegistry();
    return { migrated: 0 };
  }

  // Most-recently-active project first → becomes "default".
  candidates.sort((a, b) => b.mtime - a.mtime);

  let defaultId: string | undefined;
  let migrated = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const isDefault = i === 0;
    const id = isDefault ? "default" : `${SLUG_PREFIX}${c.slug.slice(0, 28)}`;
    const label = isDefault ? "Default (migrated)" : `Legacy: ${c.slug.slice(0, 40)}`;
    try {
      registerSpace(c.projectDir, {
        id,
        storageLayout: "legacy",
        legacy: true,
        label,
      });
      if (isDefault) defaultId = id;
      migrated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[shemma] legacy migration: failed to register ${c.projectDir}: ${msg}`);
    }
  }

  return { migrated, defaultId };
}

type LegacyCandidate = {
  projectDir: string;
  canvasDir: string;
  mtime: number;
  slug: string;
};

function scanLegacyCandidates(projectsRoot: string): LegacyCandidate[] {
  const out: LegacyCandidate[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projDir = path.join(projectsRoot, entry.name);
    const canvasDir = path.join(projDir, "canvas");
    if (!fs.existsSync(canvasDir)) continue;
    const mtime = mostRecentCanvasMtime(canvasDir);
    out.push({ projectDir: projDir, canvasDir, mtime, slug: entry.name });
  }
  return out;
}

function mostRecentCanvasMtime(canvasDir: string): number {
  let mtime = 0;
  try {
    const files = fs.readdirSync(canvasDir).filter(f => f.endsWith(".json"));
    for (const f of files) {
      const stat = fs.statSync(path.join(canvasDir, f));
      if (stat.mtimeMs > mtime) mtime = stat.mtimeMs;
    }
  } catch {
    // ignore — empty/unreadable canvas dirs simply get mtime=0
  }
  return mtime;
}

function writeEmptyRegistry(): void {
  const file = spacesJsonPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, spaces: [] }, null, 2));
}

/**
 * Entry-point for backend daemon startup. Wraps `migrateLegacySpacesIfNeeded`
 * with SHEMMA_SKIP_LEGACY_MIGRATION gating so the call site in `index.ts` stays
 * clean and the skip-flag path remains independently testable.
 *
 * When `skipFlag` is true the scan is bypassed entirely; an empty registry is
 * still created if it does not exist (so subsequent reads don't throw ENOENT).
 */
export function runStartupMigration(
  opts: { skipFlag?: boolean; homeDir?: string } = {},
): StartupMigrationResult {
  if (opts.skipFlag) {
    if (!fs.existsSync(spacesJsonPath())) {
      writeEmptyRegistry();
    }
    return { migrated: 0, skipped: true };
  }
  return migrateLegacySpacesIfNeeded({ homeDir: opts.homeDir });
}
