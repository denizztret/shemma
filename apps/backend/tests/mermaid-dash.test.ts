import { describe, expect, it } from "bun:test";
import { mermaidDashToTldraw } from "../src/routes/schema";

describe("mermaidDashToTldraw", () => {
  it("undefined → undefined", () => {
    expect(mermaidDashToTldraw(undefined)).toBeUndefined();
  });

  it("empty string → undefined", () => {
    expect(mermaidDashToTldraw("")).toBeUndefined();
  });

  it('"0" → solid', () => {
    expect(mermaidDashToTldraw("0")).toBe("solid");
  });

  it('"none" → solid', () => {
    expect(mermaidDashToTldraw("none")).toBe("solid");
  });

  it('"5,5" → dashed', () => {
    expect(mermaidDashToTldraw("5,5")).toBe("dashed");
  });

  it('"8 4" → dashed', () => {
    expect(mermaidDashToTldraw("8 4")).toBe("dashed");
  });

  it('"1,4" → dotted', () => {
    expect(mermaidDashToTldraw("1,4")).toBe("dotted");
  });

  it('"2,2" → dotted', () => {
    expect(mermaidDashToTldraw("2,2")).toBe("dotted");
  });

  it('"10" → dashed (single value, treat as dash length)', () => {
    expect(mermaidDashToTldraw("10")).toBe("dashed");
  });
});
