import { describe, expect, it } from "bun:test";
import {
  deriveUnifiedStyleState,
  type StyleStateInput,
} from "./derive-unified-style-state";

describe("deriveUnifiedStyleState", () => {
  it("returns nulls for empty selection", () => {
    expect(deriveUnifiedStyleState([])).toEqual({
      dash: null,
      font: null,
      size: null,
    });
  });

  it("unified state when all shapes match", () => {
    const input: StyleStateInput[] = [
      { type: "geo", props: { dash: "solid", font: "sans", size: "m" } },
      { type: "geo", props: { dash: "solid", font: "sans", size: "m" } },
    ];
    expect(deriveUnifiedStyleState(input)).toEqual({
      dash: "solid",
      font: "sans",
      size: "m",
    });
  });

  it("indeterminate when mixed", () => {
    const input: StyleStateInput[] = [
      { type: "geo", props: { dash: "solid", font: "sans", size: "m" } },
      { type: "geo", props: { dash: "draw", font: "sans", size: "m" } },
    ];
    const out = deriveUnifiedStyleState(input);
    expect(out.dash).toBeNull();
    expect(out.font).toBe("sans");
    expect(out.size).toBe("m");
  });

  it("excludes dashed/dotted from dash computation but includes for font/size", () => {
    const input: StyleStateInput[] = [
      { type: "geo", props: { dash: "dashed", font: "sans", size: "m" } },
      { type: "geo", props: { dash: "solid", font: "sans", size: "m" } },
    ];
    const out = deriveUnifiedStyleState(input);
    expect(out.dash).toBe("solid");
    expect(out.font).toBe("sans");
  });

  it("skips frame/schema-container for font, size, but includes container for dash", () => {
    const input: StyleStateInput[] = [
      { type: "frame", props: { font: "sans" } },
      { type: "schema-container", props: { dash: "solid", font: "draw" } },
    ];
    const out = deriveUnifiedStyleState(input);
    expect(out.dash).toBe("solid");
    expect(out.font).toBeNull();
  });
});
