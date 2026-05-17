import { describe, expect, test } from "bun:test";
import { startServer } from "../src/index";
import type { StoreChangeBatch } from "../src/store-types";
import { parseClientMessage } from "../src/ws-protocol";

function rectBatch(id: string, name: string): StoreChangeBatch {
  return {
    added: {
      [`shape:${id}`]: {
        id: `shape:${id}`,
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
        meta: { didrawName: name },
      },
    },
    updated: {},
    removed: {},
  };
}

describe("parseClientMessage — user-change", () => {
  test("accepts a well-formed user-change frame", () => {
    const changes = rectBatch("a", "alpha");
    const raw = JSON.stringify({
      kind: "user-change",
      changes,
      clientOpId: "op-123",
    });
    const m = parseClientMessage(raw);
    expect(m).toEqual({ kind: "user-change", changes, clientOpId: "op-123" });
  });

  test("clientOpId is optional", () => {
    const changes = rectBatch("b", "beta");
    const raw = JSON.stringify({ kind: "user-change", changes });
    const m = parseClientMessage(raw);
    expect(m?.kind).toBe("user-change");
    if (m?.kind === "user-change") {
      expect(m.clientOpId).toBeUndefined();
      expect(m.changes).toEqual(changes);
    }
  });

  test("accepts empty batch (added/updated/removed all {})", () => {
    const empty: StoreChangeBatch = { added: {}, updated: {}, removed: {} };
    const raw = JSON.stringify({ kind: "user-change", changes: empty });
    const m = parseClientMessage(raw);
    expect(m).toEqual({ kind: "user-change", changes: empty });
  });

  test("rejects missing changes field", () => {
    expect(parseClientMessage('{"kind":"user-change"}')).toBeNull();
  });

  test("rejects when added/updated/removed is an array", () => {
    expect(
      parseClientMessage(
        '{"kind":"user-change","changes":{"added":[],"updated":{},"removed":{}}}',
      ),
    ).toBeNull();
  });

  test("rejects when an updated entry is not a 2-tuple", () => {
    expect(
      parseClientMessage(
        '{"kind":"user-change","changes":{"added":{},"updated":{"shape:x":{}},"removed":{}}}',
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        '{"kind":"user-change","changes":{"added":{},"updated":{"shape:x":[{"id":"shape:x"}]},"removed":{}}}',
      ),
    ).toBeNull();
  });

  test("rejects non-object changes", () => {
    expect(
      parseClientMessage('{"kind":"user-change","changes":null}'),
    ).toBeNull();
    expect(
      parseClientMessage('{"kind":"user-change","changes":42}'),
    ).toBeNull();
  });

  test("decodes binary frames (Uint8Array)", () => {
    const enc = new TextEncoder().encode(
      '{"kind":"user-change","changes":{"added":{},"updated":{},"removed":{}}}',
    );
    const m = parseClientMessage(enc);
    expect(m?.kind).toBe("user-change");
  });
});

describe("WS user-change — end-to-end", () => {
  test("user-change bumps version, persists in opLog, and re-broadcasts", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    try {
      // Listener client — observes broadcasts.
      const listener = new WebSocket(
        `ws://localhost:${srv.port}/ws?room=uc1`,
      );
      await new Promise<void>((r) => {
        listener.onopen = () => r();
      });
      // Sender client — emits user-change.
      const sender = new WebSocket(
        `ws://localhost:${srv.port}/ws?room=uc1`,
      );
      await new Promise<void>((r) => {
        sender.onopen = () => r();
      });

      // biome-ignore lint/suspicious/noExplicitAny: parsed WS messages are untyped in tests
      const seen: any[] = [];
      const waitForChange = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timeout waiting for store-change")),
          1000,
        );
        listener.onmessage = (e) => {
          const m = JSON.parse(e.data as string);
          seen.push(m);
          if (m.kind === "store-change") {
            clearTimeout(timer);
            resolve();
          }
        };
      });

      const changes = rectBatch("uc1", "alpha");
      sender.send(
        JSON.stringify({
          kind: "user-change",
          changes,
          clientOpId: "op-uc1",
        }),
      );
      await waitForChange;

      const broadcast = seen.find((m) => m.kind === "store-change");
      expect(broadcast).toBeDefined();
      expect(broadcast.source).toBe("user");
      expect(broadcast.version).toBe(1);
      expect(broadcast.originClientId).toBe("op-uc1");
      expect(broadcast.changes).toEqual(changes);

      // /api/state should reflect the applied mutation.
      const stateRes = await fetch(
        `http://localhost:${srv.port}/api/state?room=uc1`,
      );
      const state = await stateRes.json();
      expect(state.version).toBe(1);
      expect(state.store.store["shape:uc1"]?.meta?.didrawName).toBe("alpha");

      listener.close();
      sender.close();
    } finally {
      await srv.close();
    }
  });

  test("empty user-change batch is a no-op (version stays)", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    try {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws?room=uc2`);
      await new Promise<void>((r) => {
        ws.onopen = () => r();
      });
      ws.send(
        JSON.stringify({
          kind: "user-change",
          changes: { added: {}, updated: {}, removed: {} },
        }),
      );
      // Allow the server to process and (importantly) NOT broadcast.
      await new Promise((r) => setTimeout(r, 100));
      const stateRes = await fetch(
        `http://localhost:${srv.port}/api/state?room=uc2`,
      );
      const state = await stateRes.json();
      expect(state.version).toBe(0);
      ws.close();
    } finally {
      await srv.close();
    }
  });
});
