/**
 * Integration tests for `shemma s` subcommands (DRW-116 Task 21).
 *
 * Spawns the CLI via `Bun.spawn` (spawnSync hangs inside `bun test` —
 * see version-cmd.test.ts). XDG_CONFIG_HOME is redirected to a temp dir
 * so each test starts with an empty spaces registry.
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
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "cli-spaces-"));
});

afterEach(() => {
  fs.rmSync(tmpXdg, { recursive: true, force: true });
});

describe("shemma s list", () => {
  test("empty when no spaces", async () => {
    const r = await runCli(["s", "list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No spaces registered");
  });

  test("--json returns valid JSON with empty array", async () => {
    const r = await runCli(["s", "list", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.spaces).toEqual([]);
  });
});

describe("shemma s add", () => {
  test("adds a space and lists it", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const add = await runCli(["s", "add", proj]);
      expect(add.status).toBe(0);
      expect(add.stdout).toContain("added:");
      const list = await runCli(["s", "list", "--json"]);
      expect(list.status).toBe(0);
      const parsed = JSON.parse(list.stdout);
      expect(parsed.spaces).toHaveLength(1);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  test("--label is propagated", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const add = await runCli(["s", "add", proj, "--label", "MyProj"]);
      expect(add.status).toBe(0);
      expect(add.stdout).toContain("MyProj");
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  test("idempotent on second add", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const first = await runCli(["s", "add", proj]);
      expect(first.status).toBe(0);
      const second = await runCli(["s", "add", proj]);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("exists:");
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  test("missing <path> arg returns usage error", async () => {
    const r = await runCli(["s", "add"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: shemma s add");
  });
});

describe("shemma s forget", () => {
  test("removes a space", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const add = await runCli(["s", "add", proj]);
      const id = add.stdout.match(/added: ([^\s]+)/)?.[1];
      expect(id).toBeDefined();
      const forget = await runCli(["s", "forget", id as string]);
      expect(forget.status).toBe(0);
      expect(forget.stdout).toContain("forgotten:");
      const list = await runCli(["s", "list", "--json"]);
      const parsed = JSON.parse(list.stdout);
      expect(parsed.spaces).toEqual([]);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});

describe("shemma s rename", () => {
  test("updates label (joining multi-word arg)", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const add = await runCli(["s", "add", proj]);
      const id = add.stdout.match(/added: ([^\s]+)/)?.[1];
      expect(id).toBeDefined();
      const rename = await runCli(["s", "rename", id as string, "New", "Label"]);
      expect(rename.status).toBe(0);
      expect(rename.stdout).toContain("New Label");
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  test("unknown id returns error", async () => {
    const r = await runCli(["s", "rename", "no-such-id", "X"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Failed");
  });
});

describe("shemma s prune", () => {
  test("reports no orphans when all paths exist", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      await runCli(["s", "add", proj]);
      const prune = await runCli(["s", "prune"]);
      expect(prune.status).toBe(0);
      expect(prune.stdout).toContain("No orphan spaces");
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  test("--dry-run lists orphans without removing", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    await runCli(["s", "add", proj]);
    // Delete the directory so the space becomes an orphan.
    fs.rmSync(proj, { recursive: true, force: true });

    const dry = await runCli(["s", "prune", "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("Found 1 orphan");
    expect(dry.stdout).toContain("(--dry-run; not removed)");

    // Still present after dry-run.
    const list = await runCli(["s", "list", "--json"]);
    expect(JSON.parse(list.stdout).spaces).toHaveLength(1);
  });

  test("--yes removes orphans", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    await runCli(["s", "add", proj]);
    fs.rmSync(proj, { recursive: true, force: true });

    const prune = await runCli(["s", "prune", "--yes"]);
    expect(prune.status).toBe(0);
    expect(prune.stdout).toContain("Pruned 1 space");

    const list = await runCli(["s", "list", "--json"]);
    expect(JSON.parse(list.stdout).spaces).toEqual([]);
  });
});

describe("shemma s unknown subcommand", () => {
  test("returns exit 1 with hint", async () => {
    const r = await runCli(["s", "noSuchSub"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown spaces subcommand");
  });
});
