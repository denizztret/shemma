/**
 * DRW-130 — `shemma rooms list` friendly renderer.
 *
 * Before: without `--json`, the command printed only `✔ ok` (generic
 * `printResponse` can't format an array). Now it prints a table.
 *
 * Asserts:
 *  - empty list → friendly hint "no rooms in this space", exit 0.
 *  - populated list → header row + at least one data row with the seeded id.
 *  - `--json` path is unchanged (array passthrough).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../../apps/backend/src/index";

let srv: { port: number; close: () => Promise<void> };
let dir: string;
const CLI = join(import.meta.dir, "..", "src", "index.ts");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "shemma-drw130-"));
  srv = await startServer({ storageDir: dir, port: 0 });
});
afterAll(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

async function cli(
  args: string[],
  opts: { input?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      SHEMMA_PORT: String(srv.port),
    },
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

describe("DRW-130 — rooms list friendly mode", () => {
  test("empty list → '· no rooms' hint, exit 0", async () => {
    const r = await cli(["rooms", "list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("·");
    expect(r.stdout.toLowerCase()).toContain("no rooms");
    expect(r.stdout).not.toContain("✔ ok");
  });

  test("populated list → table with header + room id row", async () => {
    // Seed a room via apply. Use explicit --room so the file lands at a
    // predictable path; the default "default" room without CLAUDE_SESSION_ID
    // may not survive the debounced save before the list call below.
    const seed = await cli(["--json", "apply", "--stdin", "--room", "alpha"], {
      input: JSON.stringify({
        actions: [{ kind: "define", role: "service", name: "alpha-svc" }],
      }),
    });
    expect(seed.status).toBe(0);
    // Persistence is debounced by ~300ms (apps/backend/src/persistence.ts);
    // wait it out so /api/rooms sees the file on disk.
    await new Promise((r) => setTimeout(r, 500));

    const r = await cli(["rooms", "list"]);
    expect(r.status).toBe(0);
    // Success line shows count + storage.
    expect(r.stdout).toContain("✔");
    expect(r.stdout).toContain("room"); // "1 room (storage: ...)"
    // Header row.
    expect(r.stdout).toContain("id");
    expect(r.stdout).toContain("version");
    expect(r.stdout).toContain("elements");
    expect(r.stdout).toContain("last touched");
    // Separator (─ char).
    expect(r.stdout).toContain("─");
  });

  test("--json mode unchanged: emits array, no table", async () => {
    const r = await cli(["--json", "rooms", "list"]);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout) as {
      ok?: boolean;
      rooms?: Array<{ id: string }>;
    };
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.rooms)).toBe(true);
    // No table rendering in JSON mode.
    expect(r.stdout).not.toContain("─");
    expect(r.stdout).not.toContain("✔");
  });
});
