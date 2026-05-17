import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { ALL_PROFILES, type Profile, logFile } from "./profile";
import { error as uiError } from "./ui";

const DEFAULT_TAIL_LINES = 50;
const POLL_INTERVAL_MS = 200;

function lastNLines(content: string, n: number): string[] {
  const lines = content.split("\n");
  // remove trailing empty line if present
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n);
}

// Emit lines to stdout, optionally with a `[prefix] ` decoration for multi-profile follow.
function writeLines(lines: string[], prefix?: string): void {
  const head = prefix ? `[${prefix}] ` : "";
  for (const line of lines) process.stdout.write(head + line + "\n");
}

async function printTail(path: string, n: number, prefix?: string): Promise<number> {
  if (!existsSync(path)) {
    return 0;
  }
  const lines = lastNLines(readFileSync(path, "utf8"), n);
  writeLines(lines, prefix);
  return lines.length;
}

async function followLog(path: string, prefix?: string): Promise<void> {
  if (!existsSync(path)) {
    uiError(`log file not found: ${path}`, {
      code: `log file not found: ${path}`,
    });
    process.exit(2);
  }
  let offset = statSync(path).size;

  // Print existing content first (last DEFAULT_TAIL_LINES lines)
  writeLines(lastNLines(readFileSync(path, "utf8"), DEFAULT_TAIL_LINES), prefix);

  // Poll for new content
  const interval = setInterval(() => {
    try {
      const size = statSync(path).size;
      if (size > offset) {
        const stream = createReadStream(path, { start: offset, end: size - 1 });
        const chunks: Buffer[] = [];
        stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        stream.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const newLines = text.split("\n");
          // don't print trailing empty
          if (newLines[newLines.length - 1] === "") newLines.pop();
          writeLines(newLines, prefix);
          offset = size;
        });
      }
    } catch {
      // file may have been rotated; reset offset
      offset = 0;
    }
  }, POLL_INTERVAL_MS);

  // Exit cleanly on Ctrl+C
  process.on("SIGINT", () => {
    clearInterval(interval);
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

export interface LogsOptions {
  profile: Profile;
  tail: number;
  follow: boolean;
  all: boolean;
}

export async function cmdLogs(opts: LogsOptions): Promise<void> {
  const { profile, tail, follow, all } = opts;

  if (all) {
    if (follow) {
      // Follow all profiles — multiplex with prefixes
      // Launch concurrent followers; they all write to stdout with prefix
      await Promise.all(
        ALL_PROFILES.map((p) => followLog(logFile(p), p)),
      );
      return;
    }
    for (const p of ALL_PROFILES) {
      const path = logFile(p);
      if (!existsSync(path)) {
        process.stdout.write(`[${p}] (no log file)\n`);
        continue;
      }
      await printTail(path, tail, p);
    }
    return;
  }

  const path = logFile(profile);
  if (!existsSync(path)) {
    uiError(`log file not found: ${path}`, {
      code: `log file not found: ${path}`,
    });
    process.exit(2);
  }

  if (follow) {
    await followLog(path);
    return;
  }

  await printTail(path, tail);
}
