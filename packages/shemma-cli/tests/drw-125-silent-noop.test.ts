/**
 * DRW-125 — silent noop regression: domain CLI commands used to print "✔ ok"
 * and exit 0 even when the backend rejected the request with an error envelope
 * lacking the `ok` field (e.g. `{error: "invalid_space_id"}` from
 * apps/backend/src/middleware/space.ts). Two faces of the same bug:
 *
 *   1. `clientFor` ignored `--space` so every domain call shipped
 *      `?space=__legacy__`, which fails SPACE_ID_PATTERN → invalid_space_id.
 *   2. `printAndExitOnFail` and `printResponse` keyed on `ok === false`, so
 *      middleware errors slipped through both gates → exit 0 + ✔ ok.
 *
 * This test boots an in-memory server with `enableSpaceMiddleware: true`
 * (production daemon behaviour) and confirms:
 *   - Without `--space` and no `default` space registered → exit 1 in both
 *     JSON and human modes; human mode emits ✖ + a `→` hint pointing at
 *     `shemma s list` / `--space`.
 *   - With `--space <invalid>` → exit 1 with `invalid_space_id` in stderr.
 *   - With `--space <registered>` → exit 0 and the request actually lands
 *     (state read-back confirms the shape exists).
 *
 * XDG isolation per `feedback-cli-tests-xdg-isolation` — the registry write
 * goes into a tmpdir, never the user's real ~/.config/shemma.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  xdgRoot = mkdtempSync(join(tmpdir(), "shemma-drw125-xdg-"));
  spaceRoot = mkdtempSync(join(tmpdir(), "shemma-drw125-space-"));
  process.env.XDG_CONFIG_HOME = xdgRoot;
  const { space } = registerSpace(spaceRoot, {
    storageLayout: "project",
    label: "drw-125-space",
  });
  registeredId = space.id;
  srv = await startServer({
    inMemory: true,
    port: 0,
    enableSpaceMiddleware: true,
  });
});
afterAll(async () => {
  await srv.close();
  rmSync(xdgRoot, { recursive: true, force: true });
  rmSync(spaceRoot, { recursive: true, force: true });
});

type RunOpts = { json?: boolean; space?: string };
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
      CLAUDE_SESSION_ID: "drw-125-room",
    },
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

describe("DRW-125 — silent noop fix", () => {
  test("human mode: no --space → exit 1, stderr has ✖ + hint, stdout has NO ✔", async () => {
    const r = await run(["define", "service", "auth"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("✖");
    expect(r.stderr.toLowerCase()).toMatch(/space/);
    expect(r.stderr).toContain("→");
    expect(r.stdout).not.toContain("✔");
  });

  test("JSON mode: no --space → exit 1, stdout has error envelope", async () => {
    const r = await run(["define", "service", "auth"], { json: true });
    expect(r.status).toBe(1);
    const body = JSON.parse(r.stdout);
    expect(body.error).toBeDefined();
  });

  test("human mode: invalid --space → exit 1, stderr mentions invalid_space_id", async () => {
    // `__legacy__` matches none of the registered ids and fails SPACE_ID_PATTERN.
    const r = await run(["define", "service", "x"], { space: "__legacy__" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("invalid_space_id");
    expect(r.stderr).toContain("→");
  });

  test("JSON mode: invalid --space → exit 1", async () => {
    const r = await run(["define", "service", "x"], {
      json: true,
      space: "__legacy__",
    });
    expect(r.status).toBe(1);
    const body = JSON.parse(r.stdout);
    expect(body.error).toBe("invalid_space_id");
  });

  test("valid --space → exit 0 and the write actually lands", async () => {
    const r = await run(["define", "service", "billing", "--label", "Billing"], {
      json: true,
      space: registeredId,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);

    const ctx = await run(["context"], { json: true, space: registeredId });
    expect(ctx.status).toBe(0);
    const body = JSON.parse(ctx.stdout) as {
      ok: true;
      elements: Array<{ id: string; role?: string }>;
    };
    const billing = body.elements.find((e) => e.id === "billing");
    expect(billing).toBeDefined();
    expect(billing?.role).toBe("service");
  });

  test("SHEMMA_SPACE env is honoured when --space is not passed", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        CLI,
        "--json",
        "define",
        "service",
        "metrics",
        "--label",
        "Metrics",
      ],
      {
        env: {
          ...(process.env as Record<string, string>),
          SHEMMA_PORT: String(srv.port),
          XDG_CONFIG_HOME: xdgRoot,
          SHEMMA_SPACE: registeredId,
          CLAUDE_SESSION_ID: "drw-125-room",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [status, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
  });
});
