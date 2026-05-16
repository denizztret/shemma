import { describe, expect, test } from "bun:test";
import { startServer } from "../src/index";
import { makeRoomState } from "../src/rooms";
import type { StoreChangeBatch, StoreOpLogEntry } from "../src/store-types";
import { handleHello, parseClientMessage } from "../src/ws-protocol";

function makeOpLogEntry(version: number, label = "n"): StoreOpLogEntry {
  const id = `shape:${label}${version}`;
  const batch: StoreChangeBatch = {
    added: {
      [id]: {
        id,
        typeName: "shape",
        type: "geo",
        x: 0,
        y: 0,
        parentId: "page:page",
        index: "a1",
        isLocked: false,
        opacity: 1,
        rotation: 0,
        props: { w: 100, h: 60, geo: "rectangle" },
        meta: { didrawName: `${label}${version}` },
      },
    },
    updated: {},
    removed: {},
  };
  return { ops: batch, source: "user", version, at: 0 };
}

describe("ws-protocol.parseClientMessage", () => {
  test("accepts a well-formed hello", () => {
    const m = parseClientMessage('{"kind":"hello","lastVersion":3}');
    expect(m).toEqual({ kind: "hello", lastVersion: 3 });
  });

  test("rejects malformed JSON", () => {
    expect(parseClientMessage("not json")).toBeNull();
  });

  test("rejects unknown kind", () => {
    expect(parseClientMessage('{"kind":"chat","text":"hi"}')).toBeNull();
  });

  test("rejects hello without numeric lastVersion", () => {
    expect(parseClientMessage('{"kind":"hello"}')).toBeNull();
    expect(parseClientMessage('{"kind":"hello","lastVersion":"3"}')).toBeNull();
    expect(
      parseClientMessage('{"kind":"hello","lastVersion":null}'),
    ).toBeNull();
  });

  test("decodes binary frames (Uint8Array / ArrayBuffer)", () => {
    const enc = new TextEncoder().encode('{"kind":"hello","lastVersion":1}');
    expect(parseClientMessage(enc)).toEqual({ kind: "hello", lastVersion: 1 });
    expect(parseClientMessage(enc.buffer)).toEqual({
      kind: "hello",
      lastVersion: 1,
    });
  });
});

describe("ws-protocol.handleHello", () => {
  test("sync-ack when client is up-to-date", () => {
    const r = makeRoomState();
    r.version = 5;
    r.opLog = [makeOpLogEntry(4), makeOpLogEntry(5)];
    expect(handleHello(r, 5)).toEqual({ kind: "sync-ack", version: 5 });
  });

  test("sync-ack when client is ahead (defensive)", () => {
    const r = makeRoomState();
    r.version = 5;
    expect(handleHello(r, 99)).toEqual({ kind: "sync-ack", version: 5 });
  });

  test("replay returns batches since lastVersion", () => {
    const r = makeRoomState();
    r.version = 5;
    r.opLog = [
      makeOpLogEntry(2),
      makeOpLogEntry(3),
      makeOpLogEntry(4),
      makeOpLogEntry(5),
    ];
    const reply = handleHello(r, 3);
    expect(reply.kind).toBe("replay");
    if (reply.kind !== "replay") throw new Error("kind mismatch");
    expect(reply.version).toBe(5);
    expect(reply.changes.length).toBe(2);
  });

  test("replay covers the full opLog when lastVersion sits exactly at the boundary", () => {
    const r = makeRoomState();
    r.version = 7;
    // Oldest retained version = 4; client at last=3 → gap touches boundary.
    r.opLog = [
      makeOpLogEntry(4),
      makeOpLogEntry(5),
      makeOpLogEntry(6),
      makeOpLogEntry(7),
    ];
    const reply = handleHello(r, 3);
    expect(reply.kind).toBe("replay");
    if (reply.kind !== "replay") throw new Error("kind mismatch");
    expect(reply.changes.length).toBe(4);
  });

  test("truncated when gap exceeds opLog window", () => {
    const r = makeRoomState();
    r.version = 10;
    // Oldest retained = 5, client at 2 → 5 > 2+1 → cannot replay.
    r.opLog = [makeOpLogEntry(5), makeOpLogEntry(6), makeOpLogEntry(7)];
    expect(handleHello(r, 2)).toEqual({ kind: "truncated", version: 10 });
  });

  test("truncated when opLog is empty and client is behind (post-restart)", () => {
    const r = makeRoomState();
    r.version = 4;
    r.opLog = [];
    expect(handleHello(r, 1)).toEqual({ kind: "truncated", version: 4 });
  });

  test("sync-ack on fresh room when client also at 0", () => {
    const r = makeRoomState();
    expect(handleHello(r, 0)).toEqual({ kind: "sync-ack", version: 0 });
  });
});

