/**
 * DRW-131 — top-level --space flag threads through non-domain CLI commands.
 *
 * DRW-125 fixed domain commands (define/connect/group/...). This test pins
 * the same contract for lifecycle, data, prompts, and ai commands: they all
 * accept --space and exit 1 with a hint when the space middleware rejects
 * the request.
 *
 * XDG isolation per feedback-cli-tests-xdg-isolation.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSpace } from "@shemma/spaces";
import { startServer } from "../../../apps/backend/src/index";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
let srv: { port: number; close: () => Promise<void> };
let xdgRoot: string;
let spaceRoot: string;
let registeredId: string;

beforeAll(async () => {
  xdgRoot = realpathSync(mkdtempSync(join(tmpdir(), "shemma-drw131-xdg-")));
  spaceRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "shemma-drw131-space-")),
  );
  process.env.XDG_CONFIG_HOME = xdgRoot;
  const { space } = registerSpace(spaceRoot, {
    storageLayout: "project",
    label: "drw-131-space",
  });
  registeredId = space.id;
  srv = await startServer({
    port: 0,
    enableSpaceMiddleware: true,
  });
});
afterAll(async () => {
  await srv.close();
  rmSync(xdgRoot, { recursive: true, force: true });
  rmSync(spaceRoot, { recursive: true, force: true });
});

type RunOpts = { json?: boolean; space?: string; input?: string };
async function run(args: string[], opts: RunOpts = {}) {
  const argv = [
    ...(opts.json ? ["--json"] : []),
    ...(opts.space !== undefined ? ["--space", opts.space] : []),
    ...args,
  ];
  const proc = Bun.spawn(["bun", CLI, ...argv], {
    env: {
      ...(process.env as Record<string, string>),
      SHEMMA_PORT: String(srv.port),
      XDG_CONFIG_HOME: xdgRoot,
    },
    stdin: opts.input !== undefined ? Buffer.from(opts.input) : "ignore",
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

describe("DRW-131 — non-domain commands thread --space", () => {
  test("rooms list with valid --space → exit 0", async () => {
    const r = await run(["rooms", "list"], {
      json: true,
      space: registeredId,
    });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout) as { ok: boolean; rooms: unknown[] };
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.rooms)).toBe(true);
  });

  test("rooms list without --space → exit 1 + hint", async () => {
    const r = await run(["rooms", "list"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("✖");
    expect(r.stderr.toLowerCase()).toMatch(/space/);
    expect(r.stderr).toContain("→");
  });

  test("rooms archive without --space → exit 1", async () => {
    const r = await run(["rooms", "archive", "nonexistent"]);
    expect(r.status).toBe(1);
  });

  test("prompts list without --space → exit 1", async () => {
    const r = await run(["prompts", "list"]);
    expect(r.status).toBe(1);
  });

  test("ai status without --space → exit 1", async () => {
    const r = await run(["ai", "status"]);
    expect(r.status).toBe(1);
  });

  test("clear without --space → exit 1 (space error trumps confirm)", async () => {
    // --confirm passed so we don't trip on the usage check first.
    const r = await run(["clear", "--confirm", "--room", "x"]);
    expect(r.status).toBe(1);
  });
});
