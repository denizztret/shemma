import { type Editor, type TLShape, renderPlaintextFromRichText } from "tldraw";
import { fromShapeId } from "./id-prefix";
import type { NodeValue, SimpleOp } from "./to-patch";

type EdgeOp = {
  op: "add";
  target: "edge";
  value: {
    id: string;
    from: { kind: "node"; id: string };
    to: { kind: "node"; id: string };
    label?: string;
  };
};

/** Full op type produced by mermaid import (nodes + edges). */
export type MermaidOp = SimpleOp | EdgeOp;

// Lazy-load @tldraw/mermaid because it pulls in mermaid + heavy deps; only paid when user actually imports.
async function loadMermaid() {
  return await import("@tldraw/mermaid");
}

function readLabel(editor: Editor, s: TLShape): string | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props are not typed via public API
  const rt = (s as any).props?.richText;
  if (!rt) return undefined;
  const text = renderPlaintextFromRichText(editor, rt);
  return text || undefined;
}

function shapeToNodeValue(editor: Editor, s: TLShape): NodeValue | null {
  if (s.type === "geo") {
    // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props are not typed via public API
    const p = (s as any).props ?? {};
    return {
      id: fromShapeId(s.id),
      kind: "rect",
      x: s.x,
      y: s.y,
      w: p.w,
      h: p.h,
      label: readLabel(editor, s),
    };
  }
  if (s.type === "note") {
    return {
      id: fromShapeId(s.id),
      kind: "sticky",
      x: s.x,
      y: s.y,
      label: readLabel(editor, s) ?? "",
    };
  }
  if (s.type === "text") {
    return {
      id: fromShapeId(s.id),
      kind: "text",
      x: s.x,
      y: s.y,
      label: readLabel(editor, s) ?? "",
    };
  }
  if (s.type === "line" || s.type === "draw") {
    return { id: fromShapeId(s.id), kind: "freeform", x: s.x, y: s.y };
  }
  return null;
}

/**
 * Convert Mermaid source to patch ops for the di.draw backend.
 * Requires the live tldraw Editor (DOM-mounted) for createMermaidDiagram's layout pass.
 *
 * createMermaidDiagram adds shapes directly to the editor store (does not return a value).
 * We snapshot shape IDs before/after to derive the new ops.
 * Arrow connections are read via editor.getBindingsFromShape() (tldraw 5.x bindings API).
 *
 * Throws if the source is invalid Mermaid.
 */
export async function mermaidToOps(
  editor: Editor,
  source: string,
): Promise<MermaidOp[]> {
  const mod = await loadMermaid();
  // tldraw 5.x: createMermaidDiagram(editor, text, options?) — mutates editor store directly
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import; createMermaidDiagram is not in our typings
  const mermaidMod = mod as any;

  // Snapshot existing shapes before import
  const before = new Set(
    editor.getCurrentPageShapes().map((s) => s.id as string),
  );

  // createMermaidDiagram mutates editor store; throws MermaidDiagramError on invalid input
  await mermaidMod.createMermaidDiagram(editor, source);

  // Collect newly added shapes
  const after = editor.getCurrentPageShapes();
  const newShapes = after.filter((s) => !before.has(s.id as string));

  if (newShapes.length === 0) throw new Error("mermaid produced no shapes");

  const ops: MermaidOp[] = [];
  for (const s of newShapes) {
    if (s.type === "arrow") {
      // tldraw 5.x: arrow connections are stored as bindings, not in props
      // biome-ignore lint/suspicious/noExplicitAny: binding record shape varies by diagram type
      const bindings = editor.getBindingsFromShape(s, "arrow") as any[];
      const startBinding = bindings.find((b) => b.props?.terminal === "start");
      const endBinding = bindings.find((b) => b.props?.terminal === "end");

      const fromId = startBinding
        ? fromShapeId(startBinding.toId)
        : `${fromShapeId(s.id)}-from`;
      const toId = endBinding
        ? fromShapeId(endBinding.toId)
        : `${fromShapeId(s.id)}-to`;

      // biome-ignore lint/suspicious/noExplicitAny: tldraw arrow props are not typed via public API
      const label = (s as any).props?.text || undefined;

      ops.push({
        op: "add",
        target: "edge",
        value: {
          id: fromShapeId(s.id),
          from: { kind: "node", id: fromId },
          to: { kind: "node", id: toId },
          label,
        },
      });
      continue;
    }
    const nodeVal = shapeToNodeValue(editor, s);
    if (nodeVal) {
      ops.push({ op: "add", target: "node", value: nodeVal });
    }
  }

  return ops;
}
