import { describe, expect, it } from "bun:test";
import { makeApp } from "../src/index";
import type { Sock } from "../src/ws";

// Mock WS socket that records sent frames and can call back to simulate a
// frontend fit-text-result reply.
type MockSock = Sock & { sent: string[] };
function makeMockSock(
  opts: { onSend?: (data: string, sock: MockSock) => void } = {},
): MockSock {
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

describe("POST /api/agent/fit-text (DRW-228)", () => {
  it("returns 503 with error and room_url when no client connected", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(
      new Request("http://127.0.0.1:8787/api/agent/fit-text?room=empty-room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; room_url: string };
    expect(body.error).toBe("no client connected");
    expect(body.room_url).toBe("http://127.0.0.1:8787/?room=empty-room");
  });

  it("broadcasts a fit-text frame to the connected client (targets passed through)", async () => {
    const { app, bus, legacyBundle } = makeApp({ inMemory: true });
    const room = "test-fit-room";
    const sock = makeMockSock();
    bus.attach(legacyBundle.space.id, room, sock);

    const resPromise = app.fetch(
      new Request(`http://x/api/agent/fit-text?room=${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets: ["api", "db"] }),
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(sock.sent.length).toBeGreaterThan(0);
    const first = sock.sent[0];
    expect(first).toBeDefined();
    const frame = JSON.parse(first as string) as Record<string, unknown>;
    expect(frame.kind).toBe("fit-text");
    expect(frame.targets).toEqual(["api", "db"]);
    expect(typeof frame.requestId).toBe("string");

    bus.detach(legacyBundle.space.id, room, sock);
    const res = await resPromise;
    // No reply → 10s timeout → 500 "did not respond".
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("did not respond");
  }, 15000);

  it("omits targets from the frame when not provided", async () => {
    const { app, bus, legacyBundle } = makeApp({ inMemory: true });
    const room = "test-fit-no-targets";
    const sock = makeMockSock();
    bus.attach(legacyBundle.space.id, room, sock);

    const resPromise = app.fetch(
      new Request(`http://x/api/agent/fit-text?room=${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    const first = sock.sent[0];
    expect(first).toBeDefined();
    const frame = JSON.parse(first as string) as Record<string, unknown>;
    expect(frame.kind).toBe("fit-text");
    expect("targets" in frame).toBe(false);

    bus.detach(legacyBundle.space.id, room, sock);
    await resPromise;
  }, 15000);

  it("resolves 200 with count + shape_ids when the client replies", async () => {
    const { app, bus, legacyBundle } = makeApp({ inMemory: true });
    const room = "test-fit-ok";
    // On receiving the fit-text frame, simulate the frontend replying.
    const sock = makeMockSock({
      onSend(data) {
        const frame = JSON.parse(data) as { kind: string; requestId: string };
        if (frame.kind === "fit-text") {
          bus.resolveFitText(frame.requestId, {
            ok: true,
            count: 2,
            shape_ids: ["shape:a", "shape:b"],
          });
        }
      },
    });
    bus.attach(legacyBundle.space.id, room, sock);

    const res = await app.fetch(
      new Request(`http://x/api/agent/fit-text?room=${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      count: number;
      shape_ids: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    expect(body.shape_ids).toEqual(["shape:a", "shape:b"]);

    bus.detach(legacyBundle.space.id, room, sock);
  });
});
