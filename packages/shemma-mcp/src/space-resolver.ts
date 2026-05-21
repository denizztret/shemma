import fs from "node:fs";
import path from "node:path";
import { findSpaceById, listSpaces, type SpaceRecord } from "@shemma/spaces";

export type ResolveSource = "explicit" | "cwd" | "default" | "ambiguous" | "not_found";

export type ResolveResult =
  | { space: SpaceRecord; source: "explicit" | "cwd" | "default"; error?: undefined }
  | { space: undefined; source: "ambiguous" | "not_found"; error: string };

/**
 * Resolve which `SpaceRecord` an MCP tool call should operate on.
 *
 * Resolution order (spec §8.2):
 *   1. Explicit `args.space` → registry lookup. Unknown id → `not_found`.
 *   2. CWD match — longest path prefix of cwd. Multiple registered spaces under
 *      the same cwd → most specific (deepest) wins.
 *   3. `default` space fallback if registered.
 *   4. Otherwise → `ambiguous` with hint listing available spaces.
 *
 * CWD is resolved via `realpathSync` so symlinks are normalised the same way
 * the registry does (`registerSpace` stores realpath).
 */
export function resolveSpace(args: { space?: string; cwd?: string }): ResolveResult {
  // 1. Explicit id wins.
  if (args.space) {
    const record = findSpaceById(args.space);
    if (!record) {
      return { space: undefined, source: "not_found", error: `space_not_found: ${args.space}` };
    }
    return { space: record, source: "explicit" };
  }

  // 2. CWD match — realpath normalisation matches registry storage.
  const rawCwd = args.cwd ?? process.cwd();
  const realCwd = realpathSafe(rawCwd);
  const all = listSpaces();

  const matches = all.filter(s => {
    const sPath = s.path;
    return realCwd === sPath || realCwd.startsWith(sPath + path.sep);
  });
  if (matches.length > 0) {
    matches.sort((a, b) => b.path.length - a.path.length);
    return { space: matches[0], source: "cwd" };
  }

  // 3. `default` fallback (opt-out via `shemma s forget default`).
  const def = all.find(s => s.id === "default");
  if (def) {
    return { space: def, source: "default" };
  }

  // 4. Ambiguous — surface helpful list so the caller can retry with explicit id.
  const available = all.map(s => `  - ${s.id} (${s.path})`).join("\n");
  const msg = all.length === 0
    ? "space_ambiguous: no spaces registered. Run 'shemma s add <path>' first."
    : `space_ambiguous: cannot resolve space for cwd=${rawCwd}. Available spaces:\n${available}\nPass explicit 'space' arg or 'cd' into a registered path.`;
  return { space: undefined, source: "ambiguous", error: msg };
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
