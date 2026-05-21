import { describe, expect, it } from "bun:test";
import { makeApp } from "../src/index";
import type { Sock } from "../src/ws";

// Helper: creates a mock WS socket that records sent messages and optionally
// calls back to simulate a frontend response.
function makeMockSock(opts: {
  onSend?: (data: string, sock: MockSock) => void;
} = {}): MockSock {
  const sock: MockSock = {
    readyState: 1, // OPEN
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
      opts.onSend?.(data, this);
    },
  };
  return sock;
}

type MockSock = Sock & { sent: string[] };

describe("POST /api/agent/import-mermaid", () => {
  it("returns 503 with error and room_url when no client connected to room", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(
      new Request("http://127.0.0.1:8787/api/agent/import-mermaid?room=empty-room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "graph LR; A-->B" }),
      }),
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string; room_url: string };
    expect(body.error).toBe("no client connected");
    // room_url should reflect the request's host and encoded room name so AI
    // agents can open the tab and retry.
    expect(body.room_url).toBe("http://127.0.0.1:8787/?room=empty-room");
  });

  it("returns 400 when source is missing", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(
      new Request("http://x/api/agent/import-mermaid?room=r", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("broadcasts import-mermaid frame (no mode field; append-only) to connected WS client", async () => {
    const { app, bus, legacyBundle } = makeApp({ inMemory: true });
    const room = "test-mermaid-room";

    // Simulate a connected frontend: attach mock socket that records frames.
    const sock = makeMockSock();
    // DRW-116 Task 12: WS subscriptions are composite-keyed by (space, room).
    // Tests using `makeApp({ inMemory: true })` exercise the legacy bundle
    // path — routes resolve to `legacyBundle.space.id` when no middleware
    // is mounted, so subscribers must attach with the same space id to
    // receive frames.
    bus.attach(legacyBundle.space.id, room, sock);

    const resPromise = app.fetch(
      new Request(`http://x/api/agent/import-mermaid?room=${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "graph LR; A-->B" }),
      }),
    );

    // Give the request a moment to attach and send the frame
    await new Promise((r) => setTimeout(r, 50));

    // Verify the frame was broadcast to the socket
    expect(sock.sent.length).toBeGreaterThan(0);
    const frame = JSON.parse(sock.sent[0]!) as Record<string, unknown>;
    expect(frame.kind).toBe("import-mermaid");
    expect(frame.source).toBe("graph LR; A-->B");
    // DRW-083 follow-up: no mode field — append-only by design.
    expect("mode" in frame).toBe(false);
    expect(typeof frame.requestId).toBe("string");
    expect((frame.requestId as string).length).toBeGreaterThan(0);

    // Let it timeout (10s) — we won't wait. Clean up by detaching.
    bus.detach(legacyBundle.space.id, room, sock);

    // The request will eventually resolve with timeout error
    const res = await resPromise;
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("did not respond");
  }, 15000); // 15s timeout to cover the 10s backend timeout

  it("ignores client-supplied mode field (append-only invariant)", async () => {
    const { app, bus, legacyBundle } = makeApp({ inMemory: true });
    const room = "test-mode-ignored";
    const sock = makeMockSock();
    bus.attach(legacyBundle.space.id, room, sock);

    const resPromise = app.fetch(
      new Request(`http://x/api/agent/import-mermaid?room=${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Even if a caller smuggles `mode: "replace"`, the backend MUST NOT
        // forward it. Backwards-incompat with the early draft was deliberate.
        body: JSON.stringify({ source: "graph LR; A-->B", mode: "replace" }),
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(sock.sent.length).toBeGreaterThan(0);
    const frame = JSON.parse(sock.sent[0]!) as Record<string, unknown>;
    expect("mode" in frame).toBe(false);

    bus.detach(legacyBundle.space.id, room, sock);
    await resPromise; // let it resolve (timeout)
  }, 15000);

  // DRW-086: focus parameter wire-up
  it("forwards focus='new' from body to WS frame (DRW-086)", async () => {
    const { app, bus, legacyBundle } = makeApp({ inMemory: true });
    const room = "test-focus-new";
    const sock = makeMockSock();
    bus.attach(legacyBundle.space.id, room, sock);

    const resPromise = app.fetch(
      new Request(`http://x/api/agent/import-mermaid?room=${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "graph LR; A-->B", focus: "new" }),
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(sock.sent.length).toBeGreaterThan(0);
    const frame = JSON.parse(sock.sent[0]!) as Record<string, unknown>;
    expect(frame.kind).toBe("import-mermaid");
    expect(frame.focus).toBe("new");

    bus.detach(legacyBundle.space.id, room, sock);
    await resPromise;
  }, 15000);

  it("forwards focus='fit-all' from body to WS frame (DRW-086)", async () => {
    const { app, bus, legacyBundle } = makeApp({ inMemory: true });
    const room = "test-focus-fit-all";
    const sock = makeMockSock();
    bus.attach(legacyBundle.space.id, room, sock);

    const resPromise = app.fetch(
      new Request(`http://x/api/agent/import-mermaid?room=${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "graph LR; A-->B", focus: "fit-all" }),
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(sock.sent.length).toBeGreaterThan(0);
    const frame = JSON.parse(sock.sent[0]!) as Record<string, unknown>;
    expect(frame.kind).toBe("import-mermaid");
    expect(frame.focus).toBe("fit-all");

    bus.detach(legacyBundle.space.id, room, sock);
    await resPromise;
  }, 15000);

  it("forwards focus='none' from body to WS frame (DRW-086)", async () => {
    const { app, bus, legacyBundle } = makeApp({ inMemory: true });
    const room = "test-focus-none";
    const sock = makeMockSock();
    bus.attach(legacyBundle.space.id, room, sock);

    const resPromise = app.fetch(
      new Request(`http://x/api/agent/import-mermaid?room=${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "graph LR; A-->B", focus: "none" }),
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(sock.sent.length).toBeGreaterThan(0);
    const frame = JSON.parse(sock.sent[0]!) as Record<string, unknown>;
    expect(frame.kind).toBe("import-mermaid");
    expect(frame.focus).toBe("none");

    bus.detach(legacyBundle.space.id, room, sock);
    await resPromise;
  }, 15000);

  it("omits focus field from WS frame when not provided in body (DRW-086)", async () => {
    const { app, bus, legacyBundle } = makeApp({ inMemory: true });
    const room = "test-focus-omitted";
    const sock = makeMockSock();
    bus.attach(legacyBundle.space.id, room, sock);

    const resPromise = app.fetch(
      new Request(`http://x/api/agent/import-mermaid?room=${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "graph LR; A-->B" }),
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(sock.sent.length).toBeGreaterThan(0);
    const frame = JSON.parse(sock.sent[0]!) as Record<string, unknown>;
    // When focus not provided — should not be present in frame (undefined/absent)
    expect("focus" in frame).toBe(false);

    bus.detach(legacyBundle.space.id, room, sock);
    await resPromise;
  }, 15000);
});
