import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";
import { resolveRoomId, validateRoomId } from "../src/rooms";

describe("validateRoomId", () => {
  test.each([
    "auth",
    "users-db",
    "design_v2",
    "ROOM-1",
    "a",
    "x".repeat(64),
  ])("accepts %s", (id) => {
    expect(validateRoomId(id)).toBe(true);
  });

  test.each([
    "",
    "x".repeat(65),
    "with space",
    "with/slash",
    "with..dots",
    "../etc/passwd",
    "name!",
    "имя",
  ])("rejects %s", (id) => {
    expect(validateRoomId(id)).toBe(false);
  });
});

describe("resolveRoomId chain", () => {
  const ORIG_SESSION = process.env.CLAUDE_SESSION_ID;
  beforeEach(() => {
    delete process.env.CLAUDE_SESSION_ID;
  });
  afterEach(() => {
    if (ORIG_SESSION !== undefined) {
      process.env.CLAUDE_SESSION_ID = ORIG_SESSION;
    }
  });

  test("explicit raw wins over CLAUDE_SESSION_ID env", () => {
    process.env.CLAUDE_SESSION_ID = "sess-id";
    const r = resolveRoomId("explicit");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBe("explicit");
  });

  test("CLAUDE_SESSION_ID env fallback when raw missing", () => {
    process.env.CLAUDE_SESSION_ID = "sess-abc";
    const r = resolveRoomId(undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBe("sess-abc");
  });

  test("default when raw and env both missing", () => {
    const r = resolveRoomId(undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBe("default");
  });

  test("invalid env var → 422 reason returned", () => {
    process.env.CLAUDE_SESSION_ID = "invalid id with space";
    const r = resolveRoomId(undefined);
    expect(r.ok).toBe(false);
  });
});

describe("route-level validation", () => {
  test("state endpoint rejects invalid room id with 422", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(
      new Request("http://localhost/api/state?room=" + encodeURIComponent("bad name")),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("invalid room id");
  });
});
