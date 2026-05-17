import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/index";

/**
 * `/api/health` — DRW-052 extended health endpoint. Returns profile,
 * resolved storage path (honoring startServer({ storageDir }) override),
 * and version. Used by `didraw open` для daemon-conflict detection.
 *
 * `/healthz` — legacy boolean probe used by CanvasClient.health() и
 * Playwright wait-on. Must stay backward-compatible.
 */

let srv: { port: number; close: () => Promise<void> };
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "didraw-health-"));
  srv = await startServer({ port: 0, storageDir: dir });
});

afterAll(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /healthz (legacy)", () => {
  test("returns { ok: true } and 200", async () => {
    const r = await fetch(`http://localhost:${srv.port}/healthz`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toEqual({ ok: true });
  });
});

describe("GET /api/health (DRW-052)", () => {
  test("returns ok + profile + storage + version", async () => {
    const r = await fetch(`http://localhost:${srv.port}/api/health`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      ok: boolean;
      profile: string;
      storage: string;
      version: string;
    };
    expect(j.ok).toBe(true);
    expect(typeof j.profile).toBe("string");
    expect(j.storage).toBe(dir); // honors startServer override
    expect(typeof j.version).toBe("string");
  });

  test("storage matches the storageDir passed to startServer (not config default)", async () => {
    const r = await fetch(`http://localhost:${srv.port}/api/health`);
    const j = (await r.json()) as { storage: string };
    expect(j.storage).toBe(dir);
    expect(j.storage).not.toContain(".claude/projects");
  });
});
