// DRW-088: Unit tests for tidy-layout helper.
//
// Scope:
//   - tidyLayout sends POST /api/agent/layout-selection with correct ids/room
//   - tidyLayout returns noop result on empty ids
//   - hotkey handler calls tidyLayout on ⌘⇧L / Ctrl+Shift+L
//   - hotkey does NOT fire on unrelated keys

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal fake editor for test purposes
// ---------------------------------------------------------------------------
type FakeEditor = {
  getSelectedShapeIds: () => string[];
};

function makeFakeEditor(selectedIds: string[] = []): FakeEditor {
  return {
    getSelectedShapeIds: () => selectedIds,
  };
}

// ---------------------------------------------------------------------------
// Tests for tidyLayout helper (pure fetch logic)
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => { body: unknown; status?: number }) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    const { body, status = 200 } = handler(u, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("tidyLayout helper", () => {
  test("returns noop when ids.length < 2", async () => {
    const { tidyLayout } = await import("./tidy-layout");
    const result = await tidyLayout([], "__legacy__", "test-room");
    expect(result.kind).toBe("noop");
  });

  test("POSTs to /api/agent/layout-selection with space + room query params and ids in body", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, count: 2, affected: ["shape:a", "shape:b"] } };
    });
    const { tidyLayout } = await import("./tidy-layout");
    const result = await tidyLayout(["shape:a", "shape:b"], "ws-7", "myroom");
    expect(capturedUrl).toContain("/api/agent/layout-selection");
    expect(capturedUrl).toContain("space=ws-7");
    expect(capturedUrl).toContain("room=myroom");
    expect((capturedBody as { ids: string[] }).ids).toEqual(["shape:a", "shape:b"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.count).toBe(2);
    }
  });

  test("returns error result on non-ok response", async () => {
    mockFetch(() => ({ body: { ok: false, error: "no shapes found" }, status: 400 }));
    const { tidyLayout } = await import("./tidy-layout");
    const result = await tidyLayout(["a", "b"], "__legacy__", "r");
    expect(result.kind).toBe("error");
  });

  test("returns error result on network failure", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: replacing fetch with minimal throwing mock in test
    globalThis.fetch = (async () => {
      throw new Error("network error");
    }) as unknown as typeof fetch;
    const { tidyLayout } = await import("./tidy-layout");
    const result = await tidyLayout(["a", "b"], "__legacy__", "r");
    expect(result.kind).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Tests for makeTidyHotkeyHandler
// ---------------------------------------------------------------------------

// Fake KeyboardEvent-like object for Bun (no DOM in Bun test env).
function fakeKey(opts: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}): { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; preventDefault: () => void } {
  return {
    key: opts.key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    preventDefault: () => {},
  };
}

describe("makeTidyHotkeyHandler hotkey wiring", () => {
  test("fires callback on Cmd+Shift+L (Mac)", async () => {
    const { makeTidyHotkeyHandler } = await import("./tidy-layout");
    const calls: string[][] = [];
    const handler = makeTidyHotkeyHandler(
      () => ["shape:a", "shape:b"],
      (ids) => { calls.push(ids); },
    );
    // biome-ignore lint/suspicious/noExplicitAny: plain object substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "L", metaKey: true, shiftKey: true }) as any);
    expect(calls).toEqual([["shape:a", "shape:b"]]);
  });

  test("fires callback on Ctrl+Shift+L (non-Mac)", async () => {
    const { makeTidyHotkeyHandler } = await import("./tidy-layout");
    const calls: string[][] = [];
    const handler = makeTidyHotkeyHandler(
      () => ["shape:a"],
      (ids) => { calls.push(ids); },
    );
    // biome-ignore lint/suspicious/noExplicitAny: plain object substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "L", ctrlKey: true, shiftKey: true }) as any);
    expect(calls).toHaveLength(1);
  });

  test("does NOT fire on unrelated key combo", async () => {
    const { makeTidyHotkeyHandler } = await import("./tidy-layout");
    const calls: string[][] = [];
    const handler = makeTidyHotkeyHandler(
      () => ["shape:a", "shape:b"],
      (ids) => { calls.push(ids); },
    );
    // Ctrl+L without Shift
    // biome-ignore lint/suspicious/noExplicitAny: plain object substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "L", ctrlKey: true, shiftKey: false }) as any);
    // Ctrl+Shift+K
    // biome-ignore lint/suspicious/noExplicitAny: plain object substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "K", ctrlKey: true, shiftKey: true }) as any);
    expect(calls).toHaveLength(0);
  });

  test("passes empty array when no shapes selected → callback still called (let tidyLayout handle)", async () => {
    const { makeTidyHotkeyHandler } = await import("./tidy-layout");
    const calls: string[][] = [];
    const handler = makeTidyHotkeyHandler(
      () => [],
      (ids) => { calls.push(ids); },
    );
    // biome-ignore lint/suspicious/noExplicitAny: plain object substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "L", metaKey: true, shiftKey: true }) as any);
    expect(calls).toEqual([[]]);
  });
});
