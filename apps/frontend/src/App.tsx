import { useEffect, useState } from "react";
import { type Editor, type TLShape, type TLShapeId, Tldraw } from "tldraw";
import "tldraw/tldraw.css";
import { loadCamera, saveCamera } from "./canvas/camera-persist";
import { isOurOp, rememberOurOpId } from "./canvas/echo-guard";
import { edgeToShape, nodeToShape } from "./canvas/from-canvas-state";
import { fromShapeId, toEdgeShapeId, toShapeId } from "./canvas/id-prefix";
import { mermaidToOps } from "./canvas/mermaid-import";
import { labelToRichText } from "./canvas/richtext";
import { diffToOps } from "./canvas/to-patch";
import { AppChrome } from "./chrome/AppChrome";
import { buildTldrawComponents } from "./chrome/TldrawComponents";
import { UpdateBanner } from "./chrome/UpdateBanner";
import { PromptDrawer } from "./prompts/PromptDrawer";
import { PromptInput } from "./prompts/PromptInput";
import { getState, sendPatch } from "./transport/api";
import { openWs } from "./transport/ws";

export function App({ room }: { room: string }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [promptsTick, setPromptsTick] = useState(0);
  const [cameraTick, setCameraTick] = useState(0);
  // PromptInput is toggled by ⌘K (Ctrl+K on non-Mac) — opens for the current
  // selection and stays open until Send/Esc/selection cleared. Holding a
  // modifier was the previous design but conflicted with tldraw drag tools.
  const [promptOpen, setPromptOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPromptOpen((v) => !v);
      } else if (e.key === "Escape") {
        setPromptOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Close the prompt input when selection is cleared so it doesn't dangle
  // anchored to nothing.
  useEffect(() => {
    if (selection.length === 0) setPromptOpen(false);
  }, [selection.length]);

  useEffect(() => {
    if (!editor) return;
    let active = true;
    let close: (() => void) | undefined;
    let unsubStore: (() => void) | undefined;
    let unsubSel: (() => void) | undefined;
    let camSaveTimer: ReturnType<typeof setTimeout> | undefined;
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
      const cam = loadCamera(room);
      if (cam) {
        editor.setCamera(cam, { immediate: true });
      } else if (allShapes.length) {
        // First visit: fit to content so the room doesn't open blank.
        editor.zoomToFit({ animation: { duration: 0 } });
      }
      close = openWs({
        onPromptCreated: () => setPromptsTick((x) => x + 1),
        onPromptResolved: () => setPromptsTick((x) => x + 1),
        onPatch: (m) => {
          if (isOurOp(m.originClientId)) return;
          const newNodeIds: TLShapeId[] = [];
          // mergeRemoteChanges marks the inner mutations as `source: "remote"`
          // so our `source: "user"` listener below doesn't echo them back to
          // the server (per tldraw collaboration docs).
          editor.store.mergeRemoteChanges(() => {
            for (const op of m.ops) {
              if (op.op === "add" && op.target === "node") {
                editor.createShapes([nodeToShape(op.value)]);
                newNodeIds.push(toShapeId(op.value.id));
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
                const updates: Record<string, unknown> = {};
                if (op.set.x !== undefined) updates.x = op.set.x;
                if (op.set.y !== undefined) updates.y = op.set.y;
                const propsPatch: Record<string, unknown> = {};
                if (op.set.w !== undefined) propsPatch.w = op.set.w;
                if (op.set.h !== undefined) propsPatch.h = op.set.h;
                if (op.set.label !== undefined) {
                  propsPatch.richText = labelToRichText(op.set.label);
                }
                if (Object.keys(propsPatch).length > 0) {
                  updates.props = propsPatch;
                }
                if (Object.keys(updates).length > 0) {
                  editor.updateShapes([
                    // biome-ignore lint/suspicious/noExplicitAny: tldraw updateShapes expects shape-specific type literal
                    { id: sid, type: existing.type, ...updates } as any,
                  ]);
                }
              }
            }
          });
          // Centre the camera on what the AI just added so the user sees the
          // change without hunting for it. We compute the union bounds of the
          // new shapes and zoom to those — not zoomToFit() over the whole
          // canvas, which would also include unrelated old content.
          if (newNodeIds.length > 0) {
            let minX = Number.POSITIVE_INFINITY;
            let minY = Number.POSITIVE_INFINITY;
            let maxX = Number.NEGATIVE_INFINITY;
            let maxY = Number.NEGATIVE_INFINITY;
            for (const id of newNodeIds) {
              const b = editor.getShapePageBounds(id);
              if (!b) continue;
              if (b.x < minX) minX = b.x;
              if (b.y < minY) minY = b.y;
              if (b.x + b.w > maxX) maxX = b.x + b.w;
              if (b.y + b.h > maxY) maxY = b.y + b.h;
            }
            if (minX < maxX) {
              const padding = 80;
              editor.zoomToBounds(
                {
                  x: minX - padding,
                  y: minY - padding,
                  w: maxX - minX + padding * 2,
                  h: maxY - minY + padding * 2,
                },
                { animation: { duration: 300 } },
              );
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
      // Skip listener-driven send during programmatic mass-imports (mermaid).
      // The importer issues its own explicit sendPatch with deduplicated ops.
      let suppressLocalSend = false;
      const trySend = () => {
        if (inflight || suppressLocalSend) return;
        const cur = new Map<string, TLShape>(
          editor
            .getCurrentPageShapes()
            .map((s) => [s.id as unknown as string, s]),
        );
        const ops = diffToOps(snap, cur);
        if (ops.length === 0) return;
        inflight = true;
        const cid = crypto.randomUUID();
        rememberOurOpId(cid);
        // biome-ignore lint/suspicious/noExplicitAny: SimpleOp is compatible with backend PatchOp schema
        void sendPatch(ops as any, cid).finally(() => {
          // Snap moves to what we just sent. Diffs after this are relative to
          // that baseline, so changes made during the in-flight window are
          // captured by the next trySend below.
          snap.clear();
          for (const [k, v] of cur) snap.set(k, v);
          inflight = false;
          trySend();
        });
      };
      unsubStore = editor.store.listen(trySend, {
        source: "user",
        scope: "document",
      });

      // Session-scope listener fires on every user interaction. Guard the
      // PromptInput re-anchor against camera-only no-op ticks (pan emits one
      // event per pointer move ≈ 60 Hz; without the guard React re-renders
      // every frame).
      let lastCamKey = "";
      unsubSel = editor.store.listen(
        () => {
          const ids = editor.getSelectedShapeIds().map((id) => fromShapeId(id));
          setSelection(ids);
          const cam = editor.getCamera();
          const camKey = `${cam.x}|${cam.y}|${cam.z}`;
          if (camKey !== lastCamKey) {
            lastCamKey = camKey;
            setCameraTick((x) => x + 1);
            if (camSaveTimer) clearTimeout(camSaveTimer);
            camSaveTimer = setTimeout(() => saveCamera(room, cam), 150);
          }
        },
        { source: "user", scope: "session" },
      );

      // biome-ignore lint/suspicious/noExplicitAny: attaching helper to window for AI/dev console use
      (window as any).didrawImportMermaid = async (source: string) => {
        // mermaidToOps mutates the editor store while extracting ops. Suppress
        // the local-send path so the listener does not also send those shapes;
        // we then explicitly sendPatch the deduplicated ops ourselves.
        suppressLocalSend = true;
        let ops: Awaited<ReturnType<typeof mermaidToOps>>;
        try {
          ops = await mermaidToOps(editor, source);
        } finally {
          // Re-baseline snap to the post-import state so the next user change
          // diffs cleanly without re-emitting the imported shapes.
          snap.clear();
          for (const s of editor.getCurrentPageShapes()) {
            snap.set(s.id as unknown as string, s);
          }
          suppressLocalSend = false;
        }
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
      if (camSaveTimer) {
        // Pending debounced save — flush now so reload keeps the latest camera.
        clearTimeout(camSaveTimer);
        if (editor) saveCamera(room, editor.getCamera());
      }
      // biome-ignore lint/suspicious/noExplicitAny: cleaning up window helper
      // biome-ignore lint/performance/noDelete: intentional property removal from window
      delete (window as any).didrawImportMermaid;
    };
  }, [editor, room]);

  return (
    <AppChrome
      banner={<UpdateBanner />}
      floatingOverlays={
        <>
          {editor && (
            <PromptInput
              editor={editor}
              selection={selection}
              cameraTick={cameraTick}
              visible={promptOpen}
              onClose={() => setPromptOpen(false)}
            />
          )}
          <PromptDrawer tick={promptsTick} />
        </>
      }
    >
      <Tldraw onMount={setEditor} components={buildTldrawComponents(room)} />
    </AppChrome>
  );
}
