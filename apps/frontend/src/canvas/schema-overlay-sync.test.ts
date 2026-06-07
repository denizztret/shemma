/**
 * DRW-134 Task 2.7: Tests for schema-overlay-sync listener.
 *
 * Tests are pure unit tests — no real tldraw Editor is used.
 * A minimal mock object is constructed to simulate `editor.store.listen`.
 *
 * Covers:
 *   - Position change → postOverlay called with {position} (БЕЗ styleOwnedBy, DRW-214)
 *   - Color change vs preset → postOverlay called with {color, styleOwnedBy:"user"}
 *   - Label (richText) change → postOverlay called with {label, styleOwnedBy:"user"}
 *   - Shape without didrawSchemaParent → no call
 *   - Source "remote" (programmatic) change → no call (filter enforced)
 *   - Multiple rapid drags → debounced to 1 call per (frameId, nodeId)
 *   - Disposer stops listener and cancels pending timers
 *   - Helper: extractSchemaChildMeta
 *   - Helper: computeOverlayDelta
 *   - Helper: extractPlaintextFromRichText
 */

import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import type { Editor, TLRecord, TLShape } from "tldraw";
import {
  extractSchemaChildMeta,
  computeOverlayDelta,
  extractPlaintextFromRichText,
  installSchemaOverlaySync,
} from "./schema-overlay-sync";

// ---------------------------------------------------------------------------
// Helpers to build mock shapes
// ---------------------------------------------------------------------------

function makeShape(overrides: Record<string, unknown> = {}): TLShape {
  return {
    id: "shape:test",
    typeName: "shape",
    type: "geo",
    parentId: "page:page",
    index: "a1",
    x: 100,
    y: 200,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { color: "blue", richText: undefined },
    ...overrides,
  } as unknown as TLShape;
}

