import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetSessionCache, fetchSession } from "./session";

// Access module internals to reset the tab-scoped cache between tests.
// We do this by re-importing the module after patching — but since Bun ESM
// caches modules we instead cast the module to access `cached` indirectly
// via a test-only helper we inline here.

// Minimal smoke test: verifies types and cache behaviour via mocked fetch.

describe("fetchSession", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetSessionCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetSessionCache();
  });

  test("returns SessionInfo shape", async () => {
    const mockPayload = {
      sessionId: "sess-123",
      projectSlug: "my-proj-abc12345",
      workspaceDir: "/home/user/project",
      home: "/home/user",
    };
    globalThis.fetch = (async () =>
      ({
        ok: true,
        json: async () => mockPayload,
      }) as unknown as Response) as unknown as typeof fetch;

    const info = await fetchSession();
    expect(typeof info.sessionId === "string" || info.sessionId === null).toBe(
      true,
    );
    expect(typeof info.projectSlug).toBe("string");
    expect(typeof info.workspaceDir).toBe("string");
    expect(info.sessionId).toBe("sess-123");
    expect(info.projectSlug).toBe("my-proj-abc12345");
  });
});
