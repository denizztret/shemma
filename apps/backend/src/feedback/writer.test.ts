import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeedbackWriter } from "./writer";

describe("FeedbackWriter", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "shemma-fb-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends a JSONL line, creating the file + dir lazily", () => {
    const w = new FeedbackWriter({ baseDir: join(dir, "nested") });
    w.append("di-draw", "room-a", { kind: "request", n: 1 });
    const p = w.filePath("di-draw", "room-a");
    expect(existsSync(p)).toBe(true);
    const lines = readFileSync(p, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(String(lines[0]))).toEqual({ kind: "request", n: 1 });
  });

  it("appends multiple records as separate lines", () => {
    const w = new FeedbackWriter({ baseDir: dir });
    w.append("s", "room-b", { n: 1 });
    w.append("s", "room-b", { n: 2 });
    const lines = readFileSync(w.filePath("s", "room-b"), "utf8")
      .trim()
      .split("\n");
    expect(lines.map((l) => JSON.parse(l).n)).toEqual([1, 2]);
  });

  it("sanitizes space/room into a safe composite filename", () => {
    const w = new FeedbackWriter({ baseDir: dir });
    const p = w.filePath("sp/ace", "ro:om id");
    expect(p.endsWith("sp_ace__ro_om_id.jsonl")).toBe(true);
  });

  it("rotates to <name>.1.jsonl when the file would exceed maxFileBytes", () => {
    const w = new FeedbackWriter({ baseDir: dir, maxFileBytes: 120 });
    const main = w.filePath("s", "room-c");
    const rotated = main.replace(/\.jsonl$/, ".1.jsonl");
    for (let i = 0; i < 8; i++) {
      w.append("s", "room-c", { i, pad: "xxxxxxxxxx" });
    }
    // Single-level rotation: a .1 backup exists and the live file stays bounded.
    expect(existsSync(rotated)).toBe(true);
    expect(readFileSync(main, "utf8").length).toBeLessThanOrEqual(120 + 60);
    // The most recent append always lands in the live file.
    expect(readFileSync(main, "utf8").trim().length).toBeGreaterThan(0);
  });
});
