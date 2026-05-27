// DRW-088: Unit tests for tidy-layout helper.
//
// Scope:
//   - tidyLayout sends POST /api/agent/layout-selection with correct ids/room
//   - tidyLayout returns noop result on empty ids
//   - hotkey handler calls tidyLayout on ⌘⇧L / Ctrl+Shift+L
//   - hotkey does NOT fire on unrelated keys
//   - scopeFor heuristic (frame-container, spec 5.2)
//   - tidyLayout passes scope to backend

import { afterEach, describe, expect, test } from "bun:test";
import type { Editor } from "tldraw";

// ---------------------------------------------------------------------------
// Minimal fake editor for test purposes
// ---------------------------------------------------------------------------
type FakeShape = { id: string; type: string };

function makeFakeEditor(shapes: FakeShape[] = []): Editor {
  const map = new Map(shapes.map((s) => [s.id, s]));
  return {
    getShape: (id: string) => map.get(id),
    getSelectedShapeIds: () => shapes.map((s) => s.id),
  } as unknown as Editor;
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
  test("DRW-149: single id passes through to backend (no noop short-circuit)", async () => {
    mockFetch(() => ({ body: { ok: true, count: 0, affected: [] } }));
    const { tidyLayout } = await import("./tidy-layout");
    const r = await tidyLayout(["shape:foo"], "default", "test-room");
    expect(r.kind).toBe("ok");
  });

  test("returns noop when ids.length === 0", async () => {
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
    const calls: Array<{ ids: string[]; scope: string }> = [];
    const editor = makeFakeEditor([
      { id: "shape:a", type: "geo" },
      { id: "shape:b", type: "geo" },
    ]);
    const handler = makeTidyHotkeyHandler(
      () => ["shape:a", "shape:b"],
      editor,
      (ids, scope) => { calls.push({ ids, scope }); },
    );
    // biome-ignore lint/suspicious/noExplicitAny: plain object substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "L", metaKey: true, shiftKey: true }) as any);
    expect(calls).toEqual([{ ids: ["shape:a", "shape:b"], scope: "auto" }]);
  });

  test("fires callback on Ctrl+Shift+L (non-Mac)", async () => {
    const { makeTidyHotkeyHandler } = await import("./tidy-layout");
    const calls: Array<{ ids: string[]; scope: string }> = [];
    const editor = makeFakeEditor([{ id: "shape:a", type: "geo" }]);
    const handler = makeTidyHotkeyHandler(
      () => ["shape:a"],
      editor,
      (ids, scope) => { calls.push({ ids, scope }); },
    );
    // biome-ignore lint/suspicious/noExplicitAny: plain object substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "L", ctrlKey: true, shiftKey: true }) as any);
    expect(calls).toHaveLength(1);
  });

  test("does NOT fire on unrelated key combo", async () => {
    const { makeTidyHotkeyHandler } = await import("./tidy-layout");
    const calls: Array<{ ids: string[]; scope: string }> = [];
    const editor = makeFakeEditor([
      { id: "shape:a", type: "geo" },
      { id: "shape:b", type: "geo" },
    ]);
    const handler = makeTidyHotkeyHandler(
      () => ["shape:a", "shape:b"],
      editor,
      (ids, scope) => { calls.push({ ids, scope }); },
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
    const calls: Array<{ ids: string[]; scope: string }> = [];
    const editor = makeFakeEditor([]);
    const handler = makeTidyHotkeyHandler(
      () => [],
      editor,
      (ids, scope) => { calls.push({ ids, scope }); },
    );
    // biome-ignore lint/suspicious/noExplicitAny: plain object substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "L", metaKey: true, shiftKey: true }) as any);
    expect(calls).toEqual([{ ids: [], scope: "auto" }]);
  });

  test("derives scope='self' for single schema-container selection (frame-container fix)", async () => {
    const { makeTidyHotkeyHandler } = await import("./tidy-layout");
    const calls: Array<{ ids: string[]; scope: string }> = [];
    const editor = makeFakeEditor([{ id: "shape:cont", type: "schema-container" }]);
    const handler = makeTidyHotkeyHandler(
      () => ["shape:cont"],
      editor,
      (ids, scope) => { calls.push({ ids, scope }); },
    );
    // biome-ignore lint/suspicious/noExplicitAny: plain object substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "L", metaKey: true, shiftKey: true }) as any);
    expect(calls).toEqual([{ ids: ["shape:cont"], scope: "self" }]);
  });
});

// ---------------------------------------------------------------------------
// scopeFor heuristic — frame-container fix (spec 5.2)
// ---------------------------------------------------------------------------
describe("scopeFor heuristic", () => {
  test("single schema-container → 'self'", async () => {
    const { scopeFor } = await import("./tidy-layout");
    const editor = makeFakeEditor([{ id: "shape:cont", type: "schema-container" }]);
    expect(scopeFor(["shape:cont"], editor)).toBe("self");
  });

  test("single frame → 'self'", async () => {
    const { scopeFor } = await import("./tidy-layout");
    const editor = makeFakeEditor([{ id: "shape:frame", type: "frame" }]);
    expect(scopeFor(["shape:frame"], editor)).toBe("self");
  });

  test("single leaf (geo) → 'auto'", async () => {
    const { scopeFor } = await import("./tidy-layout");
    const editor = makeFakeEditor([{ id: "shape:leaf", type: "geo" }]);
    expect(scopeFor(["shape:leaf"], editor)).toBe("auto");
  });

  test("multi selection → 'auto'", async () => {
    const { scopeFor } = await import("./tidy-layout");
    const editor = makeFakeEditor([
      { id: "shape:cont", type: "schema-container" },
      { id: "shape:leaf", type: "geo" },
    ]);
    expect(scopeFor(["shape:cont", "shape:leaf"], editor)).toBe("auto");
  });

  test("empty selection → 'auto'", async () => {
    const { scopeFor } = await import("./tidy-layout");
    const editor = makeFakeEditor([]);
    expect(scopeFor([], editor)).toBe("auto");
  });

  test("unknown id (getShape returns undefined) → 'auto'", async () => {
    const { scopeFor } = await import("./tidy-layout");
    const editor = makeFakeEditor([]);
    expect(scopeFor(["shape:missing"], editor)).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// tidyLayout — scope passthrough to backend
// ---------------------------------------------------------------------------
describe("tidyLayout scope passthrough", () => {
  test("forwards scope='self' to backend POST body", async () => {
    let capturedBody: unknown;
    mockFetch((_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, count: 1, affected: ["shape:cont"] } };
    });
    const { tidyLayout } = await import("./tidy-layout");
    await tidyLayout(["shape:cont"], "space", "room", "self");
    expect((capturedBody as { ids: string[]; scope: string }).scope).toBe("self");
  });

  test("defaults scope='auto' when omitted (back-compat)", async () => {
    let capturedBody: unknown;
    mockFetch((_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, count: 0, affected: [] } };
    });
    const { tidyLayout } = await import("./tidy-layout");
    await tidyLayout(["shape:a"], "space", "room");
    expect((capturedBody as { scope: string }).scope).toBe("auto");
  });
});
