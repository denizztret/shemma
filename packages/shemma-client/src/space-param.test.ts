import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CanvasClient } from "./index";

/**
 * DRW-116 Task 24: CanvasClient threads `space` query param through every
 * HTTP call. Tests verify:
 *   1. Constructor default (`space: "test-space"`) is included in URL.
 *   2. No-space constructor falls back to "__legacy__" sentinel.
 *   3. Per-method `space` override (getContext) wins over constructor default.
 */

let capturedUrls: string[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  capturedUrls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => {
    capturedUrls.push(typeof url === "string" ? url : url.toString());
    return Promise.resolve(
      new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("CanvasClient space param — constructor default", () => {
  it("getState includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s1", room: "r1" });
    await c.getState();
    expect(capturedUrls[0]).toContain("space=s1");
    expect(capturedUrls[0]).toContain("room=r1");
  });

  it("applyPatch includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s2", room: "r2" });
    await c.applyPatch([]);
    expect(capturedUrls[0]).toContain("space=s2");
  });

  it("layout includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s3", room: "r3" });
    await c.layout("dagre");
    expect(capturedUrls[0]).toContain("space=s3");
  });

  it("getPrompts includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s4", room: "r4" });
    await c.getPrompts();
    expect(capturedUrls[0]).toContain("space=s4");
  });

  it("resolvePrompt includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s5", room: "r5" });
    await c.resolvePrompt("pid-1");
    expect(capturedUrls[0]).toContain("space=s5");
  });

  it("dismissPrompt includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s6", room: "r6" });
    await c.dismissPrompt("pid-2");
    expect(capturedUrls[0]).toContain("space=s6");
  });

  it("deletePrompt includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s7", room: "r7" });
    await c.deletePrompt("pid-3");
    expect(capturedUrls[0]).toContain("space=s7");
  });

  it("purgePrompts includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s8", room: "r8" });
    await c.purgePrompts();
    expect(capturedUrls[0]).toContain("space=s8");
  });

  it("applyDomain includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s9", room: "r9" });
    await c.applyDomain({ actions: [] });
    expect(capturedUrls[0]).toContain("space=s9");
  });

  it("getContext includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s10", room: "r10" });
    await c.getContext();
    expect(capturedUrls[0]).toContain("space=s10");
    expect(capturedUrls[0]).toContain("room=r10");
  });

  it("importMermaid includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s11", room: "r11" });
    await c.importMermaid({ source: "graph LR; A-->B" });
    expect(capturedUrls[0]).toContain("space=s11");
  });

  it("layoutSelection includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s12", room: "r12" });
    await c.layoutSelection({ ids: ["id1"] });
    expect(capturedUrls[0]).toContain("space=s12");
  });

  it("postViewport includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s13", room: "r13" });
    await c.postViewport({ x: 0, y: 0, w: 100, h: 100 });
    expect(capturedUrls[0]).toContain("space=s13");
  });

  it("aiStart includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s14", room: "r14" });
    await c.aiStart("actor", "task");
    expect(capturedUrls[0]).toContain("space=s14");
  });

  it("aiStop includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s15", room: "r15" });
    await c.aiStop();
    expect(capturedUrls[0]).toContain("space=s15");
  });

  it("aiActivity includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s16", room: "r16" });
    await c.aiActivity();
    expect(capturedUrls[0]).toContain("space=s16");
  });
});

describe("CanvasClient space param — legacy fallback", () => {
  it("uses __legacy__ when no space provided in constructor", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", room: "r-leg" });
    await c.getState();
    expect(capturedUrls[0]).toContain("space=__legacy__");
  });

  it("exposes space as readonly property", () => {
    const c = new CanvasClient({ baseUrl: "http://x" });
    expect(c.space).toBe("__legacy__");
  });

  it("exposes provided space as readonly property", () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "my-space" });
    expect(c.space).toBe("my-space");
  });
});

