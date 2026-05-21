/**
 * `shemma s` subcommand surface (DRW-116 Task 21).
 *
 * Direct in-process calls to `@shemma/spaces` — these operations manage the
 * user-level spaces registry (~/.config/shemma/spaces.json) and do NOT
 * require a running daemon. Used for manual registry management:
 *
 *   shemma s list [--json]
 *   shemma s add <path> [--label <label>]
 *   shemma s forget <id>
 *   shemma s rename <id> <new-label>
 *   shemma s prune [--dry-run] [--yes]
 *   shemma s reveal <id>
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import {
  findSpaceById,
  forgetSpace,
  listSpaces,
  registerSpace,
  renameSpaceLabel,
} from "@shemma/spaces";
import { getOutput } from "../ui";

export async function handleSpacesCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "list":
    case undefined:
      return cmdList(rest);
    case "add":
      return cmdAdd(rest);
    case "forget":
      return cmdForget(rest);
    case "rename":
      return cmdRename(rest);
    case "prune":
      return cmdPrune(rest);
    case "reveal":
      return cmdReveal(rest);
    default:
      console.error(`Unknown spaces subcommand: ${sub}`);
      console.error("Available: list, add, forget, rename, prune, reveal");
      return 1;
  }
}

function cmdList(args: string[]): number {
  // `--json` is a *global* flag stripped by `parseOutputMode` before the
  // per-command argv reaches us (see index.ts). We honour both the global
  // ui.mode and an explicit local `--json` for safety.
  const json = getOutput().mode === "json" || args.includes("--json");
  const spaces = listSpaces();
  if (json) {
    console.log(JSON.stringify({ spaces }, null, 2));
    return 0;
  }
  if (spaces.length === 0) {
    console.log("No spaces registered.");
    return 0;
  }
  console.log(
    "ID                   LABEL              PATH                                  LAST USED",
  );
  for (const s of spaces) {
    const id = (s.id ?? "").padEnd(20);
    const label = (s.label ?? "").padEnd(18);
    const rawPath = s.path ?? "";
    const pathCol =
      rawPath.length > 36 ? `…${rawPath.slice(-35)}` : rawPath.padEnd(36);
    const last = new Date(s.lastUsedAt).toISOString().slice(0, 10);
    console.log(`${id} ${label} ${pathCol} ${last}`);
  }
  return 0;
}

function cmdAdd(args: string[]): number {
  const [pathArg, ...rest] = args;
  if (!pathArg) {
    console.error("Usage: shemma s add <path> [--label <label>]");
    return 1;
  }
  let label: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--label" && rest[i + 1]) {
      label = rest[i + 1];
      i++;
    }
  }
  try {
    const { space, created } = registerSpace(pathArg, { label });
    const labelSuffix = label ? ` (${label})` : "";
    console.log(
      `${created ? "added" : "exists"}: ${space.id} → ${space.path}${labelSuffix}`,
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to register space: ${msg}`);
    return 1;
  }
}

function cmdForget(args: string[]): number {
  const [id] = args;
  if (!id) {
    console.error("Usage: shemma s forget <id>");
    return 1;
  }
  forgetSpace(id);
  console.log(`forgotten: ${id}`);
  return 0;
}

function cmdRename(args: string[]): number {
  const [id, ...labelParts] = args;
  if (!id || labelParts.length === 0) {
    console.error("Usage: shemma s rename <id> <new-label>");
    return 1;
  }
  try {
    const updated = renameSpaceLabel(id, labelParts.join(" "));
    console.log(`renamed: ${updated.id} → "${updated.label}"`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed: ${msg}`);
    return 1;
  }
}

function cmdPrune(args: string[]): number {
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");
  const spaces = listSpaces();
  const orphans = spaces.filter((s) => {
    try {
      fs.accessSync(s.path);
      return false;
    } catch {
      return true;
    }
  });
  if (orphans.length === 0) {
    console.log("No orphan spaces.");
    return 0;
  }
  console.log(`Found ${orphans.length} orphan space(s):`);
  for (const o of orphans) console.log(`  ${o.id} → ${o.path}`);
  if (dryRun) {
    console.log("(--dry-run; not removed)");
    return 0;
  }
  if (!yes) {
    console.log("Pass --yes to confirm removal.");
    return 0;
  }
  for (const o of orphans) forgetSpace(o.id);
  console.log(`Pruned ${orphans.length} space(s).`);
  return 0;
}

function cmdReveal(args: string[]): number {
  const [id] = args;
  if (!id) {
    console.error("Usage: shemma s reveal <id>");
    return 1;
  }
  const s = findSpaceById(id);
  if (!s) {
    console.error(`Unknown space: ${id}`);
    return 1;
  }
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  try {
    spawn(cmd, [s.path], { detached: true, stdio: "ignore" }).unref();
    console.log(`opening: ${s.path}`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to open: ${msg}`);
    return 1;
  }
}
