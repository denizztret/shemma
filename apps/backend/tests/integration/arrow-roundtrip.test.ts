import { describe, expect, test } from "bun:test";
import { makeApp } from "../../src/index";
import type { Sock } from "../../src/ws";

// B1.3 (Phase 2.2): user-drawn arrow roundtrip via /api/patch.
// Contract verified: edge add → canvas.edges has entry + opLog persists op +
// WS broadcast carries the edge add to attached sockets.
//
// Bus API exposes attach/publish (no subscribe); we hook a fake Sock to
// observe broadcasts — cleaner than extending the bus surface.

describe("user arrow roundtrip", () => {
  test("add edge op → canvas.edges + opLog + ws broadcast contain it", async () => {
    const { app, rooms, bus } = makeApp({ inMemory: true });

    // Seed two nodes so the edge endpoints validate.
    const r = await rooms.get("ar1");
    r.canvas.nodes.push({
      id: "shape:e_a",
      kind: "rect",
      x: 0,
      y: 0,
      label: "a",
    });
    r.canvas.nodes.push({
      id: "shape:e_b",
      kind: "rect",
      x: 100,
      y: 0,
      label: "b",
    });

    // Capture ws broadcast by attaching a fake socket.
    const received: string[] = [];
    const sock: Sock = {
      readyState: 1,
      send: (data: string) => {
        received.push(data);
      },
    };
    bus.attach("ar1", sock);

    const edgeValue = {
      id: "shape:c_user",
      from: { kind: "node" as const, id: "shape:e_a" },
      to: { kind: "node" as const, id: "shape:e_b" },
      style: { dashed: false },
    };

    const res = await app.fetch(
      new Request("http://localhost/api/patch?room=ar1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ops: [{ op: "add", target: "edge", value: edgeValue }],
          source: "user",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBe(1);

    // State: edge persisted on canvas.
    const state = await rooms.get("ar1");
    expect(state.canvas.edges).toHaveLength(1);
    expect(state.canvas.edges[0]).toMatchObject({
      id: "shape:c_user",
      from: { kind: "node", id: "shape:e_a" },
      to: { kind: "node", id: "shape:e_b" },
    });

    // OpLog: the add op is logged with source=user.
    expect(state.opLog).toHaveLength(1);
    const entry = state.opLog.at(-1);
    expect(entry?.source).toBe("user");
    expect(entry?.version).toBe(1);
    expect(entry?.ops[0]).toMatchObject({ op: "add", target: "edge" });

    // WS broadcast: the same op went out to the attached socket.
    expect(received).toHaveLength(1);
    const msg = JSON.parse(received[0]!);
    expect(msg).toMatchObject({
      kind: "patch",
      source: "user",
      version: 1,
    });
    expect(msg.ops[0]).toMatchObject({
      op: "add",
      target: "edge",
      value: { id: "shape:c_user" },
    });
  });
});
