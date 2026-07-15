import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getUpdateBadge,
  updateCachePath,
  withTimeout,
} from "../src/menubar/update-cache";

let tmp: string;
let cache: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "menubar-upd-"));
  cache = path.join(tmp, "update.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const TTL = 6 * 3600_000;

describe("getUpdateBadge", () => {
  test("холодный кеш → зовёт check и пишет кеш", async () => {
    let calls = 0;
    const badge = await getUpdateBadge({
      cachePath: cache,
      ttlMs: TTL,
      now: 1_000_000,
      check: async () => {
        calls++;
        return { available: true, latest: "0.33.0" };
      },
    });
    expect(calls).toBe(1);
    expect(badge).toEqual({ available: true, latest: "0.33.0" });
    const raw = JSON.parse(fs.readFileSync(cache, "utf8"));
    expect(raw.checkedAt).toBe(1_000_000);
  });

  test("свежий кеш → check НЕ вызывается", async () => {
    fs.writeFileSync(
      cache,
      JSON.stringify({
        checkedAt: 1_000_000,
        badge: { available: false, latest: null },
      }),
    );
    let calls = 0;
    const badge = await getUpdateBadge({
      cachePath: cache,
      ttlMs: TTL,
      now: 1_000_000 + TTL - 1,
      check: async () => {
        calls++;
        return { available: true, latest: "9.9.9" };
      },
    });
    expect(calls).toBe(0);
    expect(badge.available).toBe(false);
  });

  test("протухший кеш → перепроверка", async () => {
    fs.writeFileSync(
      cache,
      JSON.stringify({
        checkedAt: 1_000_000,
        badge: { available: false, latest: null },
      }),
    );
    const badge = await getUpdateBadge({
      cachePath: cache,
      ttlMs: TTL,
      now: 1_000_000 + TTL + 1,
      check: async () => ({ available: true, latest: "0.33.0" }),
    });
    expect(badge.latest).toBe("0.33.0");
  });

  test("упавший check → available:false, кеш записан (не долбим сеть каждые 5с)", async () => {
    const badge = await getUpdateBadge({
      cachePath: cache,
      ttlMs: TTL,
      now: 42,
      check: async () => {
        throw new Error("offline");
      },
    });
    expect(badge).toEqual({ available: false, latest: null });
    const raw = JSON.parse(fs.readFileSync(cache, "utf8"));
    expect(raw.checkedAt).toBe(42);
  });

  test("битый кеш-файл → как холодный", async () => {
    fs.writeFileSync(cache, "{not json");
    const badge = await getUpdateBadge({
      cachePath: cache,
      ttlMs: TTL,
      now: 1,
      check: async () => ({ available: false, latest: null }),
    });
    expect(badge.available).toBe(false);
  });
});

describe("withTimeout", () => {
  test("быстрый промис проходит", async () => {
    const v = await withTimeout(Promise.resolve(7), 1000);
    expect(v).toBe(7);
  });

  test("медленный — reject по таймауту", async () => {
    const slow = new Promise((r) => setTimeout(() => r(1), 5000));
    await expect(withTimeout(slow, 20)).rejects.toThrow("timeout");
  });
});

describe("updateCachePath", () => {
  test("дефолт — ~/.claude/.shemma-menubar-update.json", () => {
    expect(updateCachePath()).toBe(
      path.join(os.homedir(), ".claude", ".shemma-menubar-update.json"),
    );
  });
});
