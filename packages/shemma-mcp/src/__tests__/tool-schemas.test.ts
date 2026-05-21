/**
 * DRW-116 Task 26: Every MCP tool that operates on a room accepts an optional
 * `space` arg. The space-resolver consumes it inside the handler; this test
 * verifies the SCHEMA accepts both shapes (with and without `space`) and
 * rejects garbage (number, object).
 *
 * Server-level tools (`shemma_health`, `shemma_version`, `shemma_rooms_list`,
 * `shemma_active_rooms`, `shemma_get_instructions`) are intentionally NOT
 * covered here — they don't operate on a room and don't take `space`.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  CommonWriteArgs,
  DefineArgs,
  ConnectArgs,
  GroupArgs,
  NoteArgs,
  LayoutArgs,
  DeleteArgs,
  ApplyArgs,
  LayoutSelectionArgs,
  ImportMermaidArgs,
  ExportMiroArgs,
} from "../schemas";

describe("DRW-116 Task 26 — write tool schemas accept optional space", () => {
  it("CommonWriteArgs includes optional space", () => {
    const schema = z.object(CommonWriteArgs);
    expect(schema.parse({}).space).toBeUndefined();
    expect(schema.parse({ space: "my-project" }).space).toBe("my-project");
  });

  const writeCases: Array<[string, z.ZodRawShape, Record<string, unknown>]> = [
    ["DefineArgs", DefineArgs, { name: "svc", role: "service" }],
    [
      "ConnectArgs",
      ConnectArgs,
      { from: "a", to: "b", connectionKind: "sync" },
    ],
    ["GroupArgs", GroupArgs, { name: "g", children: ["a"] }],
    ["NoteArgs", NoteArgs, { name: "n", text: "hello" }],
    ["LayoutArgs", LayoutArgs, {}],
    ["DeleteArgs", DeleteArgs, { ids: ["x"] }],
    ["ApplyArgs", ApplyArgs, { actions: [{ kind: "define", name: "a", role: "service" }] }],
  ];

  for (const [name, shape, baseInput] of writeCases) {
    it(`${name} accepts space:undefined`, () => {
      const schema = z.object(shape);
      const r = schema.parse(baseInput);
      expect((r as { space?: string }).space).toBeUndefined();
    });

    it(`${name} accepts space:"explicit-id"`, () => {
      const schema = z.object(shape);
      const r = schema.parse({ ...baseInput, space: "my-project" });
      expect((r as { space?: string }).space).toBe("my-project");
    });

    it(`${name} rejects non-string space`, () => {
      const schema = z.object(shape);
      expect(() => schema.parse({ ...baseInput, space: 42 })).toThrow();
    });
  }
});

describe("DRW-116 Task 26 — non-CommonWriteArgs tools accept optional space", () => {
  it("LayoutSelectionArgs accepts optional space", () => {
    const schema = z.object(LayoutSelectionArgs);
    expect(schema.parse({}).space).toBeUndefined();
    expect(schema.parse({ space: "p" }).space).toBe("p");
  });

  it("ImportMermaidArgs accepts optional space", () => {
    const schema = z.object(ImportMermaidArgs);
    expect(schema.parse({ source: "graph LR; A-->B" }).space).toBeUndefined();
    expect(schema.parse({ source: "graph LR; A-->B", space: "p" }).space).toBe("p");
  });

  it("ExportMiroArgs accepts optional space", () => {
    const schema = z.object(ExportMiroArgs);
    expect(schema.parse({}).space).toBeUndefined();
    expect(schema.parse({ space: "p" }).space).toBe("p");
  });
});
