import { useEffect, useState } from "react";
import { type Editor, Tldraw } from "tldraw";
import "tldraw/tldraw.css";
import { loadCamera, saveCamera } from "./canvas/camera-persist";
import { getDidrawName } from "./canvas/id-prefix";
import { importMermaid } from "./canvas/mermaid-import";
import { backfillStoreRecords, isPlaceholderSchema } from "./canvas/schema-placeholder";
import { AiActivityBadge } from "./chrome/AiActivityBadge";
import { AppChrome } from "./chrome/AppChrome";
import { ErrorBanner } from "./chrome/ErrorBanner";
import { buildTldrawComponents } from "./chrome/TldrawComponents";
import { UpdateBanner } from "./chrome/UpdateBanner";
import { PromptDrawer } from "./prompts/PromptDrawer";
import { PromptInput } from "./prompts/PromptInput";
import { getState } from "./transport/api";
import { viewportReporter } from "./transport/viewport";
import { type AiActivity, startStoreSync } from "./transport/ws";

export function App({ room }: { room: string }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [promptsTick, setPromptsTick] = useState(0);
  const [cameraTick, setCameraTick] = useState(0);
  // PromptInput is toggled by ⌘K (Ctrl+K on non-Mac) — opens for the current
  // selection and stays open until Send/Esc/selection cleared.
  const [promptOpen, setPromptOpen] = useState(false);
  const [aiActivity, setAiActivity] = useState<AiActivity | null>(null);

  // ⌘K / Esc keyboard handler for PromptInput visibility.
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

  // Periodic re-fetch of AI activity (10s). Cheap insurance against WS drops
  // that leave the badge in a stale state; also re-fires on tab focus.
  useEffect(() => {
    let cancelled = false;
    const refetch = async () => {
      try {
        const r = await fetch(
          `/api/ai/activity?room=${encodeURIComponent(room)}`,
        );
        const j = await r.json();
        if (!cancelled) setAiActivity(j.activity ?? null);
      } catch {
        // network blip; next tick retries.
      }
    };
    const id = setInterval(refetch, 10_000);
    const onFocus = () => refetch();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [room]);

  // Chrome (prompt drawer + AI badge) listens to ws-bus dispatched events
  // from transport/ws.ts (`didraw:ws-message`). Transport itself stays
  // decoupled — it does not import App/Drawer/Badge components.
  useEffect(() => {
    // biome-ignore lint/suspicious/noExplicitAny: window CustomEvent payload is opaque
    const handler = (e: any) => {
      const m = e.detail;
      if (!m || typeof m !== "object") return;
      switch (m.kind) {
        case "prompt-created":
        case "prompt-resolved":
        case "prompt-removed":
          setPromptsTick((x) => x + 1);
          break;
        case "ai-activity":
          setAiActivity(m.activity ?? null);
          break;
      }
    };
    window.addEventListener("didraw:ws-message", handler);
    return () => window.removeEventListener("didraw:ws-message", handler);
  }, []);

  // Viewport reporter (camera → backend, debounced 500ms).
  useEffect(() => {
    if (!editor) return;
    const stop = viewportReporter(editor, { roomId: room });
    return () => stop();
  }, [editor, room]);

  // Primary lifecycle: hydrate tldraw from /api/state, start WS store-sync,
  // wire selection/camera listeners. All shape mutations go through tldraw's
  // own store — outbound sync is handled by startStoreSync via store.listen
  // (source:'user', scope:'document').
  useEffect(() => {
    if (!editor) return;
    let active = true;
    let stopSync: (() => void) | undefined;
    let unsubSel: (() => void) | undefined;
    let camSaveTimer: ReturnType<typeof setTimeout> | undefined;

    const hydrateAndSync = async () => {
      const s = await getState();
      if (!active) return;

      // Backend хранит реальную V2 схему, полученную от первого WS-клиента
      // (DRW-040). Но на самом первом коннекте к свежей комнате schema ещё
      // placeholder V1 stub — loadSnapshot бы упал на миграциях. Детектим
      // placeholder и подменяем на текущую editor schema только в этом случае;
      // на втором же подключении backend уже отдаст реальную V2 — override
      // выключится сам.
      const backfilledStore = backfillStoreRecords(s.store?.store);
      const snapshot = isPlaceholderSchema(s.store?.schema)
        ? { ...s.store, store: backfilledStore, schema: editor.store.schema.serialize() }
        : { ...s.store, store: backfilledStore };
      editor.store.mergeRemoteChanges(() => {
        editor.loadSnapshot(snapshot);
      });

      // Initial AI-activity snapshot.
      fetch(`/api/ai/activity?room=${encodeURIComponent(room)}`)
        .then((r) => r.json())
        .then((j) => active && setAiActivity(j.activity ?? null))
        .catch(() => {});

      // Camera: restore from localStorage, otherwise zoomToFit if there's content.
      const cam = loadCamera(room);
      if (cam) {
        editor.setCamera(cam, { immediate: true });
      } else {
        const shapesCount = editor.getCurrentPageShapes().length;
        if (shapesCount) editor.zoomToFit({ animation: { duration: 0 } });
      }

      // Start WS store sync.
      const wsUrl = `ws://${location.host}/ws?room=${encodeURIComponent(room)}`;
      const sync = startStoreSync({
        editor,
        wsUrl,
        initialVersion: s.version,
        onTruncated: () => {
          // Server says we're too far behind to replay → re-fetch full state.
          void (async () => {
            try {
              const fresh = await getState();
              if (!active) return;
              const freshBackfilled = backfillStoreRecords(fresh.store?.store);
              const freshSnapshot = isPlaceholderSchema(fresh.store?.schema)
                ? { ...fresh.store, store: freshBackfilled, schema: editor.store.schema.serialize() }
                : { ...fresh.store, store: freshBackfilled };
              editor.store.mergeRemoteChanges(() => {
                editor.loadSnapshot(freshSnapshot);
              });
              // Re-arm sync with the fresh version.
              stopSync?.();
              const restart = startStoreSync({
                editor,
                wsUrl,
                initialVersion: fresh.version,
                onTruncated: () => {
                  // Pathological loop — log and stop trying.
                  console.warn("[didraw] truncated recovery looped, giving up");
                },
              });
              stopSync = restart.stop;
            } catch (e) {
              console.warn("[didraw] truncated recovery failed:", e);
            }
          })();
        },
      });
      stopSync = sync.stop;

      // Dev-console helper: window.didrawImportMermaid(source). Mutates store;
      // startStoreSync auto-forwards the batch to backend over WS.
      // biome-ignore lint/suspicious/noExplicitAny: attaching helper to window
      (window as any).didrawImportMermaid = async (source: string) => {
        try {
          return await importMermaid(editor, source);
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      };

      // Selection + camera listener (session scope) for PromptInput anchor.
      let lastCamKey = "";
      unsubSel = editor.store.listen(
        () => {
          // Selection → emit didrawName когда оно есть (AI-created shapes), иначе
          // raw shape id (user-drawn). Domain APIs принимают оба.
          const ids = editor.getSelectedShapeIds().map((id) => {
            const sh = editor.getShape(id);
            const name = sh ? getDidrawName(sh) : undefined;
            return name ?? (id as unknown as string);
          });
          setSelection(ids);

          // Re-anchor PromptInput on camera change; debounce save to localStorage.
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
    };

    void hydrateAndSync();

    return () => {
      active = false;
      stopSync?.();
      unsubSel?.();
      if (camSaveTimer) {
        clearTimeout(camSaveTimer);
        saveCamera(room, editor.getCamera());
      }
      // biome-ignore lint/suspicious/noExplicitAny: cleaning up window helper
      // biome-ignore lint/performance/noDelete: intentional property removal
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
          <AiActivityBadge activity={aiActivity} />
          <ErrorBanner />
        </>
      }
    >
      <Tldraw
        // Phase 3.0: NO persistenceKey. Backend TLStoreSnapshot — единственный
        // источник правды; IndexedDB persistence создавал split-brain между
        // tab'ами и бэкендом (см. spec §3.x). Refresh → /api/state → loadSnapshot.
        onMount={(ed) => {
          setEditor(ed);
          if (import.meta.env.DEV) {
            // biome-ignore lint/suspicious/noExplicitAny: dev-only debug hook
            (window as any).__editor = ed;
          }
        }}
        components={buildTldrawComponents(room)}
      />
    </AppChrome>
  );
}
