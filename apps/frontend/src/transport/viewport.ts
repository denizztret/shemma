import type { Editor } from "tldraw";
import { LEGACY_SPACE_ID } from "./api";

const DEBOUNCE_MS = 500;

export function viewportReporter(
  editor: Editor,
  opts: { roomId: string; space?: string; baseUrl?: string } = { roomId: "default" },
): () => void {
  const base = opts.baseUrl ?? "";
  const space = opts.space ?? LEGACY_SPACE_ID;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function send() {
    const vp = editor.getViewportPageBounds();
    fetch(
      `${base}/api/viewport?space=${encodeURIComponent(space)}&room=${encodeURIComponent(opts.roomId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: vp.x, y: vp.y, w: vp.w, h: vp.h, zoom: editor.getCamera().z }),
      },
    ).catch(() => {});
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      send();
      timer = null;
    }, DEBOUNCE_MS);
  }

  // Subscribe to camera changes via tldraw store listener.
  // Camera records are session-scoped (not document-scoped), so we pass
  // { scope: "session" } to only receive session-level changes.
  // store.listen returns an unsubscribe function. We watch for camera record
  // updates whose keys start with "camera:".
  const unsubscribe = editor.store.listen(
    (event) => {
      if (
        event.source === "user" &&
        Object.keys(event.changes.updated).some((k) => k.startsWith("camera:"))
      ) {
        schedule();
      }
    },
    { scope: "session" },
  );

  // Initial send so the server has a viewport even before the user moves.
  send();

  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
