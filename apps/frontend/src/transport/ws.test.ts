// Unit tests for the Phase 3.0 store-sync transport layer.
//
// Scope:
//   - batchToDiff / diffToBatch shape preservation (identity by design).
//   - startStoreSync: hello on open, user-change emission with debounce,
//     echo-guard via clientOpId, mergeRemoteChanges path for inbound diffs.
//
// We mock the WebSocket and the tldraw Editor.store seam — no real network,
// no DOM — so this file runs under `bun test` without a browser.

import { describe, expect, test } from "bun:test";
import {
  type StoreChangeBatch,
  batchToDiff,
  diffToBatch,
  startStoreSync,
} from "./ws";

// --- shared fixtures --------------------------------------------------------

function rect(id: string, name: string) {
  return {
    id: `shape:${id}`,
    typeName: "shape" as const,
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
  };
}

function sampleBatch(): StoreChangeBatch {
  const r1 = rect("a", "alpha");
  const r1Updated = { ...r1, x: 10 };
  return {
    added: { [r1.id]: r1 as never },
    updated: { [r1.id]: [r1, r1Updated] as never },
    removed: {},
  };
}

// --- minimal mocks (WebSocket + Editor) ------------------------------------

type Frame = string;

class MockSocket {
  static OPEN_VAL = 1;
  static CLOSED_VAL = 3;
  readonly OPEN = MockSocket.OPEN_VAL;
  readonly CLOSED = MockSocket.CLOSED_VAL;
  readyState: number = 0; // CONNECTING until open()

  sent: Frame[] = [];
  closed = false;

  private listeners = new Map<string, ((ev: unknown) => void)[]>();

  addEventListener(name: string, fn: (ev: unknown) => void) {
    const arr = this.listeners.get(name) ?? [];
    arr.push(fn);
    this.listeners.set(name, arr);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = this.CLOSED;
  }
  // test-only helpers
  open() {
    this.readyState = this.OPEN;
    for (const fn of this.listeners.get("open") ?? []) fn({});
  }
  message(payload: unknown) {
    for (const fn of this.listeners.get("message") ?? [])
      fn({ data: JSON.stringify(payload) } as unknown);
  }
}

type StoreListener = (entry: {
  changes: StoreChangeBatch;
  source: string;
}) => void;

class MockStore {
  listeners: StoreListener[] = [];
  applied: StoreChangeBatch[] = [];
  mergeCalls = 0;

  listen(fn: StoreListener, _filter?: unknown) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }
  mergeRemoteChanges(fn: () => void) {
    this.mergeCalls += 1;
    fn();
  }
  applyDiff(diff: unknown) {
    this.applied.push(diff as StoreChangeBatch);
  }
  // test-only helper: simulate a local user mutation.
  emit(batch: StoreChangeBatch) {
    for (const l of this.listeners) l({ changes: batch, source: "user" });
  }
}

