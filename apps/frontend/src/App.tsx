import { useEffect, useState } from "react";
import {
  type Editor,
  type TLShape,
  Tldraw,
  TldrawUiOrientationProvider,
} from "tldraw";
import "tldraw/tldraw.css";
import { isOurOp, rememberOurOpId } from "./canvas/echo-guard";
import { edgeToShape, nodeToShape } from "./canvas/from-canvas-state";
import { fromShapeId, toEdgeShapeId, toShapeId } from "./canvas/id-prefix";
import { mermaidToOps } from "./canvas/mermaid-import";
import { labelToRichText } from "./canvas/richtext";
import { diffToOps } from "./canvas/to-patch";
import { AppChrome } from "./chrome/AppChrome";
import { buildTldrawComponents } from "./chrome/TldrawComponents";
import { UpdateBanner } from "./chrome/UpdateBanner";
import { VersionFooter } from "./chrome/VersionFooter";
import { PromptDrawer } from "./prompts/PromptDrawer";
import { PromptInput } from "./prompts/PromptInput";
import { getState, sendPatch } from "./transport/api";
import { openWs } from "./transport/ws";

export function App({ room }: { room: string }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [promptsTick, setPromptsTick] = useState(0);
  const [cameraTick, setCameraTick] = useState(0);

  useEffect(() => {
    if (!editor) return;
    let active = true;
    let close: (() => void) | undefined;
    let unsubStore: (() => void) | undefined;
    let unsubSel: (() => void) | undefined;
    (async () => {
      const s = await getState();
      if (!active) return;
      const nodeShapes = s.canvas.nodes.map(nodeToShape);
      const edgeData: ReturnType<typeof edgeToShape>[] =
        s.canvas.edges.map(edgeToShape);
      const allShapes = [...nodeShapes, ...edgeData.map((d) => d.shape)];
      const allBindings = edgeData.flatMap((d) => d.bindings);
      if (allShapes.length) editor.createShapes(allShapes);
      if (allBindings.length) editor.createBindings(allBindings);
      // Fit camera to existing content so room with content opens centred, not blank.
      if (allShapes.length) editor.zoomToFit({ animation: { duration: 0 } });
      close = openWs({
        onPromptCreated: () => setPromptsTick((x) => x + 1),
        onPromptResolved: () => setPromptsTick((x) => x + 1),
        onPatch: (m) => {
          if (isOurOp(m.originClientId)) return;
          for (const op of m.ops) {
            if (op.op === "add" && op.target === "node") {
              editor.createShapes([nodeToShape(op.value)]);
            } else if (op.op === "add" && op.target === "edge") {
              const { shape, bindings } = edgeToShape(op.value);
              editor.createShapes([shape]);
              if (bindings.length) editor.createBindings(bindings);
            } else if (op.op === "delete" && op.target === "node") {
              editor.deleteShapes([toShapeId(op.id)]);
            } else if (op.op === "delete" && op.target === "edge") {
              editor.deleteShapes([toEdgeShapeId(op.id)]);
            } else if (op.op === "update" && op.target === "node") {
              const sid = toShapeId(op.id);
              const existing = editor.getShape(sid);
              if (!existing) continue;
              // Build update payload with the shape's actual type so non-geo shapes update too.
              const updates: Record<string, unknown> = {};
              if (op.set.x !== undefined) updates.x = op.set.x;
              if (op.set.y !== undefined) updates.y = op.set.y;
              if (op.set.label !== undefined) {
                updates.props = { richText: labelToRichText(op.set.label) };
              }
              if (Object.keys(updates).length > 0) {
                editor.updateShapes([
                  // biome-ignore lint/suspicious/noExplicitAny: tldraw updateShapes expects shape-specific type literal
                  { id: sid, type: existing.type, ...updates } as any,
                ]);
              }
            }
          }
        },
      });

      const snap = new Map<string, TLShape>(
        editor
          .getCurrentPageShapes()
          .map((s) => [s.id as unknown as string, s]),
      );
      let inflight = false;
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
          if (ops.length === 0 || inflight) return;
          inflight = true;
          const cid = crypto.randomUUID();
          rememberOurOpId(cid);
          // biome-ignore lint/suspicious/noExplicitAny: SimpleOp is compatible with backend PatchOp schema
          void sendPatch(ops as any, cid).finally(() => {
            inflight = false;
          });
        },
        { source: "user", scope: "document" },
      );

      // Selection + camera listener: fires on any user interaction (including pan/zoom).
      // Both selection and cameraTick are updated so PromptInput always re-anchors correctly.
      unsubSel = editor.store.listen(
        () => {
          const ids = editor.getSelectedShapeIds().map((id) => fromShapeId(id));
          setSelection(ids);
          setCameraTick((x) => x + 1);
        },
        { source: "user", scope: "session" },
      );

      // biome-ignore lint/suspicious/noExplicitAny: attaching helper to window for AI/dev console use
      (window as any).didrawImportMermaid = async (source: string) => {
        const ops = await mermaidToOps(editor, source);
        if (ops.length === 0) return { ok: false, error: "no ops produced" };
        const cid = crypto.randomUUID();
        rememberOurOpId(cid);
        // biome-ignore lint/suspicious/noExplicitAny: MermaidOp is compatible with backend PatchOp schema
        return await sendPatch(ops as any, cid);
      };
    })();
    return () => {
      active = false;
      close?.();
      unsubStore?.();
      unsubSel?.();
      // biome-ignore lint/suspicious/noExplicitAny: cleaning up window helper
      // biome-ignore lint/performance/noDelete: intentional property removal from window
      delete (window as any).didrawImportMermaid;
    };
  }, [editor]);

  return (
    <AppChrome
      banner={<UpdateBanner />}
      footer={<VersionFooter />}
      floatingOverlays={
        <>
          {editor && (
            <PromptInput
              editor={editor}
              selection={selection}
              cameraTick={cameraTick}
            />
          )}
          <PromptDrawer tick={promptsTick} />
        </>
      }
    >
      <TldrawUiOrientationProvider orientation="vertical" tooltipSide="right">
        <Tldraw onMount={setEditor} components={buildTldrawComponents(room)} />
      </TldrawUiOrientationProvider>
    </AppChrome>
  );
}
