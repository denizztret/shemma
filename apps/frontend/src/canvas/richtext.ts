type RichTextDoc = {
  type: "doc";
  content: Array<{
    type: "paragraph";
    content?: Array<{ type: "text"; text: string }>;
  }>;
};

export function labelToRichText(label?: string): RichTextDoc {
  if (!label) return { type: "doc", content: [{ type: "paragraph" }] };
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: label }] }],
  };
}

export function richTextToString(rt: unknown): string {
  if (!rt || typeof rt !== "object") return "";
  const doc = rt as { content?: Array<{ content?: Array<{ text?: string }> }> };
  return doc.content?.[0]?.content?.[0]?.text ?? "";
}
