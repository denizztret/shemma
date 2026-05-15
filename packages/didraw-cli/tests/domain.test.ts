import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer } from "../../../apps/backend/src/index";

let srv: { port: number; close: () => Promise<void> };
const CLI = join(import.meta.dir, "..", "src", "index.ts");

beforeAll(async () => {
  srv = await startServer({ inMemory: true, port: 0 });
});
afterAll(async () => {
  await srv.close();
});

const envFor = (room: string): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  DIDRAW_PORT: String(srv.port),
  CLAUDE_SESSION_ID: room,
});

async function cli(args: string[], env: Record<string, string>, input?: string) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env,
    stdin: input !== undefined ? Buffer.from(input) : "ignore",
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

describe("didraw domain CLI", () => {
  test("define service auth → context shows auth", async () => {
    const env = envFor("d-cli-1");
    const def = await cli(["define", "service", "auth"], env);
    expect(def.status).toBe(0);
    expect(JSON.parse(def.stdout).ok).toBe(true);

    const ctx = await cli(["context"], env);
    expect(ctx.status).toBe(0);
    const body = JSON.parse(ctx.stdout);
    expect(body.summary.byRole.service).toBe(1);
  });

  test("apply --stdin with batch", async () => {
    const env = envFor("d-cli-2");
    const batch = JSON.stringify({
      actions: [
        { kind: "define", role: "service", name: "a" },
        { kind: "define", role: "datastore", name: "b" },
        { kind: "connect", from: "a", to: "b" },
      ],
    });
    const r = await cli(["apply", "--stdin"], env, batch);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });

  test("define unknown role → exit 1", async () => {
    const env = envFor("d-cli-3");
    const r = await cli(["define", "frobnicator", "x"], env);
    expect(r.status).toBe(1);
  });

  test("group multiple ids", async () => {
    const env = envFor("d-cli-4");
    await cli(["define", "service", "a"], env);
    await cli(["define", "service", "b"], env);
    const r = await cli(["group", "a,b", "--as", "network", "--name", "vpc"], env);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });
});
