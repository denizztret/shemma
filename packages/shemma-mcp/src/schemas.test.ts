import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  ConnectionKindEnum, LayoutModeEnum, RoleEnum, SpacingEnum,
  DefineArgs, ConnectArgs, GroupArgs, NoteArgs,
  LayoutArgs, DeleteArgs, ApplyArgs,
  ImportMermaidArgs,
} from "./schemas";
import { ALL_ROLES, ALL_KINDS, ALL_MODES } from "@shemma/domain";

describe("schemas — enum coverage", () => {
  it("RoleEnum accepts every ALL_ROLES value", () => {
    for (const r of ALL_ROLES) expect(RoleEnum.safeParse(r).success).toBe(true);
  });

  it("RoleEnum rejects unknown role", () => {
    expect(RoleEnum.safeParse("not-a-role").success).toBe(false);
  });

  it("ConnectionKindEnum matches ALL_KINDS", () => {
    for (const k of ALL_KINDS) expect(ConnectionKindEnum.safeParse(k).success).toBe(true);
    expect(ConnectionKindEnum.safeParse("xyz").success).toBe(false);
  });

  it("LayoutModeEnum matches ALL_MODES", () => {
    for (const m of ALL_MODES) expect(LayoutModeEnum.safeParse(m).success).toBe(true);
  });

  it("SpacingEnum accepts compact|normal|loose", () => {
    for (const s of ["compact", "normal", "loose"]) {
      expect(SpacingEnum.safeParse(s).success).toBe(true);
    }
  });
});

describe("schemas — DefineArgs", () => {
  it("validates minimum DefineArgs", () => {
    const parsed = z.object(DefineArgs).safeParse({ name: "x", role: "service" });
    expect(parsed.success).toBe(true);
  });

  it("rejects DefineArgs missing required name", () => {
    const parsed = z.object(DefineArgs).safeParse({ role: "service" });
    expect(parsed.success).toBe(false);
  });

  it("rejects DefineArgs with unknown role", () => {
    const parsed = z.object(DefineArgs).safeParse({ name: "x", role: "wat" });
    expect(parsed.success).toBe(false);
  });
});

describe("schemas — ApplyArgs", () => {
  it("requires non-empty actions array", () => {
    expect(z.object(ApplyArgs).safeParse({ actions: [] }).success).toBe(false);
    expect(z.object(ApplyArgs).safeParse({ actions: [{ kind: "define" }] }).success).toBe(true);
  });
});

describe("schemas — ImportMermaidArgs", () => {
  it("validates minimum ImportMermaidArgs (source only)", () => {
    const parsed = z.object(ImportMermaidArgs).safeParse({ source: "graph LR; A-->B" });
    expect(parsed.success).toBe(true);
  });

  it("rejects ImportMermaidArgs with empty source", () => {
    const parsed = z.object(ImportMermaidArgs).safeParse({ source: "" });
    expect(parsed.success).toBe(false);
  });

  it("rejects ImportMermaidArgs missing source", () => {
    const parsed = z.object(ImportMermaidArgs).safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("accepts mode='append'", () => {
    const parsed = z.object(ImportMermaidArgs).safeParse({ source: "graph LR; A-->B", mode: "append" });
    expect(parsed.success).toBe(true);
  });

  it("accepts mode='replace'", () => {
    const parsed = z.object(ImportMermaidArgs).safeParse({ source: "graph LR; A-->B", mode: "replace" });
    expect(parsed.success).toBe(true);
  });

  it("rejects invalid mode", () => {
    const parsed = z.object(ImportMermaidArgs).safeParse({ source: "graph LR; A-->B", mode: "overwrite" });
    expect(parsed.success).toBe(false);
  });

  it("accepts optional room and clientOpId", () => {
    const parsed = z.object(ImportMermaidArgs).safeParse({
      source: "graph LR; A-->B",
      room: "my-room",
      clientOpId: "op-123",
    });
    expect(parsed.success).toBe(true);
  });
});
