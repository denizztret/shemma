// Unit tests for the Phase 3.0 store-sync transport layer.
//
// Scope:
//   - batchToDiff / diffToBatch shape preservation (identity by design).
//   - startStoreSync: hello on open, user-change emission with debounce,
//     echo-guard via clientOpId, mergeRemoteChanges path for inbound diffs.
//
// We mock the WebSocket and the tldraw Editor.store seam — no real network,
// no DOM — so this file runs under `bun test` without a browser.

import { describe, expect, it, test } from "bun:test";
import {
  type StoreChangeBatch,
  batchToDiff,
  createBoardFocusBeacon,
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

// Minimal stub for the tldraw schema — startStoreSync serialises it on open.
const MOCK_SCHEMA = {
  schemaVersion: 2,
  sequences: { "com.tldraw.shape.geo": 9 },
};

class MockStore {
  listeners: StoreListener[] = [];
  applied: StoreChangeBatch[] = [];
  mergeCalls = 0;

  // Minimal schema stub so startStoreSync can call schema.serialize().
  schema = { serialize: () => MOCK_SCHEMA };

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

function makeDeps(initialVersion = 0, room = "test-room") {
  const sock = new MockSocket();
  const store = new MockStore();
  const editor = { store } as unknown as Parameters<
    typeof startStoreSync
  >[0]["editor"];
  let truncated = 0;
  const sync = startStoreSync({
    editor,
    wsUrl: "ws://test/ws?room=t",
    room,
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
    setPaused: sync.setPaused,
    beacon: sync.beacon,
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
  test("sends hello with initialVersion and schema on open", () => {
    const t = makeDeps(7);
    t.sock.open();
    // Frame 0: hello, Frame 1: board-focus
    expect(t.sock.sent.length).toBe(2);
    const frame = JSON.parse(t.sock.sent[0]!);
    expect(frame.kind).toBe("hello");
    expect(frame.lastVersion).toBe(7);
    // Schema should be included from editor.store.schema.serialize().
    expect(frame.schema).toEqual(MOCK_SCHEMA);
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
    // hello + board-focus + user-change
    expect(t.sock.sent.length).toBe(3);
    const frame = JSON.parse(t.sock.sent[2]!);
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
    expect(t.sock.sent.length).toBe(2); // hello + board-focus
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
      // sent[0]=hello, sent[1]=board-focus, sent[2]=user-change
      const outFrame = JSON.parse(t.sock.sent[2]!);
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

describe("startStoreSync — setPaused (DRW-018)", () => {
  test("setPaused(true) drops inbound store-change without applying", () => {
    const t = makeDeps(0);
    t.sock.open();
    t.setPaused(true);
    t.sock.message({
      kind: "store-change",
      source: "ai",
      changes: sampleBatch(),
      version: 5,
      originClientId: "someone-else",
    });
    expect(t.store.mergeCalls).toBe(0);
    expect(t.store.applied.length).toBe(0);
    t.stop();
  });

  test("setPaused(true) drops inbound replay without applying", () => {
    const t = makeDeps(0);
    t.sock.open();
    t.setPaused(true);
    t.sock.message({
      kind: "replay",
      changes: [sampleBatch(), sampleBatch()],
      version: 9,
    });
    expect(t.store.mergeCalls).toBe(0);
    expect(t.store.applied.length).toBe(0);
    t.stop();
  });

  test("setPaused(false) restores normal application of subsequent frames", () => {
    const t = makeDeps(0);
    t.sock.open();
    t.setPaused(true);
    t.sock.message({
      kind: "store-change",
      source: "ai",
      changes: sampleBatch(),
      version: 1,
      originClientId: "x",
    });
    expect(t.store.applied.length).toBe(0);
    t.setPaused(false);
    t.sock.message({
      kind: "store-change",
      source: "ai",
      changes: sampleBatch(),
      version: 2,
      originClientId: "x",
    });
    expect(t.store.mergeCalls).toBe(1);
    expect(t.store.applied.length).toBe(1);
    t.stop();
  });

  test("outbound user-change keeps flowing while paused", async () => {
    const t = makeDeps(0);
    t.sock.open();
    t.setPaused(true);
    // User keeps drawing during recovery — their mutations must reach the wire.
    t.store.emit({
      added: { [`shape:p`]: rect("p", "p") as never },
      updated: {},
      removed: {},
    });
    await sleep(15); // > debounceMs
    // hello + board-focus + user-change
    expect(t.sock.sent.length).toBe(3);
    const frame = JSON.parse(t.sock.sent[2]!);
    expect(frame.kind).toBe("user-change");
    expect(Object.keys(frame.changes.added)).toEqual(["shape:p"]);
    t.stop();
  });

  test("truncated still fires onTruncated while paused", () => {
    const t = makeDeps(0);
    t.sock.open();
    t.setPaused(true);
    t.sock.message({ kind: "truncated", version: 42 });
    expect(t.truncatedCount()).toBe(1);
    t.stop();
  });
});

// --- createBoardFocusBeacon standalone tests --------------------------------

describe("createBoardFocusBeacon", () => {
  it("emits focused=true on focus event", () => {
    const sent: object[] = [];
    const beacon = createBoardFocusBeacon({
      send: (m) => sent.push(m),
      getCurrentRoom: () => "room-a",
    });
    beacon.emitFocus();
    expect(sent).toEqual([
      { kind: "board-focus", room: "room-a", focused: true },
    ]);
  });

  it("emits focused=false on blur", () => {
    const sent: object[] = [];
    const beacon = createBoardFocusBeacon({
      send: (m) => sent.push(m),
      getCurrentRoom: () => "room-a",
    });
    beacon.emitBlur();
    expect(sent).toEqual([
      { kind: "board-focus", room: "room-a", focused: false },
    ]);
  });

  it("on room switch emits blur(old) then focus(new)", () => {
    const sent: object[] = [];
    let current = "room-a";
    const beacon = createBoardFocusBeacon({
      send: (m) => sent.push(m),
      getCurrentRoom: () => current,
    });
    beacon.emitFocus();
    sent.length = 0;
    beacon.notifyRoomSwitch("room-a", "room-b");
    current = "room-b";
    expect(sent).toEqual([
      { kind: "board-focus", room: "room-a", focused: false },
      { kind: "board-focus", room: "room-b", focused: true },
    ]);
  });
});

// --- startStoreSync board-focus integration test ----------------------------

describe("startStoreSync — board-focus beacon", () => {
  test("sends board-focus(focused=true) after open, after hello", () => {
    const t = makeDeps(0, "my-room");
    t.sock.open();
    // Frame 0: hello, Frame 1: board-focus
    expect(t.sock.sent.length).toBe(2);
    const focus = JSON.parse(t.sock.sent[1]!);
    expect(focus).toEqual({
      kind: "board-focus",
      room: "my-room",
      focused: true,
    });
    t.stop();
  });

  test("beacon.emitBlur sends board-focus(focused=false)", () => {
    const t = makeDeps(0, "room-x");
    t.sock.open();
    const before = t.sock.sent.length; // hello + focus = 2
    t.beacon.emitBlur();
    expect(t.sock.sent.length).toBe(before + 1);
    const blur = JSON.parse(t.sock.sent[before]!);
    expect(blur).toEqual({ kind: "board-focus", room: "room-x", focused: false });
    t.stop();
  });

  test("beacon respects stopped flag — no send after stop()", () => {
    const t = makeDeps(0, "room-z");
    t.sock.open();
    t.stop();
    const countAfterStop = t.sock.sent.length;
    t.beacon.emitFocus();
    t.beacon.emitBlur();
    expect(t.sock.sent.length).toBe(countAfterStop); // nothing new
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
    // hello + board-focus are the only frames (stop prevents new ones).
    expect(t.sock.sent.length).toBe(2);
  });
});

describe("startStoreSync — import-mermaid callback (DRW-083)", () => {
  function makeDepsWithImport(
    onImportMermaid?: (
      source: string,
      requestId: string,
      focus?: "new" | "fit-all" | "none",
    ) => Promise<{
      ok: boolean;
      shapeIds?: string[];
      didrawNames?: string[];
      rootIds?: string[];
      error?: string;
    }>,
  ) {
    const sock = new MockSocket();
    const store = new MockStore();
    const editor = { store } as unknown as Parameters<typeof startStoreSync>[0]["editor"];
    const sync = startStoreSync({
      editor,
      wsUrl: "ws://test/ws?room=t",
      room: "test-room",
      initialVersion: 0,
      onTruncated: () => {},
      debounceMs: 5,
      socketFactory: () => sock as unknown as WebSocket,
      onImportMermaid,
    });
    return { sock, store, stop: sync.stop };
  }

  test("import-mermaid frame calls onImportMermaid callback and sends result back", async () => {
    const calls: Array<{ source: string; requestId: string }> = [];
    const { sock, stop } = makeDepsWithImport(async (source, requestId) => {
      calls.push({ source, requestId });
      return { ok: true, shapeIds: ["s1", "s2"], didrawNames: ["a", "b"], rootIds: ["s1"] };
    });
    sock.open();
    const beforeSent = sock.sent.length;

    sock.message({ kind: "import-mermaid", source: "graph LR; A-->B", requestId: "req-xyz" });

    // Wait for the async callback to complete
    await sleep(20);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.source).toBe("graph LR; A-->B");
    expect(calls[0]!.requestId).toBe("req-xyz");

    // Should have sent back import-mermaid-result
    const resultFrames = sock.sent.slice(beforeSent).map((s) => JSON.parse(s));
    const resultFrame = resultFrames.find((f: { kind: string }) => f.kind === "import-mermaid-result");
    expect(resultFrame).toBeDefined();
    expect(resultFrame.ok).toBe(true);
    expect(resultFrame.requestId).toBe("req-xyz");
    expect(resultFrame.shape_ids).toEqual(["s1", "s2"]);
    expect(resultFrame.root_ids).toEqual(["s1"]);

    stop();
  });

  test("import-mermaid sends error result when callback throws", async () => {
    const { sock, stop } = makeDepsWithImport(async () => {
      throw new Error("invalid mermaid");
    });
    sock.open();
    const beforeSent = sock.sent.length;

    sock.message({ kind: "import-mermaid", source: "bad source", requestId: "req-err" });
    await sleep(20);

    const resultFrames = sock.sent.slice(beforeSent).map((s) => JSON.parse(s));
    const resultFrame = resultFrames.find((f: { kind: string }) => f.kind === "import-mermaid-result");
    expect(resultFrame).toBeDefined();
    expect(resultFrame.ok).toBe(false);
    expect(resultFrame.error).toContain("invalid mermaid");
    expect(resultFrame.requestId).toBe("req-err");

    stop();
  });

  test("import-mermaid is silently ignored when no onImportMermaid callback", async () => {
    const { sock, stop } = makeDepsWithImport(undefined);
    sock.open();
    const beforeSent = sock.sent.length;

    sock.message({ kind: "import-mermaid", source: "graph LR; A-->B", requestId: "req-noop" });
    await sleep(20);

    // No extra frames sent (no callback → no result)
    const newFrames = sock.sent.slice(beforeSent);
    expect(newFrames.length).toBe(0);

    stop();
  });
});

// DRW-149: layoutAction flag dispatches through history wrap (Cmd+Z support)
describe("startStoreSync — layoutAction undo path (DRW-149)", () => {
  // Extended MockStore that also captures editor.markHistoryStoppingPoint /
  // editor.run calls. Because startStoreSync receives `deps.editor`, we attach
  // spy methods directly onto the editor stub.

  function makeDepsWithHistorySpies() {
    const sock = new MockSocket();
    const store = new MockStore();

    const historyStops: string[] = [];
    const runCalls: Array<{ opts: unknown }> = [];

    const editorBase = { store };
    const editor = Object.assign(editorBase, {
      markHistoryStoppingPoint: (name?: string) => {
        historyStops.push(name ?? "");
        return "";
      },
      run: (fn: () => void, opts?: unknown) => {
        runCalls.push({ opts });
        fn(); // execute the callback so applyDiff is actually called
        return editor;
      },
    }) as unknown as Parameters<typeof startStoreSync>[0]["editor"];

    const sync = startStoreSync({
      editor,
      wsUrl: "ws://test/ws?room=t",
      room: "test-room",
      initialVersion: 0,
      onTruncated: () => {},
      debounceMs: 5,
      socketFactory: () => sock as unknown as WebSocket,
    });

    return {
      sock,
      store,
      historyStops,
      runCalls,
      stop: sync.stop,
      setPaused: sync.setPaused,
    };
  }

  test("layoutAction=true routes through markHistoryStoppingPoint + editor.run", () => {
    const t = makeDepsWithHistorySpies();
    t.sock.open();

    const changes = sampleBatch();
    t.sock.message({
      kind: "store-change",
      source: "ai",
      changes,
      version: 1,
      layoutAction: true,
    });

    expect(t.historyStops).toHaveLength(1);
    expect(t.historyStops[0]).toBe("Autolayout");
    expect(t.runCalls).toHaveLength(1);
    expect((t.runCalls[0]!.opts as { history: string }).history).toBe("record");
    // mergeRemoteChanges must NOT have been called
    expect(t.store.mergeCalls).toBe(0);
    // But the diff still reaches applyDiff (via editor.run callback)
    expect(t.store.applied).toHaveLength(1);

    t.stop();
  });

  test("layoutAction absent → legacy mergeRemoteChanges path, no history stop", () => {
    const t = makeDepsWithHistorySpies();
    t.sock.open();

    t.sock.message({
      kind: "store-change",
      source: "ai",
      changes: sampleBatch(),
      version: 2,
    });

    expect(t.historyStops).toHaveLength(0);
    expect(t.runCalls).toHaveLength(0);
    expect(t.store.mergeCalls).toBe(1);
    expect(t.store.applied).toHaveLength(1);

    t.stop();
  });

  test("layoutAction=true is skipped when paused (drop, no history entry)", () => {
    const t = makeDepsWithHistorySpies();
    t.sock.open();
    t.setPaused(true);

    t.sock.message({
      kind: "store-change",
      source: "ai",
      changes: sampleBatch(),
      version: 3,
      layoutAction: true,
    });

    expect(t.historyStops).toHaveLength(0);
    expect(t.runCalls).toHaveLength(0);
    expect(t.store.applied).toHaveLength(0);

    t.stop();
  });
});

// DRW-086: focus parameter propagation through WS transport
describe("startStoreSync — import-mermaid focus parameter (DRW-086)", () => {
  function makeDepsWithFocusCapture() {
    const sock = new MockSocket();
    const store = new MockStore();
    const editor = { store } as unknown as Parameters<typeof startStoreSync>[0]["editor"];
    const captured: Array<{ source: string; requestId: string; focus?: string }> = [];
    const sync = startStoreSync({
      editor,
      wsUrl: "ws://test/ws?room=t",
      room: "test-room",
      initialVersion: 0,
      onTruncated: () => {},
      debounceMs: 5,
      socketFactory: () => sock as unknown as WebSocket,
      onImportMermaid: async (source, requestId, focus) => {
        captured.push({ source, requestId, focus });
        return { ok: true, shapeIds: ["s1"], didrawNames: ["a"], rootIds: ["s1"] };
      },
    });
    return { sock, captured, stop: sync.stop };
  }

  test("focus='new' is passed to onImportMermaid callback", async () => {
    const { sock, captured, stop } = makeDepsWithFocusCapture();
    sock.open();
    sock.message({ kind: "import-mermaid", source: "graph LR; A-->B", requestId: "req-focus-new", focus: "new" });
    await sleep(20);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.focus).toBe("new");
    stop();
  });

  test("focus='fit-all' is passed to onImportMermaid callback", async () => {
    const { sock, captured, stop } = makeDepsWithFocusCapture();
    sock.open();
    sock.message({ kind: "import-mermaid", source: "graph LR; A-->B", requestId: "req-focus-fit", focus: "fit-all" });
    await sleep(20);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.focus).toBe("fit-all");
    stop();
  });

  test("focus='none' is passed to onImportMermaid callback", async () => {
    const { sock, captured, stop } = makeDepsWithFocusCapture();
    sock.open();
    sock.message({ kind: "import-mermaid", source: "graph LR; A-->B", requestId: "req-focus-none", focus: "none" });
    await sleep(20);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.focus).toBe("none");
    stop();
  });

  test("focus omitted → undefined passed to callback (defaults to 'new' in handler)", async () => {
    const { sock, captured, stop } = makeDepsWithFocusCapture();
    sock.open();
    sock.message({ kind: "import-mermaid", source: "graph LR; A-->B", requestId: "req-no-focus" });
    await sleep(20);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.focus).toBeUndefined();
    stop();
  });
});