function makeDeps(initialVersion = 0) {
  const sock = new MockSocket();
  const store = new MockStore();
  const editor = { store } as unknown as Parameters<
    typeof startStoreSync
  >[0]["editor"];
  let truncated = 0;
  const sync = startStoreSync({
    editor,
    wsUrl: "ws://test/ws?room=t",
    initialVersion,
    onTruncated: () => {
      truncated += 1;
    },
    debounceMs: 5,
    socketFactory: () => sock as unknown as WebSocket,
  });
  return {
    sock,
    store,
    stop: sync.stop,
    truncatedCount: () => truncated,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- tests -----------------------------------------------------------------

describe("batchToDiff / diffToBatch", () => {
  test("preserve added/updated/removed verbatim", () => {
    const b = sampleBatch();
    const d = batchToDiff(b);
    expect(d.added).toBe(b.added);
    expect(d.updated).toBe(b.updated);
    expect(d.removed).toBe(b.removed);
  });

  test("round-trip through diff is identity", () => {
    const b = sampleBatch();
    const back = diffToBatch(batchToDiff(b));
    expect(back).toEqual(b);
  });
});

describe("startStoreSync — handshake", () => {
  test("sends hello with initialVersion on open", () => {
    const t = makeDeps(7);
    t.sock.open();
    expect(t.sock.sent.length).toBe(1);
    const frame = JSON.parse(t.sock.sent[0]!);
    expect(frame).toEqual({ kind: "hello", lastVersion: 7 });
    t.stop();
  });
});

describe("startStoreSync — outbound user-change", () => {
  test("debounces local mutations into a single user-change frame", async () => {
    const t = makeDeps(0);
    t.sock.open();
    // Two consecutive emits within the debounce window → one outgoing frame.
    t.store.emit({
      added: { [`shape:x`]: rect("x", "x") as never },
      updated: {},
      removed: {},
    });
    t.store.emit({
      added: {},
      updated: {
        [`shape:x`]: [rect("x", "x"), { ...rect("x", "x"), x: 5 }] as never,
      },
      removed: {},
    });
    await sleep(15); // > debounceMs (5)
    // 1 hello + 1 user-change
    expect(t.sock.sent.length).toBe(2);
    const frame = JSON.parse(t.sock.sent[1]!);
    expect(frame.kind).toBe("user-change");
    expect(typeof frame.clientOpId).toBe("string");
    expect(frame.clientOpId.length).toBeGreaterThan(0);
    expect(Object.keys(frame.changes.added)).toEqual(["shape:x"]);
    expect(Object.keys(frame.changes.updated)).toEqual(["shape:x"]);
    t.stop();
  });

  test("skips empty pending batches", async () => {
    const t = makeDeps(0);
    t.sock.open();
    await sleep(15);
    expect(t.sock.sent.length).toBe(1); // only hello
    t.stop();
  });
});

describe("startStoreSync — inbound store-change", () => {
  test("applies non-self frames via mergeRemoteChanges → applyDiff", () => {
    const t = makeDeps(0);
    t.sock.open();
    const changes = sampleBatch();
    t.sock.message({
      kind: "store-change",
      source: "ai",
      changes,
      version: 3,
      originClientId: "someone-else",
    });
    expect(t.store.mergeCalls).toBe(1);
    expect(t.store.applied.length).toBe(1);
    expect(t.store.applied[0]).toEqual(changes);
    t.stop();
  });

  test("echo-guard: own clientOpId frame is dropped", () => {
    const t = makeDeps(0);
    t.sock.open();
    // Trigger an outbound to learn our generated clientOpId.
    t.store.emit({
      added: { [`shape:e`]: rect("e", "e") as never },
      updated: {},
      removed: {},
    });
    // Wait briefly for debounce flush.
    return sleep(15).then(() => {
      const outFrame = JSON.parse(t.sock.sent[1]!);
      const myOpId = outFrame.clientOpId;
      // Server re-broadcasts back with our opId — must be ignored.
      t.sock.message({
        kind: "store-change",
        source: "user",
        changes: sampleBatch(),
        version: 1,
        originClientId: myOpId,
      });
      expect(t.store.applied.length).toBe(0);
      expect(t.store.mergeCalls).toBe(0);
      t.stop();
    });
  });

  test("replay applies every batch in mergeRemoteChanges", () => {
    const t = makeDeps(0);
    t.sock.open();
    const a = sampleBatch();
    const b = sampleBatch();
    t.sock.message({ kind: "replay", changes: [a, b], version: 4 });
    expect(t.store.mergeCalls).toBe(1);
    expect(t.store.applied.length).toBe(2);
    t.stop();
  });

  test("truncated invokes onTruncated and stops further processing", () => {
    const t = makeDeps(0);
    t.sock.open();
    t.sock.message({ kind: "truncated", version: 99 });
    expect(t.truncatedCount()).toBe(1);
    // Subsequent frames must be ignored.
    t.sock.message({
      kind: "store-change",
      source: "ai",
      changes: sampleBatch(),
      version: 100,
    });
    expect(t.store.applied.length).toBe(0);
    t.stop();
  });
});

describe("startStoreSync — stop()", () => {
  test("closes socket and detaches listener", () => {
    const t = makeDeps(0);
    t.sock.open();
    t.stop();
    expect(t.sock.closed).toBe(true);
    // After stop, emitting a mutation does NOT enqueue further frames.
    t.store.emit({
      added: { [`shape:z`]: rect("z", "z") as never },
      updated: {},
      removed: {},
    });
    // hello is the only frame.
    expect(t.sock.sent.length).toBe(1);
  });
});
