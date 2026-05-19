import { describe, expect, it } from "bun:test";
import { handleHello, isPlaceholderSchema, parseClientMessage } from "../src/ws-protocol";
import type { RoomState } from "../src/types";

function roomWithLog(version: number, logVersions: number[]): RoomState {
  return {
    store: { schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} }, store: {} },
    opLog: logVersions.map((v) => ({ ops: { added: {}, updated: {}, removed: {} }, source: "ai", version: v, at: 0 })),
    prompts: [], version, dirty: false, lastTouched: 0, didrawIndex: new Map(),
  };
}

// A minimal representation of the tldraw 5.x V2 schema that the client sends.
const V2_SCHEMA = {
  schemaVersion: 2,
  sequences: {
    "com.tldraw.shape.geo": 9,
    "com.tldraw.shape.arrow": 5,
    "com.tldraw.page": 1,
    "com.tldraw.document": 2,
  },
};

describe("parseClientMessage", () => {
  it("parses hello", () => {
    expect(parseClientMessage('{"kind":"hello","lastVersion":3}')).toEqual({ kind: "hello", lastVersion: 3 });
  });
  it("rejects garbage", () => {
    expect(parseClientMessage("not-json")).toBeNull();
    expect(parseClientMessage('{"kind":"other"}')).toBeNull();
  });

  // --- schema field ---
  it("parses hello with schema field — schema is preserved opaquely", () => {
    const msg = parseClientMessage(
      JSON.stringify({ kind: "hello", lastVersion: 0, schema: V2_SCHEMA }),
    );
    expect(msg).not.toBeNull();
    expect(msg?.kind).toBe("hello");
    if (msg?.kind === "hello") {
      expect(msg.schema).toEqual(V2_SCHEMA);
    }
  });
  it("parses hello without schema field — schema is undefined", () => {
    const msg = parseClientMessage('{"kind":"hello","lastVersion":5}');
    expect(msg?.kind).toBe("hello");
    if (msg?.kind === "hello") {
      expect(msg.schema).toBeUndefined();
    }
  });
});

describe("parseClientMessage — import-mermaid-result", () => {
  it("parses ok:true result with all fields", () => {
    const msg = parseClientMessage(JSON.stringify({
      kind: "import-mermaid-result",
      requestId: "req-abc",
      ok: true,
      shape_ids: ["s1", "s2"],
      didraw_names: ["node-a", "node-b"],
      root_ids: ["s1"],
    }));
    expect(msg).not.toBeNull();
    expect(msg?.kind).toBe("import-mermaid-result");
    if (msg?.kind === "import-mermaid-result") {
      expect(msg.requestId).toBe("req-abc");
      expect(msg.ok).toBe(true);
      expect(msg.shape_ids).toEqual(["s1", "s2"]);
      expect(msg.root_ids).toEqual(["s1"]);
    }
  });

  it("parses ok:false result with error field", () => {
    const msg = parseClientMessage(JSON.stringify({
      kind: "import-mermaid-result",
      requestId: "req-err",
      ok: false,
      error: "invalid mermaid syntax",
    }));
    expect(msg?.kind).toBe("import-mermaid-result");
    if (msg?.kind === "import-mermaid-result") {
      expect(msg.ok).toBe(false);
      expect(msg.error).toBe("invalid mermaid syntax");
    }
  });

  it("rejects import-mermaid-result with missing requestId", () => {
    expect(parseClientMessage(JSON.stringify({ kind: "import-mermaid-result", ok: true }))).toBeNull();
  });

  it("rejects import-mermaid-result with missing ok", () => {
    expect(parseClientMessage(JSON.stringify({ kind: "import-mermaid-result", requestId: "r" }))).toBeNull();
  });
});

describe("isPlaceholderSchema", () => {
  it("identifies the V1 stub produced by defaultSchema() as placeholder", () => {
    const stub = { schemaVersion: 1, storeVersion: 4, recordVersions: {} };
    expect(isPlaceholderSchema(stub)).toBe(true);
  });
  it("identifies a V2 schema (sequences present) as NOT placeholder", () => {
    expect(isPlaceholderSchema(V2_SCHEMA)).toBe(false);
  });
  it("treats null / non-object as placeholder (defensive)", () => {
    expect(isPlaceholderSchema(null)).toBe(true);
    expect(isPlaceholderSchema(undefined)).toBe(true);
    expect(isPlaceholderSchema("string")).toBe(true);
  });
});

describe("handleHello — schema upgrade", () => {
  it("replaces placeholder schema with client's V2 schema on first connect", () => {
    const r = roomWithLog(0, []);
    const result = handleHello(r, 0, V2_SCHEMA);
    expect(result.schemaUpgraded).toBe(true);
    expect(r.store.schema).toEqual(V2_SCHEMA as any);
  });
  it("does NOT replace schema when room already has V2 schema", () => {
    const r = roomWithLog(0, []);
    r.store = { ...r.store, schema: V2_SCHEMA as any };
    const result = handleHello(r, 0, V2_SCHEMA);
    expect(result.schemaUpgraded).toBe(false);
    expect(r.store.schema).toEqual(V2_SCHEMA as any);
  });
  it("does NOT replace schema when client sends no schema", () => {
    const r = roomWithLog(0, []);
    const result = handleHello(r, 0, undefined);
    expect(result.schemaUpgraded).toBe(false);
    // stub schema unchanged
    expect((r.store.schema as any).schemaVersion).toBe(1);
  });
});

describe("handleHello", () => {
  it("up-to-date → sync-ack", () => {
    const r = roomWithLog(5, [3, 4, 5]);
    expect(handleHello(r, 5).reply).toEqual({ kind: "sync-ack", version: 5 });
  });
  it("delta within window → replay with changes", () => {
    const r = roomWithLog(5, [3, 4, 5]);
    const { reply: m } = handleHello(r, 3);
    expect(m.kind).toBe("replay");
    if (m.kind === "replay") {
      expect(m.changes.length).toBe(2); // versions 4, 5
      expect(m.version).toBe(5);
    }
  });
  it("gap beyond window → truncated", () => {
    const r = roomWithLog(10, [8, 9, 10]);
    expect(handleHello(r, 2).reply).toEqual({ kind: "truncated", version: 10 });
  });
  it("empty opLog with version 0 → sync-ack at 0", () => {
    const r = roomWithLog(0, []);
    expect(handleHello(r, 0).reply).toEqual({ kind: "sync-ack", version: 0 });
  });
});
