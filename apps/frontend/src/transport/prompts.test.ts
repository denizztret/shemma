// DRW-116 Task 15: prompt HTTP wrappers carry composite (space, room) query.

import { afterEach, describe, expect, test } from "bun:test";
import {
  deletePrompt,
  fetchPrompts,
  postPrompt,
  purgePrompts,
} from "./prompts";

const originalFetch = globalThis.fetch;

type Captured = { url: string; init?: RequestInit };

function captureFetch(responseBody: unknown = { ok: true }): {
  calls: Captured[];
} {
  const calls: Captured[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("prompts: composite (space, room) query string", () => {
  test("postPrompt carries both params", async () => {
    const { calls } = captureFetch();
    await postPrompt("ws-7", "alpha", ["s1"], "draw a box");
    expect(calls[0]!.url).toContain("/api/prompt?");
    expect(calls[0]!.url).toContain("space=ws-7");
    expect(calls[0]!.url).toContain("room=alpha");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      selection: ["s1"],
      text: "draw a box",
    });
  });

  test("fetchPrompts carries both params + status", async () => {
    const { calls } = captureFetch({ prompts: [] });
    await fetchPrompts("ws-7", "alpha", "pending");
    expect(calls[0]!.url).toContain("/api/prompts?");
    expect(calls[0]!.url).toContain("space=ws-7");
    expect(calls[0]!.url).toContain("room=alpha");
    expect(calls[0]!.url).toContain("status=pending");
  });

  test("deletePrompt carries both params", async () => {
    const { calls } = captureFetch();
    await deletePrompt("ws-7", "alpha", "prompt-1");
    expect(calls[0]!.url).toContain("/api/prompt/prompt-1?");
    expect(calls[0]!.url).toContain("space=ws-7");
    expect(calls[0]!.url).toContain("room=alpha");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  test("purgePrompts carries both params", async () => {
    const { calls } = captureFetch();
    await purgePrompts("ws-7", "alpha");
    expect(calls[0]!.url).toContain("/api/prompts?");
    expect(calls[0]!.url).toContain("space=ws-7");
    expect(calls[0]!.url).toContain("room=alpha");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });
});
