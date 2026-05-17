import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../../apps/backend/src/index";
import { __resetConfigForTests } from "../../../apps/backend/src/config";

let srv: { port: number; close: () => Promise<void> };
let dir: string;
const CLI = join(import.meta.dir, "..", "src", "index.ts");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "didraw-cli-"));
  srv = await startServer({ storageDir: dir, port: 0 });
});
afterAll(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

const envBase = (): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  DIDRAW_PORT: String(srv.port),
});

async function cli(
  args: string[],
  opts: { env?: Record<string, string>; input?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: opts.env ?? envBase(),
    stdin: opts.input !== undefined ? Buffer.from(opts.input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status: exitCode, stdout, stderr };
}

describe("didraw rooms via subprocess CLI", () => {
  test("rooms list — empty workspace", async () => {
    const r = await cli(["rooms", "list"]);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(true);
    expect(j.rooms).toEqual([]);
  });

  test("rooms export → import roundtrip via CLI", async () => {
    // Phase 3.0: room populated via /api/domain (the only mutation path now);
    // /api/patch was removed (spec §10).
    const body = JSON.stringify({
      actions: [{ kind: "define", role: "service", name: "n1" }],
    });
    const seed = await cli(["apply", "--stdin"], {
      env: { ...envBase(), CLAUDE_SESSION_ID: "src-room" },
      input: body,
    });
    expect(seed.status).toBe(0);

    const target = join(dir, "..", "exp-via-cli.json");
    const exp = await cli(["rooms", "export", "src-room", "--to", target]);
    expect(exp.status).toBe(0);
    expect(JSON.parse(exp.stdout).ok).toBe(true);

    const imp = await cli(["rooms", "import", target, "--as", "imported-room"]);
    expect(imp.status).toBe(0);
    const impBody = JSON.parse(imp.stdout);
    expect(impBody.ok).toBe(true);
    expect(impBody.roomId).toBe("imported-room");

    const list = await cli(["rooms", "list"]);
    const ids = JSON.parse(list.stdout).rooms.map((r: { id: string }) => r.id).sort();
    expect(ids).toContain("src-room");
    expect(ids).toContain("imported-room");

    rmSync(target, { force: true });
  });

  test("rooms archive then restore via CLI", async () => {
    const body = JSON.stringify({
      actions: [{ kind: "define", role: "service", name: "n1" }],
    });
    await cli(["apply", "--stdin"], {
      env: { ...envBase(), CLAUDE_SESSION_ID: "to-archive" },
      input: body,
    });

    const arch = await cli(["rooms", "archive", "to-archive"]);
    expect(arch.status).toBe(0);

    const rest = await cli(["rooms", "restore", "to-archive"]);
    expect(rest.status).toBe(0);

    const list = await cli(["rooms", "list"]);
    const ids = JSON.parse(list.stdout).rooms.map((r: { id: string }) => r.id);
    expect(ids).toContain("to-archive");
  });

  test("rooms rm without --confirm exits 1", async () => {
    const r = await cli(["rooms", "rm", "anything"]);
    expect(r.status).toBe(1);
    const err = JSON.parse(r.stderr);
    expect(err.error).toMatch(/confirm/);
  });

  test("rooms purge-archive without --confirm exits 1", async () => {
    const r = await cli(["rooms", "purge-archive"]);
    expect(r.status).toBe(1);
    const err = JSON.parse(r.stderr);
    expect(err.error).toMatch(/confirm/);
  });

  test("rooms purge-archive --confirm removes archived rooms", async () => {
    // Seed a room via domain apply
    const body = JSON.stringify({
      actions: [{ kind: "define", role: "service", name: "n1" }],
    });
    await cli(["apply", "--stdin"], {
      env: { ...envBase(), CLAUDE_SESSION_ID: "purge-test-room" },
      input: body,
    });

    // Archive it
    const arch = await cli(["rooms", "archive", "purge-test-room"]);
    expect(arch.status).toBe(0);

    // Purge archive
    const r = await cli(["rooms", "purge-archive", "--confirm"]);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(true);
    expect(j.removed).toBeGreaterThanOrEqual(1);
  });

  test("rooms rm --hard --confirm on non-linked room exits 0", async () => {
    const body = JSON.stringify({
      actions: [{ kind: "define", role: "service", name: "n1" }],
    });
    await cli(["apply", "--stdin"], {
      env: { ...envBase(), CLAUDE_SESSION_ID: "hard-rm-room" },
      input: body,
    });

    // Hard delete without linked check (no CLAUDE_SESSION_ID matching in env)
    const r = await cli(["rooms", "rm", "hard-rm-room", "--hard", "--confirm"], {
      env: { ...envBase() },
    });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(true);
  });

  test("rooms rm --hard --confirm on linked room without --force exits 1", async () => {
    // The backend server runs in-process. We manipulate CLAUDE_SESSION_ID in
    // the test process env + reset config cache so the in-process server sees the
    // new sessionId for the duration of this test.
    const sessionId = "linked-cli-room";

    // Set session id BEFORE seeding so Rooms.get() auto-sets linkedSession
    process.env.CLAUDE_SESSION_ID = sessionId;
    __resetConfigForTests();
    try {
      const body = JSON.stringify({
        actions: [{ kind: "define", role: "service", name: "n1" }],
      });
      await cli(["apply", "--stdin"], {
        env: { ...envBase(), CLAUDE_SESSION_ID: sessionId },
        input: body,
      });

      // CLI subprocess sends CLAUDE_SESSION_ID; backend in this process uses
      // config.sessionId which we set via env + reset.
      const r = await cli(["rooms", "rm", sessionId, "--hard", "--confirm"], {
        env: { ...envBase(), CLAUDE_SESSION_ID: sessionId },
      });
      expect(r.status).toBe(1);
      const j = JSON.parse(r.stdout);
      expect(j.ok).toBe(false);
      expect(j.error).toBe("linked-to-active-session");
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      __resetConfigForTests();
    }
  });

  test("rooms rm --hard --force --confirm on linked room exits 0", async () => {
    const sessionId = "linked-force-cli";
    process.env.CLAUDE_SESSION_ID = sessionId;
    __resetConfigForTests();
    try {
      const body = JSON.stringify({
        actions: [{ kind: "define", role: "service", name: "n1" }],
      });
      await cli(["apply", "--stdin"], {
        env: { ...envBase(), CLAUDE_SESSION_ID: sessionId },
        input: body,
      });

      const r = await cli(
        ["rooms", "rm", sessionId, "--hard", "--force", "--confirm"],
        { env: { ...envBase(), CLAUDE_SESSION_ID: sessionId } },
      );
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.ok).toBe(true);
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      __resetConfigForTests();
    }
  });
});
