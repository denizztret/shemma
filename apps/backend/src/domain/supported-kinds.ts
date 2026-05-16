// Canonical whitelist supported node kinds (single source of truth).
// Frontend `to-patch.ts` / `from-canvas-state.ts` импортируют это для
// синхронной фильтрации; backend `applyPatch` валидирует input.
//
// Unsupported tldraw shapes (draw/line/image/video/embed/bookmark/highlight)
// are intentionally NOT serialised — fixing them would require schema-specific
// fields (points, assetId, etc.) and is roadmap'd for Phase 3.x custom shapes.
export const SUPPORTED_NODE_KINDS = [
  "rect",
  "ellipse",
  "diamond",
  "sticky",
  "text",
] as const;

export type SupportedNodeKind = (typeof SUPPORTED_NODE_KINDS)[number];

export function isSupportedNodeKind(kind: unknown): kind is SupportedNodeKind {
  return (
    typeof kind === "string" &&
    (SUPPORTED_NODE_KINDS as readonly string[]).includes(kind)
  );
}
