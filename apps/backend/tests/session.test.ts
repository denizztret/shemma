import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetConfigForTests } from "../src/config";
import { startServer } from "../src/index";

describe("GET /api/session", () => {
  beforeEach(() => {
    __resetConfigForTests();
  });

  afterEach(() => {
    __resetConfigForTests();
  });

  test("returns required shape with null sessionId when env unset", async () => {
    const prev = process.env.CLAUDE_SESSION_ID;
    try {
      delete process.env.CLAUDE_SESSION_ID;
      __resetConfigForTests();
      const srv = await startServer({ inMemory: true, port: 0 });
      const b = await fetch(`http://localhost:${srv.port}/api/session`).then(
        (r) => r.json(),
      );
      expect(b).toHaveProperty("sessionId");
      expect(b.sessionId).toBeNull();
      expect(typeof b.projectSlug).toBe("string");
      expect(b.projectSlug.length).toBeGreaterThan(0);
      expect(typeof b.workspaceDir).toBe("string");
      expect(b.workspaceDir.length).toBeGreaterThan(0);
      await srv.close();
    } finally {
      if (prev !== undefined) process.env.CLAUDE_SESSION_ID = prev;
      else delete process.env.CLAUDE_SESSION_ID;
      __resetConfigForTests();
    }
  });

  test("returns sessionId from CLAUDE_SESSION_ID env when set", async () => {
    const prev = process.env.CLAUDE_SESSION_ID;
    try {
      process.env.CLAUDE_SESSION_ID = "test-session-abc";
      __resetConfigForTests();
      const srv = await startServer({ inMemory: true, port: 0 });
      const b = await fetch(`http://localhost:${srv.port}/api/session`).then(
        (r) => r.json(),
      );
      expect(b.sessionId).toBe("test-session-abc");
      await srv.close();
    } finally {
      if (prev !== undefined) process.env.CLAUDE_SESSION_ID = prev;
      else delete process.env.CLAUDE_SESSION_ID;
      __resetConfigForTests();
    }
  });
});
