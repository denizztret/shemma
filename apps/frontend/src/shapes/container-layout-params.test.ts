/**
 * Tests for setContainerLayoutParams — per-container layout params override
 * writer (Task #7, frame-container-direction-layout plan).
 *
 * Coverage:
 *   1. partial Partial<LayoutParams> для frame → editor.updateShape с
 *      meta.didrawLayoutParams + POST body с layoutParamsOverride map + scope:"self".
 *   2. partial === null → editor.updateShape с meta.didrawLayoutParams = undefined
 *      (tldraw deletes meta key locally); POST body передаёт null в map
 *      (backend Task #4 удаляет server-side). Convergent semantics.
 *   3. Non-container ids (leaf) → silently skipped: updateShape not called,
 *      leaf id отсутствует в POST `layoutParamsOverride` + `ids`.
 *
 * Pure-function approach: mock minimal Editor shape (getShape + updateShape + run);
 * mock globalThis.fetch чтобы перехватить POST. Никакого React/RTL.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Editor } from "tldraw";
import { setContainerLayoutParams } from "./container-layout-params";

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
  // Provide window so writer takes the SSR-OK path.
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

describe("setContainerLayoutParams — per-container override writer", () => {
  test("partial Partial<LayoutParams> for frame: writes meta + POST override", async () => {
    const { editor, updateCalls } = makeEditor({
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

    await setContainerLayoutParams(editor, ["shape:f1"], { spacing: "compact" });

    expect(updateCalls).toHaveLength(1);
    const call = updateCalls[0];
    expect(call?.id).toBe("shape:f1");
    expect(call?.type).toBe("frame");
    expect((call?.meta as { didrawLayoutParams?: unknown })?.didrawLayoutParams).toEqual({
      spacing: "compact",
    });

    expect(fetchMock).toHaveBeenCalled();
    const fetchCall = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    const url = fetchCall?.[0] as string;
    expect(url).toContain("/api/agent/layout-selection");
    expect(url).toContain("space=default");
    expect(url).toContain("room=drw-test");

    const body = JSON.parse((fetchCall?.[1]?.body as string) ?? "{}");
    expect(body.scope).toBe("self");
    expect(body.ids).toEqual(["shape:f1"]);
    expect(body.layoutParamsOverride).toEqual({
      "shape:f1": { spacing: "compact" },
    });
  });

  test("partial === null: writes meta=undefined + POST sends null in map", async () => {
    const { editor, updateCalls } = makeEditor({
      "shape:f1": {
        id: "shape:f1",
        type: "frame",
        props: { w: 400, h: 300, name: "F" },
        meta: { didrawLayoutParams: { spacing: "loose" } },
      },
    });

    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await setContainerLayoutParams(editor, ["shape:f1"], null);

    expect(updateCalls).toHaveLength(1);
    const call = updateCalls[0];
    expect(call?.id).toBe("shape:f1");
    expect(call?.type).toBe("frame");
    // tldraw convention: undefined deletes meta key locally.
    expect((call?.meta as { didrawLayoutParams?: unknown })?.didrawLayoutParams).toBeUndefined();

    expect(fetchMock).toHaveBeenCalled();
    const fetchCall = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    const body = JSON.parse((fetchCall?.[1]?.body as string) ?? "{}");
    expect(body.scope).toBe("self");
    expect(body.ids).toEqual(["shape:f1"]);
    // JSON wire: null reaches backend, which deletes server-side (Task #4).
    expect(body.layoutParamsOverride).toEqual({ "shape:f1": null });
    // Sanity-check the key is present с явным null, not omitted.
    expect(Object.hasOwn(body.layoutParamsOverride, "shape:f1")).toBe(true);
  });

  test("non-container leaf id silently skipped — no updateShape, no entry in POST", async () => {
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
        meta: {},
      },
    });

    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await setContainerLayoutParams(
      editor,
      ["shape:leaf", "shape:c1"],
      { spacing: "normal" },
    );

    // Только schema-container получил updateShape.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.id).toBe("shape:c1");
    expect(
      (updateCalls[0]?.meta as { didrawLayoutParams?: unknown })?.didrawLayoutParams,
    ).toEqual({ spacing: "normal" });

    expect(fetchMock).toHaveBeenCalled();
    const fetchCall = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    const body = JSON.parse((fetchCall?.[1]?.body as string) ?? "{}");
    // Leaf отфильтрован из layoutParamsOverride + ids.
    expect(body.layoutParamsOverride).toEqual({
      "shape:c1": { spacing: "normal" },
    });
    expect(body.ids).toEqual(["shape:c1"]);
  });
});
