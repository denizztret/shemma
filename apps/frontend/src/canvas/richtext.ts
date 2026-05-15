type RichTextDoc = {
  type: "doc";
  content: Array<{
    type: "paragraph";
    content?: Array<{ type: "text"; text: string }>;
  }>;
};

// ProseMirror represents line breaks as separate paragraph nodes, not "\n" inside text.
export function labelToRichText(label?: string): RichTextDoc {
  if (!label) return { type: "doc", content: [{ type: "paragraph" }] };
  return {
    type: "doc",
    content: label.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : undefined,
    })),
  };
}

export function richTextToString(rt: unknown): string {
  if (!rt || typeof rt !== "object") return "";
  const doc = rt as { content?: Array<{ content?: Array<{ text?: string }> }> };
  return doc.content?.map((p) => p.content?.[0]?.text ?? "").join("\n") ?? "";
}
