import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer } from "../../../apps/backend/src/index";

let srv: { port: number; close: () => Promise<void> };
const CLI = join(import.meta.dir, "..", "src", "index.ts");

const envFor = (room: string): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  DIDRAW_PORT: String(srv.port),
  CLAUDE_SESSION_ID: room,
});

/**
 * Async spawn helper. spawnSync blocks the bun event loop, which prevents
 * Bun.serve (the in-process test server) from handling requests.
 * Bun.spawn is async and lets the event loop run between awaits.
 */
async function cli(
  args: string[],
  opts: { env?: Record<string, string>; input?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: opts.env ?? {},
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

beforeAll(async () => {
  srv = await startServer({ inMemory: true, port: 0 });
});
afterAll(async () => {
  await srv.close();
});

describe("didraw data commands", () => {
  test("state --compact on empty room", async () => {
    const r = await cli(["state", "--compact"], { env: envFor("d1") });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.canvas.nodes).toEqual([]);
  });

  test("patch --stdin applies ops", async () => {
    const body = JSON.stringify({
      ops: [
        {
          op: "add",
          target: "node",
          value: { id: "n1", kind: "rect", x: 0, y: 0 },
        },
      ],
      source: "ai",
    });
    const r = await cli(["patch", "--stdin"], {
      env: envFor("d2"),
      input: body,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, version: 1 });
  });

  test("patch with invalid ops → exit 1, error in stdout", async () => {
    const body = JSON.stringify({
      ops: [
        {
          op: "add",
          target: "edge",
          value: {
            id: "e",
            from: { kind: "node", id: "missing" },
            to: { kind: "node", id: "x" },
          },
        },
      ],
      source: "ai",
    });
    const r = await cli(["patch", "--stdin"], {
      env: envFor("d3"),
      input: body,
    });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  test("clear empties room", async () => {
    const env4 = envFor("d4");
    await cli(["patch", "--stdin"], {
      env: env4,
      input: JSON.stringify({
        ops: [
          {
            op: "add",
            target: "node",
            value: { id: "n1", kind: "rect", x: 0, y: 0 },
          },
        ],
        source: "ai",
      }),
    });
    const r = await cli(["clear", "--confirm"], { env: env4 });
    expect(r.status).toBe(0);
    const after = await cli(["state"], { env: env4 });
    expect(JSON.parse(after.stdout).canvas.nodes).toEqual([]);
  });
});
