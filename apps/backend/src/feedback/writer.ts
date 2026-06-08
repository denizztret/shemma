// apps/backend/src/feedback/writer.ts
//
// DRW-227.01: append-only JSONL writer for the feedback backbone. One file per
// (space, room) under `baseDir`; size-based single-level rotation. The daemon
// is a singleton per machine (see CLAUDE.md), so synchronous appends never
// race. Best-effort: the middleware wraps calls in try/catch so a write error
// never affects the agent's response.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export interface FeedbackWriterOptions {
  /** Directory that holds the per-room JSONL files (e.g. ~/.shemma/feedback). */
  baseDir: string;
  /** Rotate the live file once it would exceed this many bytes. Default 16 MiB. */
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Replace anything outside `[A-Za-z0-9._-]` so a space/room id is filename-safe. */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class FeedbackWriter {
  private readonly baseDir: string;
  private readonly maxFileBytes: number;
  private dirReady = false;

  constructor(opts: FeedbackWriterOptions) {
    this.baseDir = opts.baseDir;
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /** Absolute path of the JSONL file for `(space, room)`. */
  filePath(space: string, room: string): string {
    return join(this.baseDir, `${sanitize(space)}__${sanitize(room)}.jsonl`);
  }

  /** Append one record as a JSONL line, rotating first if it would overflow. */
  append(space: string, room: string, record: unknown): void {
    if (!this.dirReady) {
      mkdirSync(this.baseDir, { recursive: true });
      this.dirReady = true;
    }
    const path = this.filePath(space, room);
    const line = `${JSON.stringify(record)}\n`;

    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0; // file does not exist yet
    }
    if (size > 0 && size + line.length > this.maxFileBytes) {
      // Single-level rotation: live → <name>.1.jsonl (overwrites any prior .1).
      renameSync(path, path.replace(/\.jsonl$/, ".1.jsonl"));
    }

    appendFileSync(path, line);
  }
}