describe("CanvasClient space param — per-method override (getContext)", () => {
  it("opts.space overrides constructor default in getContext", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "default-space", room: "r-ov" });
    await c.getContext({ space: "override-space" });
    expect(capturedUrls[0]).toContain("space=override-space");
    expect(capturedUrls[0]).not.toContain("space=default-space");
  });
});

describe("CanvasClient space param — room-management endpoints", () => {
  it("listRooms includes space in URL (no room)", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "rm-1" });
    await c.listRooms();
    expect(capturedUrls[0]).toContain("space=rm-1");
    expect(capturedUrls[0]).not.toContain("room=");
  });

  it("archiveRoom includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "rm-2" });
    await c.archiveRoom("foo");
    expect(capturedUrls[0]).toContain("space=rm-2");
    expect(capturedUrls[0]).toContain("/api/rooms/foo/archive");
  });

  it("restoreRoom includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "rm-3" });
    await c.restoreRoom("bar");
    expect(capturedUrls[0]).toContain("space=rm-3");
    expect(capturedUrls[0]).toContain("/api/rooms/bar/restore");
  });

  it("exportRoom includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "rm-4" });
    await c.exportRoom("baz", "/tmp/baz.json");
    expect(capturedUrls[0]).toContain("space=rm-4");
    expect(capturedUrls[0]).toContain("/api/rooms/baz/export");
  });

  it("importRoom includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "rm-5" });
    await c.importRoom("/tmp/in.json");
    expect(capturedUrls[0]).toContain("space=rm-5");
    expect(capturedUrls[0]).toContain("/api/rooms/import");
  });

  it("deleteRoom includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "rm-6" });
    await c.deleteRoom("zzz", true);
    expect(capturedUrls[0]).toContain("space=rm-6");
    expect(capturedUrls[0]).toContain("/api/rooms/zzz");
  });

  it("renameRoom includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "rm-7" });
    await c.renameRoom("old", "new");
    expect(capturedUrls[0]).toContain("space=rm-7");
    expect(capturedUrls[0]).toContain("/api/rooms/old/rename");
  });

  it("duplicateRoom includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "rm-8" });
    await c.duplicateRoom("src", "dst");
    expect(capturedUrls[0]).toContain("space=rm-8");
    expect(capturedUrls[0]).toContain("/api/rooms/src/duplicate");
  });

  it("duplicateAuto includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "rm-9" });
    await c.duplicateAuto("src");
    expect(capturedUrls[0]).toContain("space=rm-9");
    expect(capturedUrls[0]).toContain("/api/rooms/src/duplicate-auto");
  });

  it("purgeArchive includes space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "rm-10" });
    await c.purgeArchive();
    expect(capturedUrls[0]).toContain("space=rm-10");
    expect(capturedUrls[0]).toContain("/api/rooms/purge-archive");
  });

  it("getActiveRooms aggregates by default (no space)", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "rm-agg" });
    await c.getActiveRooms();
    expect(capturedUrls[0]).toContain("/api/active-rooms");
    // Default behavior: aggregate across spaces → no `space=` param.
    expect(capturedUrls[0]).not.toContain("space=");
  });

  it("getActiveRooms filters when opts.space provided", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "rm-default" });
    await c.getActiveRooms({ space: "filter-me" });
    expect(capturedUrls[0]).toContain("/api/active-rooms");
    expect(capturedUrls[0]).toContain("space=filter-me");
  });
});

describe("CanvasClient space param — non-room methods unaffected", () => {
  it("health does NOT include space in URL", async () => {
    // health() calls /healthz — simple probe, no space
    globalThis.fetch = ((url: string | URL | Request) => {
      capturedUrls.push(typeof url === "string" ? url : url.toString());
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch;
    const c = new CanvasClient({ baseUrl: "http://x", space: "s-health" });
    await c.health();
    expect(capturedUrls[0]).not.toContain("space=");
  });

  it("getVersion does NOT include space in URL", async () => {
    const c = new CanvasClient({ baseUrl: "http://x", space: "s-ver" });
    await c.getVersion();
    expect(capturedUrls[0]).not.toContain("space=");
  });
});
