// packages/shemma-cli/src/feedback.ts
//
// DRW-227.03: `shemma feedback --diff <room>` — read-only reader over the
// feedback JSONL (DRW-227.01/.02). Joins each agent annotation to the request
// it refers to and prints the claimed-vs-actual pairs. No analytics, no task
// creation — strictly a viewer.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { computeDiff, formatDiff, parseFeedbackLines } from "./feedback-diff";
import { getOutput, error as uiError } from "./ui";

/** Default feedback directory (matches the daemon writer). Overridable via
 *  SHEMMA_FEEDBACK_DIR — the daemon honors the same var, so a custom location
 *  stays consistent between writer and reader. */
export function defaultFeedbackDir(): string {
  return (
    process.env.SHEMMA_FEEDBACK_DIR ?? join(homedir(), ".shemma", "feedback")
  );
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

type Resolved = { path: string } | { error: string };

/** Resolve the JSONL file for (room, space?) under `dir`. */
export function resolveFeedbackFile(
  dir: string,
  room: string,
  space?: string,
): Resolved {
  const roomSan = sanitize(room);
  if (space) {
    const p = join(dir, `${sanitize(space)}__${roomSan}.jsonl`);
    return existsSync(p)
      ? { path: p }
      : {
          error: `no feedback log for room "${room}" in space "${space}" (is SHEMMA_FEEDBACK enabled?)`,
        };
  }
  const suffix = `__${roomSan}.jsonl`;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(suffix));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    return {
      error: `no feedback log for room "${room}" (is SHEMMA_FEEDBACK enabled?)`,
    };
  }
  if (files.length > 1) {
    const spaces = files.map((f) => f.slice(0, -suffix.length));
    return {
      error: `room "${room}" exists in multiple spaces (${spaces.join(", ")}); pass --space <id>`,
    };
  }
  return { path: join(dir, files[0] as string) };
}

const USAGE = "usage: shemma feedback --diff <room> [--space <id>]";

export async function cmdFeedback(
  argv: string[],
  space?: string,
  opts: { feedbackDir?: string } = {},
): Promise<void> {
  let room: string | undefined;
  let diff = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--diff") {
      diff = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        room = next;
        i++;
      }
    } else if (
      tok !== undefined &&
      !tok.startsWith("--") &&
      room === undefined
    ) {
      room = tok;
    }
  }

  if (!diff || !room) {
    uiError(room ? USAGE : `missing <room>. ${USAGE}`, { code: "usage" });
    process.exitCode = 2;
    return;
  }

  const dir = opts.feedbackDir ?? defaultFeedbackDir();
  const resolved = resolveFeedbackFile(dir, room, space);
  const ui = getOutput();
  if ("error" in resolved) {
    if (ui.mode === "json") {
      console.log(JSON.stringify({ ok: false, error: resolved.error }));
    } else {
      console.log(resolved.error);
    }
    return;
  }

  const entries = computeDiff(
    parseFeedbackLines(readFileSync(resolved.path, "utf8")),
  );
  if (ui.mode === "json") {
    console.log(JSON.stringify({ ok: true, room, entries }, null, 2));
    return;
  }
  console.log(formatDiff(entries));
}
