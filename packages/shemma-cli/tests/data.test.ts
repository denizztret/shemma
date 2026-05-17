import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer } from "../../../apps/backend/src/index";

let srv: { port: number; close: () => Promise<void> };
const CLI = join(import.meta.dir, "..", "src", "index.ts");

const envFor = (room: string): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  SHEMMA_PORT: String(srv.port),
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
  // Group A (DRW-056): default output is friendly; tests opt-in to --json.
  const proc = Bun.spawn(["bun", CLI, "--json", ...args], {
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

describe("shemma data commands", () => {
  test("state --compact on empty room returns new TLStoreSnapshot shape", async () => {
    // Phase 3.0: /api/state shape changed from { canvas, version, prompts }
    // to { store: TLStoreSnapshot, version, prompts, aiActivity } (spec §10).
    const r = await cli(["state", "--compact"], { env: envFor("d1") });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout) as {
      version: number;
      store: { store?: Record<string, { typeName?: string }> };
      prompts: unknown[];
      aiActivity: unknown | null;
    };
    expect(j.version).toBe(0);
    expect(j.prompts).toEqual([]);
    // Empty room — no user-created shapes, only tldraw scaffolding records.
    const records = Object.values(j.store.store ?? {});
    expect(records.some((rec) => rec.typeName === "shape")).toBe(false);
  });

  // NOTE: tests for `patch --stdin` and `clear --confirm` were removed in
  // Phase 3.0 — `/api/patch` was deleted (spec §10). Equivalent mutations now
  // go through `shemma apply --stdin` / `shemma delete <id>` (see domain.test.ts
  // and room-flag.test.ts).
});
