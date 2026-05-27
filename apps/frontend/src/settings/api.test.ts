import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getLayoutParams, postLayoutParams, postLayoutSelection } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getLayoutParams", () => {
  test("calls GET /api/board/layout-params with space + room query", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ raw: null, effective: { nodePadding: 16 } }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getLayoutParams("default", "drw-test");
    expect(fetchMock).toHaveBeenCalled();
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/board/layout-params");
    expect(url).toContain("space=default");
    expect(url).toContain("room=drw-test");
    expect(result.raw).toBeNull();
    expect(result.effective.nodePadding).toBe(16);
  });

  test("throws on non-2xx response", async () => {
    globalThis.fetch = mock(async () => new Response("server down", { status: 500 })) as unknown as typeof fetch;
    await expect(getLayoutParams("s", "r")).rejects.toThrow();
  });
});

describe("postLayoutParams", () => {
  test("posts JSON body with params + space + room", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ ok: true, effective: { nodePadding: 8 } }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await postLayoutParams("default", "drw-test", { nodePadding: 8 });
    const call = fetchMock.mock.calls[0];
    const url = call?.[0] as string;
    expect(url).toContain("/api/board/layout-params");
    expect(url).toContain("space=default");
    expect(url).toContain("room=drw-test");
    expect(call?.[1]?.method).toBe("POST");
    expect(JSON.parse((call?.[1]?.body as string) ?? "{}")).toEqual({
      params: { nodePadding: 8 },
    });
    expect(result.effective.nodePadding).toBe(8);
  });
});

describe("postLayoutSelection", () => {
  test("forwards forceUnpin flag in body", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await postLayoutSelection("default", "drw-test", { ids: ["s:a"], forceUnpin: true });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1]?.body as string) ?? "{}");
    expect(body.forceUnpin).toBe(true);
    expect(body.ids).toEqual(["s:a"]);
  });
});
