import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetRoomCacheForTests } from "../src/index";
import { startServer } from "../src/index";
import type { StoreChangeBatch } from "../src/store-types";

/**
 * DRW-116 Task 12 — WebSocket multi-space isolation.
 *
 * Two clients subscribing to the same `roomId` in different spaces must NOT
 * see each other's broadcasts. The subscription key is `(spaceId, roomId)`
 * (composite), so a publish to space A never reaches a subscriber bound to
 * space B even when both share the same `roomId`.
 *
 * The tests also verify that malformed / unknown `?space=` values are
 * rejected at the WS upgrade phase (before the handshake completes) when
 * `enableSpaceMiddleware: true`.
 */

let tmpXdg: string;
let dirA: string;
let dirB: string;
let origXdg: string | undefined;

beforeEach(() => {
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "ws-multi-space-xdg-"));
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ws-multi-space-A-"));
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), "ws-multi-space-B-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpXdg;
  __resetRoomCacheForTests();
});

afterEach(() => {
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  fs.rmSync(tmpXdg, { recursive: true, force: true });
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
  __resetRoomCacheForTests();
});

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

async function registerSpace(
  origin: string,
  pathStr: string,
  label: string,
): Promise<string> {
  const res = await fetch(`${origin}/api/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: pathStr, label }),
  });
  const body = (await res.json()) as { space: { id: string } };
  return body.space.id;
}

describe("WS — multi-space (composite-key) isolation", () => {
  test("broadcast in (spaceA, roomFoo) does NOT reach a subscriber to (spaceB, roomFoo)", async () => {
    const srv = await startServer({
      inMemory: true,
      port: 0,
      enableSpaceMiddleware: true,
    });
    const origin = `http://localhost:${srv.port}`;
    try {
      const idA = await registerSpace(origin, dirA, "A");
      const idB = await registerSpace(origin, dirB, "B");
      expect(idA).not.toBe(idB);

      const room = "shared-room";
      // Listener on space A
      const wsA = new WebSocket(
        `ws://localhost:${srv.port}/ws?space=${idA}&room=${room}`,
      );
      // Listener on space B (same room id, different space)
      const wsB = new WebSocket(
        `ws://localhost:${srv.port}/ws?space=${idB}&room=${room}`,
      );
      await Promise.all([
        new Promise<void>((r) => { wsA.onopen = () => r(); }),
        new Promise<void>((r) => { wsB.onopen = () => r(); }),
      ]);

      // biome-ignore lint/suspicious/noExplicitAny: parsed WS messages are untyped in tests
      const seenA: any[] = [];
      // biome-ignore lint/suspicious/noExplicitAny: same
      const seenB: any[] = [];
      wsA.onmessage = (e) => seenA.push(JSON.parse(e.data as string));
      wsB.onmessage = (e) => seenB.push(JSON.parse(e.data as string));

      // Sender attaches to (spaceA, room) and emits a user-change frame.
      // Routes call bus.publish(spaceA, room, …) — wsB must NOT receive it.
      const sender = new WebSocket(
        `ws://localhost:${srv.port}/ws?space=${idA}&room=${room}`,
      );
      await new Promise<void>((r) => { sender.onopen = () => r(); });

      const changes = rectBatch("isolated", "alpha");
      sender.send(
        JSON.stringify({
          kind: "user-change",
          changes,
          clientOpId: "iso-1",
        }),
      );

      // Wait for wsA to see the broadcast — wsB must remain empty.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timeout waiting for store-change on wsA")),
          1500,
        );
        const tick = () => {
          if (seenA.some((m) => m.kind === "store-change")) {
            clearTimeout(timer);
            resolve();
          } else {
            setTimeout(tick, 10);
          }
        };
        tick();
      });

      // Tiny extra delay so any (incorrect) cross-space broadcast has time to land.
      await new Promise((r) => setTimeout(r, 50));

      const aChange = seenA.find((m) => m.kind === "store-change");
      expect(aChange).toBeDefined();
      expect(aChange.changes).toEqual(changes);
      // Critical: wsB must never have received a store-change frame.
      const bChange = seenB.find((m) => m.kind === "store-change");
      expect(bChange).toBeUndefined();

      wsA.close();
      wsB.close();
      sender.close();
    } finally {
      await srv.close();
    }
  });

  test("WS upgrade rejected (400) with malformed ?space= when middleware enabled", async () => {
    const srv = await startServer({
      inMemory: true,
      port: 0,
      enableSpaceMiddleware: true,
    });
    try {
      // Malformed id — uppercase/underscore violate SPACE_ID_PATTERN.
      const res = await fetch(
        `http://localhost:${srv.port}/ws?space=Invalid_ID&room=foo`,
      );
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("invalid space id");
    } finally {
      await srv.close();
    }
  });

  test("WS upgrade rejected (400) with unknown ?space= when middleware enabled", async () => {
    const srv = await startServer({
      inMemory: true,
      port: 0,
      enableSpaceMiddleware: true,
    });
    try {
      // Well-formed but never registered — registry lookup returns undefined.
      const res = await fetch(
        `http://localhost:${srv.port}/ws?space=ghost-space&room=foo`,
      );
      expect(res.status).toBe(400);
    } finally {
      await srv.close();
    }
  });

  test("WS upgrade without ?space= still succeeds (legacy compat) when middleware enabled", async () => {
    // Browser tabs from frontends that haven't shipped multi-space query
    // strings keep working — they land in the legacy bundle bucket.
    const srv = await startServer({
      inMemory: true,
      port: 0,
      enableSpaceMiddleware: true,
    });
    try {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws?room=foo`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws errored"));
        setTimeout(() => reject(new Error("timeout")), 1000);
      });
      ws.close();
    } finally {
      await srv.close();
    }
  });
});
