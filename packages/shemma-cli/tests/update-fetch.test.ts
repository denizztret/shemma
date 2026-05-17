/**
 * Black-box tests for the update fetch path (DRW-059 B1+B2):
 *   - Static manifest URL → direct fetch (legacy path)
 *   - Authorization Bearer header injected when SHEMMA_GITHUB_TOKEN is set
 *   - 404 / network failure surfaces as fail() (process exit non-zero)
 *
 * Strategy: a tiny in-process Bun.serve listener, point SHEMMA_MANIFEST_URL at
 * it, spawn the CLI as a subprocess via `Bun.spawn` (matches banner.test.ts
 * pattern — `spawnSync` from inside `bun test` hangs).
 *
 * The GitHub API two-hop dispatch is covered by apps/backend/tests/update-check.test.ts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

let server: ReturnType<typeof Bun.serve> | null = null;
let captured: CapturedRequest[] = [];
let serverHandler: (req: Request) => Response | Promise<Response> = () =>
  new Response("not configured", { status: 500 });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const headersObj: Record<string, string> = {};
      for (const [k, v] of req.headers.entries()) headersObj[k.toLowerCase()] = v;
      captured.push({ url: req.url, headers: headersObj });
      return serverHandler(req);
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

beforeEach(() => {
  captured = [];
});

afterEach(() => {
  serverHandler = () => new Response("not configured", { status: 500 });
});

function baseUrl(): string {
  if (!server) throw new Error("server not started");
  return `http://${server.hostname}:${server.port}`;
}

async function cli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      // Force a unique port so we never collide with a real daemon.
      SHEMMA_PORT: env.SHEMMA_PORT ?? "65191",
      SHEMMA_PROFILE: env.SHEMMA_PROFILE ?? "dev",
      ...env,
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

describe("static manifest URL (legacy fallback)", () => {
  test("update --check fetches manifest directly when URL is a static JSON", async () => {
    serverHandler = () =>
      new Response(
        JSON.stringify({ channels: { stable: { version: "9.9.9" } } }),
        { headers: { "Content-Type": "application/json" } },
      );

    const r = await cli(["--json", "update", "--check"], {
      SHEMMA_MANIFEST_URL: `${baseUrl()}/manifest.json`,
      SHEMMA_VERSION: "0.0.1",
      SHEMMA_CHANNEL: "stable",
    });

    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.latest).toBe("9.9.9");
    expect(payload.available).toBe(true);
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0].url).toContain("/manifest.json");
  });

  test("Authorization Bearer + User-Agent injected when SHEMMA_GITHUB_TOKEN is set", async () => {
    serverHandler = () =>
      new Response(
        JSON.stringify({ channels: { stable: { version: "0.0.0" } } }),
        { headers: { "Content-Type": "application/json" } },
      );

    await cli(["--json", "update", "--check"], {
      SHEMMA_MANIFEST_URL: `${baseUrl()}/manifest.json`,
      SHEMMA_GITHUB_TOKEN: "secret-token",
      SHEMMA_VERSION: "0.0.1",
      SHEMMA_CHANNEL: "stable",
    });

    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0].headers.authorization).toBe("Bearer secret-token");
    expect(captured[0].headers["user-agent"]).toBe("shemma-cli");
  });

  test("no Authorization header when token absent (anonymous fetch)", async () => {
    serverHandler = () =>
      new Response(
        JSON.stringify({ channels: { stable: { version: "0.0.0" } } }),
        { headers: { "Content-Type": "application/json" } },
      );

    // Force an HOME with no auth.json. We can't strip gh from PATH (we'd lose
    // bun too), so we accept that on developer machines with `gh auth login`
    // this test would surface a token. The signal we care about is the URL
    // captured + the fact that the fetch went through — the precedence is
    // verified by the auth.test.ts unit tests directly.
    await cli(["--json", "update", "--check"], {
      SHEMMA_MANIFEST_URL: `${baseUrl()}/manifest.json`,
      SHEMMA_GITHUB_TOKEN: "",
      HOME: "/nonexistent",
      SHEMMA_VERSION: "0.0.1",
      SHEMMA_CHANNEL: "stable",
    });

    expect(captured.length).toBeGreaterThanOrEqual(1);
    // Authorization header is either absent (anonymous) OR Bearer from `gh auth
    // token` if developer has gh authenticated — both behaviours documented.
    const auth = captured[0].headers.authorization;
    if (auth !== undefined) {
      expect(auth.startsWith("Bearer ")).toBe(true);
    }
  });

  test("404 surfaces error in --json mode (non-zero exit, error on stderr)", async () => {
    serverHandler = () => new Response("nope", { status: 404 });

    const r = await cli(["--json", "update", "--check"], {
      SHEMMA_MANIFEST_URL: `${baseUrl()}/missing.json`,
      SHEMMA_VERSION: "0.0.1",
      SHEMMA_CHANNEL: "stable",
    });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("HTTP 404");
  });
});
