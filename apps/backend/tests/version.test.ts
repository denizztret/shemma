import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../src/index";
import { __resetCache } from "../src/update-check";

// Point manifest URL at an address that refuses connections instantly so
// tests are fast, offline-safe, and checkLatest() returns {updateAvailable:false}.
beforeAll(() => {
  process.env.SHEMMA_MANIFEST_URL = "http://127.0.0.1:1/nope";
});

afterAll(() => {
  process.env.SHEMMA_MANIFEST_URL = undefined;
  __resetCache();
});

describe("GET /api/version", () => {
  test("returns all required fields", async () => {
    __resetCache();
    const srv = await startServer({ inMemory: true, port: 0 });
    const b = await fetch(`http://localhost:${srv.port}/api/version`).then(
      (r) => r.json(),
    );
    expect(typeof b.version).toBe("string");
    expect(b.version.length).toBeGreaterThan(0);
    expect(b).toHaveProperty("channel");
    expect(b).toHaveProperty("profile");
    expect(b).toHaveProperty("updateAvailable");
    expect(b).toHaveProperty("gitSha");
    expect(b).toHaveProperty("buildDate");
    await srv.close();
  });

  test("updateAvailable is false when manifest is unreachable", async () => {
    __resetCache();
    const srv = await startServer({ inMemory: true, port: 0 });
    const b = await fetch(`http://localhost:${srv.port}/api/version`).then(
      (r) => r.json(),
    );
    expect(b.updateAvailable).toBe(false);
    expect(b.latest).toBeNull();
    await srv.close();
  });
});
