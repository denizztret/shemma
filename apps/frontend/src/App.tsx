import { useEffect, useState } from "react";
import { type Editor, type TLShape, Tldraw } from "tldraw";
import "tldraw/tldraw.css";
import { isOurOp, rememberOurOpId } from "./canvas/echo-guard";
import { nodeToShape } from "./canvas/from-canvas-state";
import { diffToOps } from "./canvas/to-patch";
import { AppChrome } from "./chrome/AppChrome";
import { buildTldrawComponents } from "./chrome/TldrawComponents";
import { getState, sendPatch } from "./transport/api";
import { openWs } from "./transport/ws";

export function App({ room }: { room: string }) {
  const [editor, setEditor] = useState<Editor | null>(null);

  useEffect(() => {
    if (!editor) return;
    let active = true;
    let close: (() => void) | undefined;
    let unsubStore: (() => void) | undefined;
    (async () => {
      const s = await getState();
      if (!active) return;
      const shapes = s.canvas.nodes.map(nodeToShape);
      if (shapes.length) editor.createShapes(shapes);
      close = openWs({
        onPatch: (m) => {
          if (isOurOp(m.originClientId)) return;
          for (const op of m.ops) {
            if (op.op === "add" && op.target === "node") {
              editor.createShapes([nodeToShape(op.value)]);
            } else if (op.op === "delete" && op.target === "node") {
              // biome-ignore lint/suspicious/noExplicitAny: tldraw shape ID branded type
              editor.deleteShapes([`shape:${op.id}` as any]);
            } else if (op.op === "update" && op.target === "node") {
              editor.updateShapes([
                {
                  // biome-ignore lint/suspicious/noExplicitAny: tldraw shape ID branded type
                  id: `shape:${op.id}` as any,
                  type: "geo",
                  x: op.set.x,
                  y: op.set.y,
                },
              ]);
            }
          }
        },
      });

      const snap = new Map<string, TLShape>(
        editor
          .getCurrentPageShapes()
          .map((s) => [s.id as unknown as string, s]),
      );
      unsubStore = editor.store.listen(
        () => {
          const cur = new Map<string, TLShape>(
            editor
              .getCurrentPageShapes()
              .map((s) => [s.id as unknown as string, s]),
          );
          const ops = diffToOps(snap, cur);
          snap.clear();
          for (const [k, v] of cur) snap.set(k, v);
          if (ops.length === 0) return;
          const cid = crypto.randomUUID();
          rememberOurOpId(cid);
          // biome-ignore lint/suspicious/noExplicitAny: SimpleOp is compatible with backend PatchOp schema
          void sendPatch(ops as any, cid);
        },
        { source: "user", scope: "document" },
      );
    })();
    return () => {
      active = false;
      close?.();
      unsubStore?.();
    };
  }, [editor]);

  return (
    <AppChrome banner={null} footer={null} floatingOverlays={null}>
      <Tldraw onMount={setEditor} components={buildTldrawComponents(room)} />
    </AppChrome>
  );
}
