/**
 * DRW-138 regression — WS upgrade must respect daemonMode-derived
 * `enableSpaceMiddleware`, not just the explicit opt.
 *
 * The previous bug: `resolveWsSpace` read `opts.enableSpaceMiddleware`
 * directly (undefined when callers relied on the daemonMode default), so
 * the WS path silently fell back to the legacy bundle while HTTP routes
 * correctly used the daemonMode-derived `true`. The result was two
 * in-memory states for the same `(space, room)` pair — HTTP read one,
 * WS wrote into the other, and user-added shapes vanished on reload.
 *
 * The fix extracts `effectiveSpaceMiddleware = opts.enableSpaceMiddleware
 * ?? daemonMode` once and uses the same value in both makeApp() and
 * resolveWsSpace(). This test guards that invariant by simulating daemon
 * mode (SHEMMA_LOCK_DIR set) without passing `enableSpaceMiddleware`
 * explicitly, then asserting WS upgrades behave like the registry IS
 * authoritative (unknown space → 400, not silent legacy fallback).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetRoomCacheForTests, startServer } from "../src/index";

let tmpXdg: string;
let tmpLockDir: string;
let origXdg: string | undefined;
let origLock: string | undefined;

beforeEach(() => {
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "ws-dmm-xdg-"));
  tmpLockDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-dmm-lock-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  origLock = process.env.SHEMMA_LOCK_DIR;
  process.env.XDG_CONFIG_HOME = tmpXdg;
  process.env.SHEMMA_LOCK_DIR = tmpLockDir;
  __resetRoomCacheForTests();
});

afterEach(() => {
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  if (origLock === undefined) delete process.env.SHEMMA_LOCK_DIR;
  else process.env.SHEMMA_LOCK_DIR = origLock;
  fs.rmSync(tmpXdg, { recursive: true, force: true });
  fs.rmSync(tmpLockDir, { recursive: true, force: true });
  __resetRoomCacheForTests();
});

describe("DRW-138 — WS upgrade honours daemonMode-derived middleware default", () => {
  test("daemonMode=true + no explicit enableSpaceMiddleware → unknown ?space= rejected (400)", async () => {
    // Simulate daemon mode WITHOUT passing `enableSpaceMiddleware` explicitly.
    // Before the fix, resolveWsSpace fell back to legacy (200 upgrade) instead
    // of using the daemonMode default. After the fix it must reject the unknown
    // space exactly the same as if the opt was passed explicitly.
    const srv = await startServer({
      inMemory: true,
      port: 0,
      // NOTE: enableSpaceMiddleware NOT passed — relies on daemonMode default.
    });
    try {
      const res = await fetch(
        `http://localhost:${srv.port}/ws?space=unregistered-space&room=foo`,
      );
      // Bun returns the upgrade failure as a normal HTTP response when no
      // Upgrade headers are sent (raw fetch). 400 = "invalid space id".
      expect(res.status).toBe(400);
    } finally {
      await srv.close();
    }
  });

  test("daemonMode=true + registered space → WS upgrade succeeds", async () => {
    const spaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-dmm-space-"));
    const srv = await startServer({
      inMemory: true,
      port: 0,
      // Again — no explicit middleware opt; rely on daemonMode default.
    });
    try {
      const reg = await fetch(`http://localhost:${srv.port}/api/spaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: spaceDir, label: "Test" }),
      });
      expect(reg.ok).toBe(true);
      const { space } = (await reg.json()) as { space: { id: string } };

      const ws = new WebSocket(
        `ws://localhost:${srv.port}/ws?space=${space.id}&room=foo`,
      );
      const opened = await new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(true);
        ws.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 1500);
      });
      expect(opened).toBe(true);
      ws.close();
    } finally {
      await srv.close();
      fs.rmSync(spaceDir, { recursive: true, force: true });
    }
  });
});
