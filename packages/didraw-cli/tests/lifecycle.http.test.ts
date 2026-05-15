import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../../apps/backend/src/index";

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
    const body = JSON.stringify({
      ops: [
        {
          op: "add",
          target: "node",
          value: { id: "n1", kind: "rect", x: 0, y: 0 },
        },
      ],
      source: "user",
    });
    const patch = await cli(["patch", "--stdin"], {
      env: { ...envBase(), CLAUDE_SESSION_ID: "src-room" },
      input: body,
    });
    expect(patch.status).toBe(0);

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
      ops: [
        {
          op: "add",
          target: "node",
          value: { id: "n1", kind: "rect", x: 0, y: 0 },
        },
      ],
      source: "user",
    });
    await cli(["patch", "--stdin"], {
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
});
