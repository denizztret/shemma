import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MERMAID_ENGINE,
  MERMAID_ENGINE_OPTIONS,
} from "./MermaidImportModal";

describe("MermaidImportModal — engine options", () => {
  test("exposes exactly dagre, elk, custom", () => {
    const values = MERMAID_ENGINE_OPTIONS.map((o) => o.value).sort();
    expect(values).toEqual(["custom", "dagre", "elk"]);
  });

  test("default engine is custom (existing flow unchanged)", () => {
    expect(DEFAULT_MERMAID_ENGINE).toBe("custom");
  });

  test("every option has a non-empty label", () => {
    for (const o of MERMAID_ENGINE_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(0);
    }
  });
});
