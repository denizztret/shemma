// DRW-116 Task 16: coverage for spaces api.ts wrappers.
// Tests HTTP shape (URL, method, body) without mounting React components.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  _resetSessionCache,
  addSpaceApi,
  expandHomePath,
  forgetSpaceApi,
  getSession,
  listSpacesApi,
  renameSpaceLabelApi,
} from "../api";

const originalFetch = globalThis.fetch;

type Captured = { url: string; init?: RequestInit };

function makeFetch(
  body: unknown,
  status = 200,
): { calls: Captured[] } {
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
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

beforeEach(() => {
  _resetSessionCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetSessionCache();
});

// ---------------------------------------------------------------------------
// listSpacesApi
// ---------------------------------------------------------------------------

describe("listSpacesApi", () => {
  it("calls GET /api/spaces and returns spaces array", async () => {
    const { calls } = makeFetch({ spaces: [{ id: "a", label: "A" }] });
    const result = await listSpacesApi();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/spaces");
    expect(calls[0]!.init).toBeUndefined();
    expect(result).toEqual([{ id: "a", label: "A" }]);
  });

  it("throws when response is not ok", async () => {
    makeFetch({ error: "oops" }, 500);
    await expect(listSpacesApi()).rejects.toThrow("/api/spaces failed: 500");
  });
});

// ---------------------------------------------------------------------------
// addSpaceApi
// ---------------------------------------------------------------------------

describe("addSpaceApi", () => {
  it("posts path + label and returns space + created flag", async () => {
    const { calls } = makeFetch({
      space: { id: "a", label: "A", rootDir: "/a" },
      created: true,
    });
    const result = await addSpaceApi("/my/path", "MyLabel");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/spaces");
    expect(calls[0]!.init?.method).toBe("POST");
    expect((calls[0]!.init?.headers as Record<string, string>)?.["content-type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      path: "/my/path",
      label: "MyLabel",
    });
    expect(result.created).toBe(true);
    expect(result.space.id).toBe("a");
  });

  it("omits label when not provided", async () => {
    const { calls } = makeFetch({
      space: { id: "b", label: "b", rootDir: "/b" },
      created: false,
    });
    await addSpaceApi("/only/path");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.path).toBe("/only/path");
    // label key is present but undefined — serialized as absent
    expect(Object.prototype.hasOwnProperty.call(body, "label")).toBe(false);
  });

  it("throws on non-ok response using error message field", async () => {
    makeFetch({ error: "path_not_found" }, 400);
    await expect(addSpaceApi("/bad")).rejects.toThrow("path_not_found");
  });

  it("throws on non-ok response using message field when available", async () => {
    makeFetch({ error: "e", message: "detailed message" }, 422);
    await expect(addSpaceApi("/bad")).rejects.toThrow("detailed message");
  });

  it("throws fallback message when neither error nor message is present", async () => {
    makeFetch({}, 500);
    await expect(addSpaceApi("/bad")).rejects.toThrow("failed");
  });
});

// ---------------------------------------------------------------------------
// forgetSpaceApi
// ---------------------------------------------------------------------------

describe("forgetSpaceApi", () => {
  it("calls DELETE /api/spaces/<id>", async () => {
    const { calls } = makeFetch({});
    await forgetSpaceApi("test-id");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/spaces/test-id");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  it("URL-encodes special characters in id", async () => {
    const { calls } = makeFetch({});
    await forgetSpaceApi("id with spaces");
    expect(calls[0]!.url).toBe("/api/spaces/id%20with%20spaces");
  });

  it("throws on non-ok response", async () => {
    makeFetch({}, 404);
    await expect(forgetSpaceApi("missing")).rejects.toThrow(
      "forget missing failed: 404",
    );
  });
});

// ---------------------------------------------------------------------------
// renameSpaceLabelApi
// ---------------------------------------------------------------------------

describe("renameSpaceLabelApi", () => {
  it("calls PATCH /api/spaces/<id> with new label in body", async () => {
    const { calls } = makeFetch({});
    await renameSpaceLabelApi("test-id", "NewLabel");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/spaces/test-id");
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      label: "NewLabel",
    });
  });

  it("URL-encodes special characters in id", async () => {
    const { calls } = makeFetch({});
    await renameSpaceLabelApi("id/slash", "L");
    expect(calls[0]!.url).toBe("/api/spaces/id%2Fslash");
  });

  it("throws on non-ok response", async () => {
    makeFetch({}, 500);
    await expect(renameSpaceLabelApi("x", "y")).rejects.toThrow(
      "rename x failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// getSession + expandHomePath
// ---------------------------------------------------------------------------

describe("getSession", () => {
  it("fetches /api/session and returns parsed info", async () => {
    const { calls } = makeFetch({
      sessionId: "s1",
      projectSlug: "proj",
      workspaceDir: "/work",
      home: "/Users/me",
    });
    const info = await getSession();
    expect(calls[0]!.url).toBe("/api/session");
    expect(info.home).toBe("/Users/me");
    expect(info.sessionId).toBe("s1");
  });

  it("caches the result — only one fetch for two calls", async () => {
    const { calls } = makeFetch({
      sessionId: "s2",
      projectSlug: "p",
      workspaceDir: "/w",
      home: "/Users/cached",
    });
    await getSession();
    await getSession();
    expect(calls).toHaveLength(1);
  });

  it("_resetSessionCache clears the cache so the next call re-fetches", async () => {
    makeFetch({
      sessionId: "s3",
      projectSlug: "p",
      workspaceDir: "/w",
      home: "/Users/reset",
    });
    await getSession();
    _resetSessionCache();
    const { calls: calls2 } = makeFetch({
      sessionId: "s4",
      projectSlug: "p",
      workspaceDir: "/w",
      home: "/Users/reset2",
    });
    await getSession();
    expect(calls2).toHaveLength(1);
  });
});

describe("expandHomePath", () => {
  it("returns path unchanged when no leading ~", async () => {
    const { calls } = makeFetch({ home: "/Users/me" });
    const result = await expandHomePath("/already/absolute");
    expect(result).toBe("/already/absolute");
    // session should NOT be fetched for non-tilde paths
    expect(calls).toHaveLength(0);
  });

  it("expands ~/… to <home>/…", async () => {
    makeFetch({
      sessionId: "s",
      projectSlug: "p",
      workspaceDir: "/w",
      home: "/Users/me",
    });
    const result = await expandHomePath("~/Projects/foo");
    expect(result).toBe("/Users/me/Projects/foo");
  });

  it("expands bare ~ to home", async () => {
    makeFetch({
      sessionId: "s",
      projectSlug: "p",
      workspaceDir: "/w",
      home: "/Users/me",
    });
    const result = await expandHomePath("~");
    expect(result).toBe("/Users/me");
  });

  it("uses cached session for multiple expand calls", async () => {
    const { calls } = makeFetch({
      sessionId: "s",
      projectSlug: "p",
      workspaceDir: "/w",
      home: "/home/user",
    });
    await expandHomePath("~/a");
    await expandHomePath("~/b");
    // only one /api/session call despite two expands
    expect(calls).toHaveLength(1);
  });
});
