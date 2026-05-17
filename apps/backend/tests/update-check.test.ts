/**
 * Backend update-check tests (DRW-059 B2):
 *   - static manifest URL: direct fetch with optional Authorization header
 *   - GitHub API URL: two-hop (release JSON → release-manifest.json asset)
 *   - 404 / network failure → cache null, updateAvailable=false (silent)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { __resetCache, checkLatest } from "../src/update-check";
import { VERSION } from "../src/version";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

let server: ReturnType<typeof Bun.serve> | null = null;
let captured: CapturedRequest[] = [];
let handler: (req: Request) => Response | Promise<Response> = () =>
  new Response("not configured", { status: 500 });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const headersObj: Record<string, string> = {};
      for (const [k, v] of req.headers.entries()) headersObj[k.toLowerCase()] = v;
      captured.push({ url: req.url, headers: headersObj });
      return handler(req);
    },
  });
});

afterAll(() => {
  server?.stop(true);
  delete process.env.SHEMMA_MANIFEST_URL;
  delete process.env.SHEMMA_GITHUB_TOKEN;
});

beforeEach(() => {
  __resetCache();
  captured = [];
  delete process.env.SHEMMA_GITHUB_TOKEN;
});

afterEach(() => {
  handler = () => new Response("not configured", { status: 500 });
});

function baseUrl(): string {
  if (!server) throw new Error("server not started");
  return `http://${server.hostname}:${server.port}`;
}

describe("static manifest URL", () => {
  test("returns updateAvailable=true when version differs", async () => {
    handler = () =>
      new Response(
        JSON.stringify({
          channels: { [VERSION.channel]: { version: "999.0.0" } },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    process.env.SHEMMA_MANIFEST_URL = `${baseUrl()}/manifest.json`;
    const r = await checkLatest();
    expect(r.latest).toBe("999.0.0");
    expect(r.updateAvailable).toBe(true);
  });

  test("Authorization header sent when SHEMMA_GITHUB_TOKEN is set", async () => {
    handler = () =>
      new Response(
        JSON.stringify({ channels: { [VERSION.channel]: { version: "0.0.0" } } }),
        { headers: { "Content-Type": "application/json" } },
      );
    process.env.SHEMMA_MANIFEST_URL = `${baseUrl()}/manifest.json`;
    process.env.SHEMMA_GITHUB_TOKEN = "back-end-token";

    await checkLatest();

    expect(captured[0].headers.authorization).toBe("Bearer back-end-token");
    expect(captured[0].headers["user-agent"]).toBe("shemma-backend");
  });

  test("404 → silent failure (null latest, cached)", async () => {
    handler = () => new Response("nope", { status: 404 });
    process.env.SHEMMA_MANIFEST_URL = `${baseUrl()}/missing.json`;
    const r = await checkLatest();
    expect(r.latest).toBeNull();
    expect(r.updateAvailable).toBe(false);
  });

  test("malformed JSON → silent failure", async () => {
    handler = () => new Response("{not json", { headers: { "Content-Type": "application/json" } });
    process.env.SHEMMA_MANIFEST_URL = `${baseUrl()}/bad.json`;
    const r = await checkLatest();
    expect(r.latest).toBeNull();
    expect(r.updateAvailable).toBe(false);
  });
});

