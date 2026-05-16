import { describe, expect, test } from "bun:test";
import type { DomainAction } from "../../src/domain/types";
import { validateBatch } from "../../src/domain/validate";
import { emptyTLStore } from "../../src/rooms";
import { rebuildDidrawIndex } from "../../src/store-ops";
import type { TLStoreSnapshot } from "../../src/store-types";

function seedStore(
  ...defs: Array<{ name: string; role: string; isContainer?: boolean }>
): { store: TLStoreSnapshot; index: Map<string, string> } {
  const s = emptyTLStore();
  for (const d of defs) {
    const id = `shape:e_${d.name}`;
    s.store[id] = {
      id,
      typeName: "shape",
      type: d.isContainer ? "frame" : "geo",
      x: 0,
      y: 0,
      parentId: "page:page",
      index: "a1",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: { w: 100, h: 60 },
      meta: { didrawName: d.name, role: d.role },
    };
  }
  return { store: s, index: rebuildDidrawIndex(s) };
}

function empty(): { store: TLStoreSnapshot; index: Map<string, string> } {
  const store = emptyTLStore();
  return { store, index: rebuildDidrawIndex(store) };
}

describe("validateBatch", () => {
  test("happy path — define + connect referencing the just-defined name", () => {
    const acts: DomainAction[] = [
      { kind: "define", role: "service", name: "auth" },
      { kind: "define", role: "datastore", name: "users-db" },
      { kind: "connect", from: "auth", to: "users-db", connectionKind: "data" },
    ];
    const e = empty();
    const r = validateBatch(acts, e.store, e.index);
    expect(r.ok).toBe(true);
  });

  test("unknown role → unknown-role error", () => {
    const e = empty();
    const r = validateBatch(
      [{ kind: "define", role: "frobnicator" as never, name: "x" }],
      e.store,
      e.index,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.code).toBe("unknown-role");
      expect(r.errors[0]?.field).toBe("role");
    }
  });

  test("invalid name → invalid-shape error", () => {
    const e = empty();
    const r = validateBatch(
      [{ kind: "define", role: "service", name: "BAD NAME" }],
      e.store,
      e.index,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe("invalid-shape");
  });

  test("connect references unknown element → unknown-ref", () => {
    const c = seedStore({ name: "auth", role: "service" });
    const r = validateBatch(
      [{ kind: "connect", from: "nope", to: "auth" }],
      c.store,
      c.index,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.code).toBe("unknown-ref");
      expect(r.errors[0]?.field).toBe("from");
    }
  });

  test("upsert define keeps role → ok", () => {
    const c = seedStore({ name: "auth", role: "service" });
    const r = validateBatch(
      [{ kind: "define", role: "service", name: "auth" }],
      c.store,
      c.index,
    );
    expect(r.ok).toBe(true);
  });

  test("upsert define with different role → role-conflict", () => {
    const c = seedStore({ name: "auth", role: "service" });
    const r = validateBatch(
      [{ kind: "define", role: "datastore", name: "auth" }],
      c.store,
      c.index,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe("role-conflict");
  });

  test("group requires all ids to exist in canvas or earlier in batch", () => {
    const e = empty();
    const r = validateBatch(
      [
        { kind: "define", role: "service", name: "auth" },
        { kind: "group", ids: ["auth", "nope"], as: "network", name: "vpc" },
      ],
      e.store,
      e.index,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe("unknown-ref");
  });

  test("group as=actor → invalid-shape (only network/boundary allowed)", () => {
    const e = empty();
    const r = validateBatch(
      [{ kind: "group", ids: [], as: "actor" as never, name: "x" }],
      e.store,
      e.index,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe("invalid-shape");
  });

  test("unknown action kind → unknown-action", () => {
    const e = empty();
    const r = validateBatch(
      [{ kind: "splork" } as never],
      e.store,
      e.index,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe("unknown-action");
  });

  test("define container role rejected (must use group action)", () => {
    const e = empty();
    const r = validateBatch(
      [{ kind: "define", role: "network", name: "vpc" }],
      e.store,
      e.index,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.code).toBe("invalid-shape");
      expect(r.errors[0]?.message).toMatch(/container role/);
    }
  });

  test("define `in` referencing non-container → invalid-shape", () => {
    const c = seedStore({ name: "auth", role: "service" });
    const r = validateBatch(
      [{ kind: "define", role: "service", name: "child", in: "auth" }],
      c.store,
      c.index,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.code).toBe("invalid-shape");
      expect(r.errors[0]?.field).toBe("in");
    }
  });

  test("delete + connect referencing the deleted element → unknown-ref", () => {
    const c = seedStore(
      { name: "a", role: "service" },
      { name: "b", role: "service" },
    );
    const r = validateBatch(
      [
        { kind: "delete", id: "a" },
        { kind: "connect", from: "a", to: "b" },
      ],
      c.store,
      c.index,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.code).toBe("unknown-ref");
      expect(r.errors[0]?.field).toBe("from");
    }
  });
});
