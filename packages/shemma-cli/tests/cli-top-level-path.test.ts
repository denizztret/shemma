/**
 * Integration tests for the top-level positional path entry (DRW-116 Task 22):
 *
 *   shemma /path/to/project          → registers + URL /?space=<id>
 *   shemma /a /b /c                  → registers up to 3, URL /?cols=<a>,<b>,<c>
 *   shemma /a /b /c /d               → caps at 3
 *
 * Uses `--no-daemon` to skip daemon ensure + browser launch so tests stay fast
 * and deterministic without touching the real daemon lock dir.
 *
 * XDG_CONFIG_HOME is redirected to a temp dir per-test to isolate the spaces
 * registry — same pattern as `cli-spaces.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "index.ts");

let tmpXdg: string;

async function runCli(args: string[]): Promise<{
  status: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      XDG_CONFIG_HOME: tmpXdg,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

beforeEach(() => {
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "cli-tlp-xdg-"));
});

afterEach(() => {
  fs.rmSync(tmpXdg, { recursive: true, force: true });
});

describe("shemma <path> top-level positional", () => {
  test("single path: registers space and emits ?space= URL", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tlp-proj-"));
    try {
      const r = await runCli([proj, "--no-daemon"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("registered:");
      expect(r.stdout).toMatch(/URL: http:\/\/localhost:\d+\/\?space=/);
      expect(r.stdout).not.toContain("?cols=");
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  test("multiple paths: emits ?cols= URL with all ids", async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "tlp-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "tlp-b-"));
    try {
      const r = await runCli([a, b, "--no-daemon"]);
      expect(r.status).toBe(0);
      const matches = r.stdout.match(/registered:/g);
      expect(matches?.length).toBe(2);
      expect(r.stdout).toMatch(/URL: http:\/\/localhost:\d+\/\?cols=[^,]+,[^,\s]+/);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  test("caps at 3 paths even if more provided", async () => {
    const dirs = [0, 1, 2, 3].map(() =>
      fs.mkdtempSync(path.join(os.tmpdir(), "tlp-d-")),
    );
    try {
      const r = await runCli([...dirs, "--no-daemon"]);
      expect(r.status).toBe(0);
      const matches = r.stdout.match(/registered:/g);
      expect(matches?.length).toBe(3);
      // URL should contain exactly 3 ids (2 commas).
      const urlLine = r.stdout
        .split("\n")
        .find((l) => l.startsWith("URL: "));
      expect(urlLine).toBeDefined();
      const cols = urlLine!.split("cols=")[1] ?? "";
      expect(cols.split(",").length).toBe(3);
    } finally {
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test("subcommand names still win over directory lookup (`s` not treated as path)", async () => {
    // `s list` must still work even if a "s" directory existed in cwd —
    // the cascade checks `if (cmd === "s")` before `looksLikePath(cmd)`.
    const r = await runCli(["s", "list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No spaces registered");
  });
});