// Helper for the end-to-end test: collect messages until predicate satisfied.
function collectUntil(
  ws: WebSocket,
  predicate: (msg: { kind: string }) => boolean,
  timeoutMs = 1000,
  // biome-ignore lint/suspicious/noExplicitAny: parsed WS messages are untyped in tests
): Promise<any[]> {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  return new Promise<any[]>((resolve, reject) => {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const buf: any[] = [];
    const timer = setTimeout(
      () => reject(new Error("timeout waiting for WS message")),
      timeoutMs,
    );
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      buf.push(m);
      if (predicate(m)) {
        clearTimeout(timer);
        resolve(buf);
      }
    };
  });
}

describe("WS hello/replay — end-to-end", () => {
  test("client hello with lastVersion>=server.version receives sync-ack", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    try {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws?room=hr1`);
      await new Promise<void>((r) => {
        ws.onopen = () => r();
      });
      const wait = collectUntil(ws, (m) => m.kind === "sync-ack");
      ws.send(JSON.stringify({ kind: "hello", lastVersion: 0 }));
      const msgs = await wait;
      const ack = msgs.find((m) => m.kind === "sync-ack");
      expect(ack).toEqual({ kind: "sync-ack", version: 0 });
      ws.close();
    } finally {
      await srv.close();
    }
  });

  test("client hello with lastVersion<server.version receives replay", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    try {
      // Drive version up via /api/domain (define actions).
      for (let i = 1; i <= 3; i++) {
        const res = await fetch(
          `http://localhost:${srv.port}/api/domain?room=hr2`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              actions: [{ kind: "define", role: "service", name: `svc${i}` }],
              layoutHint: null,
            }),
          },
        );
        expect(res.ok).toBe(true);
      }
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws?room=hr2`);
      await new Promise<void>((r) => {
        ws.onopen = () => r();
      });
      const wait = collectUntil(ws, (m) => m.kind === "replay");
      ws.send(JSON.stringify({ kind: "hello", lastVersion: 1 }));
      const msgs = await wait;
      const replay = msgs.find((m) => m.kind === "replay");
      expect(replay.version).toBe(3);
      expect(replay.changes.length).toBe(2);
      ws.close();
    } finally {
      await srv.close();
    }
  });

  test("malformed client frame is ignored (no crash, connection stays open)", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    try {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws?room=hr3`);
      await new Promise<void>((r) => {
        ws.onopen = () => r();
      });
      // Bad frame → must not close the socket nor produce a response.
      ws.send("not-json");
      ws.send(JSON.stringify({ kind: "garbage" }));
      // Follow up with a real hello and assert we still get sync-ack.
      const wait = collectUntil(ws, (m) => m.kind === "sync-ack");
      ws.send(JSON.stringify({ kind: "hello", lastVersion: 0 }));
      const msgs = await wait;
      expect(msgs.some((m) => m.kind === "sync-ack")).toBe(true);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    } finally {
      await srv.close();
    }
  });
});
