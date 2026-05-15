import { useEffect, useState } from "react";
import { type Editor, Tldraw } from "tldraw";
import "tldraw/tldraw.css";
import { nodeToShape } from "./canvas/from-canvas-state";
import { AppChrome } from "./chrome/AppChrome";
import { buildTldrawComponents } from "./chrome/TldrawComponents";
import { getState } from "./transport/api";

export function App({ room }: { room: string }) {
  const [editor, setEditor] = useState<Editor | null>(null);

  useEffect(() => {
    if (!editor) return;
    let active = true;
    (async () => {
      const s = await getState();
      if (!active) return;
      const shapes = s.canvas.nodes.map(nodeToShape);
      if (shapes.length) editor.createShapes(shapes);
    })();
    return () => {
      active = false;
    };
  }, [editor]);

  return (
    <AppChrome banner={null} footer={null} floatingOverlays={null}>
      <Tldraw onMount={setEditor} components={buildTldrawComponents(room)} />
    </AppChrome>
  );
}