function makeSchemaChild(overrides: Record<string, unknown> = {}): TLShape {
  return makeShape({
    meta: {
      didrawId: "api-abc123",
      didrawLabel: "API",
      didrawSchemaParent: "shape:frame1",
      role: "service",
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Mock Editor factory
// ---------------------------------------------------------------------------

type ListenerFn = (entry: {
  changes: {
    updated: Record<string, [TLRecord, TLRecord]>;
    added: Record<string, TLRecord>;
    removed: Record<string, TLRecord>;
  };
  source?: string;
}) => void;

type ListenerFilters = { source?: string; scope?: string };

function makeMockEditor() {
  let registeredListener: ListenerFn | null = null;
  let registeredFilters: ListenerFilters | null = null;

  const store = {
    listen: mock(
      (cb: ListenerFn, filters?: ListenerFilters): (() => void) => {
        registeredListener = cb;
        registeredFilters = filters ?? null;
        return () => {
          registeredListener = null;
        };
      },
    ),
  };

  function fireUpdate(prev: TLShape, next: TLShape, source: string = "user") {
    if (!registeredListener) return;
    // Only fire if listener source filter matches.
    if (registeredFilters?.source && registeredFilters.source !== source) return;
    registeredListener({
      changes: {
        updated: { [next.id]: [prev as unknown as TLRecord, next as unknown as TLRecord] },
        added: {},
        removed: {},
      },
      source,
    });
  }

  return {
    store,
    fireUpdate,
    getRegisteredFilters: () => registeredFilters,
  };
}

// ---------------------------------------------------------------------------
// Helper: extractSchemaChildMeta
// ---------------------------------------------------------------------------

describe("extractSchemaChildMeta", () => {
  it("returns undefined for shape without meta", () => {
    const shape = makeShape({ meta: undefined });
    expect(extractSchemaChildMeta(shape)).toBeUndefined();
  });

  it("returns undefined for shape without didrawSchemaParent", () => {
    const shape = makeShape({ meta: { didrawId: "api-abc123" } });
    expect(extractSchemaChildMeta(shape)).toBeUndefined();
  });

  it("returns undefined for shape with empty didrawSchemaParent", () => {
    const shape = makeShape({ meta: { didrawId: "api-abc123", didrawSchemaParent: "" } });
    expect(extractSchemaChildMeta(shape)).toBeUndefined();
  });

  it("returns undefined for shape without didrawId", () => {
    const shape = makeShape({ meta: { didrawSchemaParent: "shape:frame1" } });
    expect(extractSchemaChildMeta(shape)).toBeUndefined();
  });

  it("returns meta for valid schema-child shape", () => {
    const shape = makeSchemaChild();
    const meta = extractSchemaChildMeta(shape);
    expect(meta).not.toBeUndefined();
    expect(meta?.didrawId).toBe("api-abc123");
    expect(meta?.didrawLabel).toBe("API");
    expect(meta?.didrawSchemaParent).toBe("shape:frame1");
    expect(meta?.role).toBe("service");
  });
});

// ---------------------------------------------------------------------------
// Helper: extractPlaintextFromRichText
// ---------------------------------------------------------------------------

describe("extractPlaintextFromRichText", () => {
  it("returns null for non-object input", () => {
    expect(extractPlaintextFromRichText(null)).toBeNull();
    expect(extractPlaintextFromRichText(42)).toBeNull();
    expect(extractPlaintextFromRichText(undefined)).toBeNull();
  });

  it("returns text from a text node", () => {
    expect(extractPlaintextFromRichText({ type: "text", text: "hello" })).toBe("hello");
  });

  it("returns concatenated text from nested PM doc", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: " world" },
          ],
        },
      ],
    };
    expect(extractPlaintextFromRichText(doc)).toBe("Hello world");
  });

  it("returns empty string for doc with no text nodes", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [] }] };
    expect(extractPlaintextFromRichText(doc)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Helper: computeOverlayDelta
// ---------------------------------------------------------------------------

describe("computeOverlayDelta", () => {
  const childMeta = {
    didrawId: "api-abc123",
    didrawLabel: "API",
    didrawSchemaParent: "shape:frame1",
    role: "service",
  };

  it("returns null when nothing changed", () => {
    const shape = makeSchemaChild();
    expect(computeOverlayDelta(shape, shape, childMeta)).toBeNull();
  });

  it("returns position delta on x/y change WITHOUT styleOwnedBy (DRW-214)", () => {
    // «Двигал» ≠ «красил»: position-only drag не взводит флаг владения стилем,
    // иначе style propagation перестаёт применять board-дефолты к любому
    // когда-либо двинутому узлу.
    const prev = makeSchemaChild({ x: 100, y: 200 });
    const next = makeSchemaChild({ x: 150, y: 250 });
    const delta = computeOverlayDelta(prev, next, childMeta);
    expect(delta).not.toBeNull();
    expect(delta?.position).toEqual({ x: 150, y: 250 });
    expect(delta?.styleOwnedBy).toBeUndefined();
  });

  it("position + color change stamps styleOwnedBy (DRW-214)", () => {
    const prev = makeSchemaChild({ x: 100, y: 200, props: { color: "blue" } });
    const next = makeSchemaChild({ x: 150, y: 250, props: { color: "red" } });
    const delta = computeOverlayDelta(prev, next, childMeta);
    expect(delta?.position).toEqual({ x: 150, y: 250 });
    expect(delta?.color).toBe("red");
    expect(delta?.styleOwnedBy).toBe("user");
  });

  it("returns color delta when color differs from role-preset default", () => {
    // "service" preset color is "blue" — change to "red" triggers overlay.
    const prev = makeSchemaChild({ props: { color: "blue" } });
    const next = makeSchemaChild({ props: { color: "red" } });
    const delta = computeOverlayDelta(prev, next, childMeta);
    expect(delta?.color).toBe("red");
    expect(delta?.styleOwnedBy).toBe("user");
  });

  it("returns null when color matches preset default (no effective change)", () => {
    // preset default for "service" is "blue".
    const prev = makeSchemaChild({ props: { color: "red" } });
    const next = makeSchemaChild({ props: { color: "blue" } }); // reset to preset
    const delta = computeOverlayDelta(prev, next, childMeta);
    // color changed from prev BUT matches preset → no color field in delta.
    // position and label also unchanged → null.
    expect(delta).toBeNull();
  });

  it("returns label delta when richText changes and text differs from didrawLabel", () => {
    const rt1 = { type: "doc", content: [{ type: "text", text: "API" }] };
    const rt2 = { type: "doc", content: [{ type: "text", text: "Auth Service" }] };
    const prev = makeSchemaChild({ props: { richText: rt1 } });
    const next = makeSchemaChild({ props: { richText: rt2 } });
    const delta = computeOverlayDelta(prev, next, childMeta);
    expect(delta?.label).toBe("Auth Service");
    expect(delta?.styleOwnedBy).toBe("user");
  });

  it("returns null when richText changes but rendered text matches didrawLabel", () => {
    const rt1 = { type: "doc", content: [{ type: "text", text: "API" }] };
    const rt2 = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "API" }] }] };
    const prev = makeSchemaChild({ props: { richText: rt1 } });
    const next = makeSchemaChild({ props: { richText: rt2 } });
    const delta = computeOverlayDelta(prev, next, childMeta);
    // Text is same as didrawLabel "API" → no label overlay.
    // Position unchanged → null.
    expect(delta).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: installSchemaOverlaySync
