import { describe, expect, it } from "bun:test";
import { richTextToPlain } from "./rich-text";

describe("richTextToPlain", () => {
  it("simple paragraph: extracts text", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
      ],
    };
    expect(richTextToPlain(doc)).toBe("Hello");
  });

  it("multi-paragraph: joined with newlines", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First" }] },
        { type: "paragraph", content: [{ type: "text", text: "Second" }] },
      ],
    };
    expect(richTextToPlain(doc)).toBe("First\nSecond");
  });

  it("paragraph with multiple text nodes: concatenated within line", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello, " },
            { type: "text", text: "world!" },
          ],
        },
      ],
    };
    expect(richTextToPlain(doc)).toBe("Hello, world!");
  });

  it("heading + paragraph: joined with newline", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "Title" }] },
        { type: "paragraph", content: [{ type: "text", text: "Body" }] },
      ],
    };
    expect(richTextToPlain(doc)).toBe("Title\nBody");
  });

  it("empty doc: returns empty string", () => {
    expect(richTextToPlain({ type: "doc", content: [] })).toBe("");
  });

  it("null input: returns empty string", () => {
    expect(richTextToPlain(null)).toBe("");
  });

  it("undefined input: returns empty string", () => {
    expect(richTextToPlain(undefined)).toBe("");
  });

  it("non-object input: returns empty string", () => {
    expect(richTextToPlain("plain")).toBe("");
    expect(richTextToPlain(42)).toBe("");
  });

  it("trims surrounding whitespace", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "  spaced  " }] },
      ],
    };
    expect(richTextToPlain(doc)).toBe("spaced");
  });

  it("ignores nodes without text field", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Visible" },
            { type: "hard_break" },
          ],
        },
      ],
    };
    expect(richTextToPlain(doc)).toBe("Visible");
  });
});
