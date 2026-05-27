/**
 * Tests for setContainerDirection — polymorphic writer (Task #6,
 * frame-container-direction-layout plan).
 *
 * Coverage:
 *   1. schema-container input → editor.updateShape called с props.direction.
 *   2. frame input → editor.updateShape called с meta.didrawDirection.
 *   3. POST body содержит directions map + scope:"self" + ids.
 *   4. Non-container ids (e.g. geo leaf) → no updateShape call + skipped in POST.
 *
 * Pure-function approach: mock minimal Editor shape (getShape + updateShape + run);
 * mock globalThis.fetch чтобы перехватить POST body. Никакого React/RTL.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Editor } from "tldraw";
import { setContainerDirection } from "./SchemaContainerActions";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

type Shape = {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

function makeEditor(shapes: Record<string, Shape>): {
  editor: Editor;
  updateCalls: Array<{ id: string; type: string; props?: unknown; meta?: unknown }>;
} {
  const updateCalls: Array<{
    id: string;
    type: string;
    props?: unknown;
    meta?: unknown;
  }> = [];

  const editor = {
    getShape: (id: string) => shapes[id],
    updateShape: (partial: {
      id: string;
      type: string;
      props?: unknown;
      meta?: unknown;
    }) => {
      updateCalls.push(partial);
    },
    run: (fn: () => void) => fn(),
  } as unknown as Editor;

  return { editor, updateCalls };
}

beforeEach(() => {
  // Provide window so triggerLayoutSelection takes the SSR-OK path.
  // We point at the dev URL with explicit space/room so the request URL is deterministic.
  (globalThis as unknown as { window: unknown }).window = {
    location: { href: "http://localhost:5173/?space=default&room=drw-test" },
  } as unknown as Window;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) {
    delete (globalThis as unknown as { window?: unknown }).window;
  } else {
    (globalThis as unknown as { window: unknown }).window = originalWindow;
  }
});

describe("setContainerDirection — polymorphic writer", () => {
  test("schema-container: writes props.direction", () => {
    const { editor, updateCalls } = makeEditor({
      "shape:c1": {
        id: "shape:c1",
        type: "schema-container",
        props: { direction: "TB" },
      },
    });
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;

    setContainerDirection(editor, ["shape:c1"], "LR");

    expect(updateCalls).toHaveLength(1);
    const call = updateCalls[0];
    expect(call?.id).toBe("shape:c1");
    expect(call?.type).toBe("schema-container");
    expect((call?.props as { direction?: string })?.direction).toBe("LR");
    // meta path не используется для schema-container
    expect(call?.meta).toBeUndefined();
  });

  test("frame: writes meta.didrawDirection", () => {
    const { editor, updateCalls } = makeEditor({
      "shape:f1": {
        id: "shape:f1",
        type: "frame",
        props: { w: 400, h: 300, name: "F" },
        meta: {},
      },
    });
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;

    setContainerDirection(editor, ["shape:f1"], "BT");

    expect(updateCalls).toHaveLength(1);
    const call = updateCalls[0];
    expect(call?.id).toBe("shape:f1");
    expect(call?.type).toBe("frame");
    expect((call?.meta as { didrawDirection?: string })?.didrawDirection).toBe("BT");
    // props path не используется для frame
    expect(call?.props).toBeUndefined();
  });

  test("POST body contains directions map + scope:'self' + ids", async () => {
    const { editor } = makeEditor({
      "shape:c1": {
        id: "shape:c1",
        type: "schema-container",
        props: { direction: "TB" },
      },
      "shape:f1": {
        id: "shape:f1",
        type: "frame",
        props: { w: 400, h: 300, name: "F" },
        meta: {},
      },
    });

    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    setContainerDirection(editor, ["shape:c1", "shape:f1"], "RL");

    // triggerLayoutSelection — fire-and-forget; даём microtask проиграться.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalled();
    const call = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    const url = call?.[0] as string;
    expect(url).toContain("/api/agent/layout-selection");
    expect(url).toContain("space=default");
    expect(url).toContain("room=drw-test");

    const body = JSON.parse((call?.[1]?.body as string) ?? "{}");
    expect(body.scope).toBe("self");
    expect(body.ids).toEqual(["shape:c1", "shape:f1"]);
    expect(body.directions).toEqual({
      "shape:c1": "RL",
      "shape:f1": "RL",
    });
  });

  test("non-container ids ignored — no updateShape call, no entry in POST", async () => {
    const { editor, updateCalls } = makeEditor({
      "shape:leaf": {
        id: "shape:leaf",
        type: "geo",
        props: { geo: "rectangle", w: 80, h: 40 },
      },
      "shape:c1": {
        id: "shape:c1",
        type: "schema-container",
        props: { direction: "TB" },
      },
    });

    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    setContainerDirection(editor, ["shape:leaf", "shape:c1"], "LR");

    // Только schema-container получил updateShape.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.id).toBe("shape:c1");

    await Promise.resolve();
    await Promise.resolve();

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse((calls[0]?.[1]?.body as string) ?? "{}");
    // Leaf отфильтрован из directions + ids.
    expect(body.directions).toEqual({ "shape:c1": "LR" });
    expect(body.ids).toEqual(["shape:c1"]);
  });

  test("empty ids → no fetch, no updateShape", async () => {
    const { editor, updateCalls } = makeEditor({});
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    setContainerDirection(editor, [], "TB");

    expect(updateCalls).toHaveLength(0);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
