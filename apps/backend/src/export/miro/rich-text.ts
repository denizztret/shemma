/**
 * Flatten a ProseMirror doc → plain string.
 * Each top-level block becomes one line. Returns "" on malformed input (never throws).
 * Rich formatting (bold, links) is intentionally lost — Miro accepts plain text only.
 */
export function richTextToPlain(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const root = doc as { content?: unknown };
  if (!Array.isArray(root.content)) return "";

  const lines: string[] = [];
  for (const block of root.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { content?: unknown };
    if (!Array.isArray(b.content)) continue;
    const parts: string[] = [];
    for (const node of b.content) {
      if (!node || typeof node !== "object") continue;
      const n = node as { text?: unknown };
      if (typeof n.text === "string") parts.push(n.text);
    }
    lines.push(parts.join(""));
  }
  return lines.join("\n").trim();
}
