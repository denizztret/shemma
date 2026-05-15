import { describe, expect, test } from "bun:test";
import { emptyCanvasState } from "../../src/rooms";
import { validateBatch } from "../../src/domain/validate";
import type { DomainAction } from "../../src/domain/types";

function seedCanvas(...defs: Array<{ name: string; role: string }>) {
  const c = emptyCanvasState();
  for (const d of defs) {
    c.nodes.push({
      id: `shape:e_${d.name}`,
      kind: "rect",
      x: 0,
      y: 0,
      label: d.name,
      meta: { name: d.name, role: d.role },
    });
  }
  return c;
}

describe("validateBatch", () => {
  test("happy path — define + connect referencing the just-defined name", () => {
    const acts: DomainAction[] = [
      { kind: "define", role: "service", name: "auth" },
      { kind: "define", role: "datastore", name: "users-db" },
      { kind: "connect", from: "auth", to: "users-db", connectionKind: "data" },
    ];
    const r = validateBatch(acts, emptyCanvasState());
    expect(r.ok).toBe(true);
  });

  test("unknown role → unknown-role error", () => {
    const r = validateBatch(
      [{ kind: "define", role: "frobnicator" as never, name: "x" }],
      emptyCanvasState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].code).toBe("unknown-role");
      expect(r.errors[0].field).toBe("role");
    }
  });

  test("invalid name → invalid-shape error", () => {
    const r = validateBatch(
      [{ kind: "define", role: "service", name: "BAD NAME" }],
      emptyCanvasState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe("invalid-shape");
  });

  test("connect references unknown element → unknown-ref", () => {
    const r = validateBatch(
      [{ kind: "connect", from: "nope", to: "auth" }],
      seedCanvas({ name: "auth", role: "service" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].code).toBe("unknown-ref");
      expect(r.errors[0].field).toBe("from");
    }
  });

  test("upsert define keeps role → ok", () => {
    const r = validateBatch(
      [{ kind: "define", role: "service", name: "auth" }],
      seedCanvas({ name: "auth", role: "service" }),
    );
    expect(r.ok).toBe(true);
  });

  test("upsert define with different role → role-conflict", () => {
    const r = validateBatch(
      [{ kind: "define", role: "datastore", name: "auth" }],
      seedCanvas({ name: "auth", role: "service" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe("role-conflict");
  });

  test("group requires all ids to exist in canvas or earlier in batch", () => {
    const r = validateBatch(
      [
        { kind: "define", role: "service", name: "auth" },
        { kind: "group", ids: ["auth", "nope"], as: "network", name: "vpc" },
      ],
      emptyCanvasState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe("unknown-ref");
  });

  test("group as=actor → invalid-shape (only network/boundary allowed)", () => {
    const r = validateBatch(
      [{ kind: "group", ids: [], as: "actor" as never, name: "x" }],
      emptyCanvasState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe("invalid-shape");
  });

  test("unknown action kind → unknown-action", () => {
    const r = validateBatch(
      [{ kind: "splork" } as never],
      emptyCanvasState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe("unknown-action");
  });

  test("define container role rejected (must use group action)", () => {
    const r = validateBatch(
      [{ kind: "define", role: "network", name: "vpc" }],
      emptyCanvasState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].code).toBe("invalid-shape");
      expect(r.errors[0].message).toMatch(/container role/);
    }
  });

  test("define `in` referencing non-container → invalid-shape", () => {
    const c = seedCanvas({ name: "auth", role: "service" });
    const r = validateBatch(
      [{ kind: "define", role: "service", name: "child", in: "auth" }],
      c,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].code).toBe("invalid-shape");
      expect(r.errors[0].field).toBe("in");
    }
  });

  test("delete + connect referencing the deleted element → unknown-ref", () => {
    const c = seedCanvas(
      { name: "a", role: "service" },
      { name: "b", role: "service" },
    );
    const r = validateBatch(
      [
        { kind: "delete", id: "a" },
        { kind: "connect", from: "a", to: "b" },
      ],
      c,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].code).toBe("unknown-ref");
      expect(r.errors[0].field).toBe("from");
    }
  });
});