// ---------------------------------------------------------------------------

describe("installSchemaOverlaySync", () => {
  beforeEach(() => {
    // No global setup needed — each test creates fresh mock.
  });

  afterEach(() => {
    // Cleanup is done via disposer in each test.
  });

  it("registers store.listen with source:'user' and scope:'document'", () => {
    const mockEditor = makeMockEditor();
    const dispose = installSchemaOverlaySync(mockEditor as unknown as Editor, {
      postOverlay: async () => {},
    });
    const filters = mockEditor.getRegisteredFilters();
    expect(filters?.source).toBe("user");
    expect(filters?.scope).toBe("document");
    dispose();
  });

  it("calls postOverlay after debounce for position change on schema-child", async () => {
    const calls: Array<{ frameId: string; nodeId: string; overlay: unknown }> = [];
    const mockEditor = makeMockEditor();

    const dispose = installSchemaOverlaySync(mockEditor as unknown as Editor, {
      postOverlay: async (frameId, nodeId, overlay) => {
        calls.push({ frameId, nodeId, overlay });
      },
      debounceMs: 10,
    });

    const prev = makeSchemaChild({ x: 100, y: 200 });
    const next = makeSchemaChild({ x: 150, y: 250 });

    mockEditor.fireUpdate(prev, next, "user");

    // Before debounce — not called yet.
    expect(calls.length).toBe(0);

    // Wait for debounce to flush.
    await new Promise((r) => setTimeout(r, 30));

    expect(calls.length).toBe(1);
    expect(calls[0]!.frameId).toBe("shape:frame1");
    expect(calls[0]!.nodeId).toBe("api-abc123");
    expect((calls[0]!.overlay as { position?: unknown }).position).toEqual({ x: 150, y: 250 });
    // DRW-214: position-only — без флага владения стилем.
    expect(
      (calls[0]!.overlay as { styleOwnedBy?: string }).styleOwnedBy,
    ).toBeUndefined();

    dispose();
  });

  it("does not call postOverlay for shape without didrawSchemaParent", async () => {
    const calls: unknown[] = [];
    const mockEditor = makeMockEditor();

    const dispose = installSchemaOverlaySync(mockEditor as unknown as Editor, {
      postOverlay: async (...args) => { calls.push(args); },
      debounceMs: 10,
    });

    const prev = makeShape({ x: 100, y: 200 }); // no meta.didrawSchemaParent
    const next = makeShape({ x: 150, y: 250 });

    mockEditor.fireUpdate(prev, next, "user");
    await new Promise((r) => setTimeout(r, 30));

    expect(calls.length).toBe(0);
    dispose();
  });

  it("does not call postOverlay for remote (AI-generated) changes", async () => {
    const calls: unknown[] = [];
    const mockEditor = makeMockEditor();

    const dispose = installSchemaOverlaySync(mockEditor as unknown as Editor, {
      postOverlay: async (...args) => { calls.push(args); },
      debounceMs: 10,
    });

    const prev = makeSchemaChild({ x: 100, y: 200 });
    const next = makeSchemaChild({ x: 150, y: 250 });

    // Fire with source "remote" — listener should be filtered out by tldraw store filters.
    // In our mock, fireUpdate respects the registered filters.source.
    mockEditor.fireUpdate(prev, next, "remote");
    await new Promise((r) => setTimeout(r, 30));

    expect(calls.length).toBe(0);
    dispose();
  });

  it("coalesces multiple rapid drags to a single postOverlay call", async () => {
    const calls: Array<{ frameId: string; nodeId: string; overlay: unknown }> = [];
    const mockEditor = makeMockEditor();

    const dispose = installSchemaOverlaySync(mockEditor as unknown as Editor, {
      postOverlay: async (frameId, nodeId, overlay) => {
        calls.push({ frameId, nodeId, overlay });
      },
      debounceMs: 50,
    });

    const base = makeSchemaChild({ x: 100, y: 200 });
    const pos1 = makeSchemaChild({ x: 120, y: 220 });
    const pos2 = makeSchemaChild({ x: 140, y: 240 });
    const pos3 = makeSchemaChild({ x: 160, y: 260 });

    // Three rapid drags.
    mockEditor.fireUpdate(base, pos1, "user");
    await new Promise((r) => setTimeout(r, 10));
    mockEditor.fireUpdate(pos1, pos2, "user");
    await new Promise((r) => setTimeout(r, 10));
    mockEditor.fireUpdate(pos2, pos3, "user");

    // Wait for debounce to flush.
    await new Promise((r) => setTimeout(r, 100));

    // Should be exactly 1 call (coalesced), with the last position.
    expect(calls.length).toBe(1);
    expect((calls[0]!.overlay as { position?: unknown }).position).toEqual({ x: 160, y: 260 });

    dispose();
  });

  it("disposer stops listener — subsequent changes do not fire postOverlay", async () => {
    const calls: unknown[] = [];
    const mockEditor = makeMockEditor();

    const dispose = installSchemaOverlaySync(mockEditor as unknown as Editor, {
      postOverlay: async (...args) => { calls.push(args); },
      debounceMs: 10,
    });

    dispose(); // Dispose before any changes.

    const prev = makeSchemaChild({ x: 100, y: 200 });
    const next = makeSchemaChild({ x: 150, y: 250 });

    // Listener is unregistered — fireUpdate won't reach it.
    mockEditor.fireUpdate(prev, next, "user");
    await new Promise((r) => setTimeout(r, 30));

    expect(calls.length).toBe(0);
  });

  it("disposer cancels pending timers — no late calls after dispose", async () => {
    const calls: unknown[] = [];
    const mockEditor = makeMockEditor();

    const dispose = installSchemaOverlaySync(mockEditor as unknown as Editor, {
      postOverlay: async (...args) => { calls.push(args); },
      debounceMs: 100, // Long debounce so we can dispose before it fires.
    });

    const prev = makeSchemaChild({ x: 100, y: 200 });
    const next = makeSchemaChild({ x: 150, y: 250 });

    mockEditor.fireUpdate(prev, next, "user");

    // Dispose immediately — before debounce fires.
    dispose();

    // Wait longer than debounce.
    await new Promise((r) => setTimeout(r, 200));

    // Timer was cancelled — no calls.
    expect(calls.length).toBe(0);
  });
});
