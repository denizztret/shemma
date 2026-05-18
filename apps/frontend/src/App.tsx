import { useEffect, useMemo, useState } from "react";
import { type Editor, Tldraw } from "tldraw";
import "tldraw/tldraw.css";
import { loadCamera, saveCamera } from "./canvas/camera-persist";
import { getDidrawName } from "./canvas/id-prefix";
import { importMermaid } from "./canvas/mermaid-import";
import { backfillStoreRecords } from "./canvas/schema-placeholder";
import { AiActivityBadge } from "./chrome/AiActivityBadge";
import { AppChrome } from "./chrome/AppChrome";
import { ErrorBanner } from "./chrome/ErrorBanner";
import { buildTldrawComponents } from "./chrome/TldrawComponents";
import { UpdateBanner } from "./chrome/UpdateBanner";
import { MermaidImportModal } from "./mermaid/MermaidImportModal";
import { PromptDrawer } from "./prompts/PromptDrawer";
import { PromptInput } from "./prompts/PromptInput";
import { getState, seedSchema } from "./transport/api";
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
  // Mermaid import modal toggled by ⌘M (Ctrl+M on non-Mac). Closed by
  // Render/Cancel/Esc — управление внутри MermaidImportModal.
  const [mermaidOpen, setMermaidOpen] = useState(false);
  const [aiActivity, setAiActivity] = useState<AiActivity | null>(null);

  // tldraw requires `components` prop to be memoized (or defined outside the
  // component) to avoid re-mounting the editor on every render.
  const tldrawComponents = useMemo(
    () => buildTldrawComponents(room, { onMermaidImport: () => setMermaidOpen(true) }),
    [room],
  );

  // ⌘K / ⌘M / Esc keyboard handler.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPromptOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "m") {
        // ⌘M — open Mermaid import modal. preventDefault — на случай если
        // браузер/OS попытается забрать (на macOS Chrome native ⌘M = minimize
        // window, но user сообщил что освободил его в системе).
        e.preventDefault();
        setMermaidOpen(true);
      } else if (e.key === "Escape") {
        setPromptOpen(false);
        // Mermaid modal closes itself via internal Esc handler; не трогаем
        // здесь чтобы не перехватить race-condition'но.
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
  // from transport/ws.ts (`shemma:ws-message`). Transport itself stays
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
    window.addEventListener("shemma:ws-message", handler);
    return () => window.removeEventListener("shemma:ws-message", handler);
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
    let syncHandle: ReturnType<typeof startStoreSync> | undefined;
    let focusCleanup: (() => void) | undefined;
    let unsubSel: (() => void) | undefined;
    let camSaveTimer: ReturnType<typeof setTimeout> | undefined;

    // DRW-047 + DRW-018: upload our V2 schema (best-effort), then fetch /api/state
    // and apply via mergeRemoteChanges. Shared by initial hydrate and truncated-recovery.
    const fetchAndLoadSnapshot = async (): Promise<{ version: number } | null> => {
      try {
        await seedSchema(room, editor.store.schema.serialize());
      } catch {
        // network blip; getState path handles legacy placeholder rooms too.
      }
      const s = await getState();
      if (!active) return null;
      const snapshot = { ...s.store, store: backfillStoreRecords(s.store?.store) };
      editor.store.mergeRemoteChanges(() => {
        editor.loadSnapshot(snapshot);
      });
      return { version: s.version };
    };

    const hydrateAndSync = async () => {
      const loaded = await fetchAndLoadSnapshot();
      if (!loaded) return;

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
      syncHandle = startStoreSync({
        editor,
        wsUrl,
        room,
        initialVersion: loaded.version,
        onTruncated: () => {
          // DRW-018: pause the (now zombie) syncer immediately so any frames
          // that arrive between this callback and ws.close() — or any straggler
          // queued in the JS event loop — are dropped instead of applied to
          // the about-to-be-replaced store. The syncer also marks itself
          // `stopped` in the 'truncated' handler, but `setPaused(true)` is
          // belt-and-braces and explicit at the call site.
          syncHandle?.setPaused(true);
          // Server says we're too far behind to replay → re-fetch full state.
          void (async () => {
            try {
              const fresh = await fetchAndLoadSnapshot();
              if (!fresh) return;
              syncHandle?.stop();
              syncHandle = startStoreSync({
                editor,
                wsUrl,
                room,
                initialVersion: fresh.version,
                onTruncated: () => {
                  // Pathological loop — log and stop trying.
                  console.warn("[shemma] truncated recovery looped, giving up");
                },
              });
            } catch (e) {
              console.warn("[shemma] truncated recovery failed:", e);
            }
          })();
        },
      });

      // Wire window focus/blur/beforeunload → board-focus beacon.
      // Each focus change notifies the MCP layer which room the human is on.
      // Handlers reference syncHandle via closure so they always reach the
      // latest syncer instance (recovery may replace it).
      const onFocus = () => syncHandle?.beacon.emitFocus();
      const onBlur = () => syncHandle?.beacon.emitBlur();
      window.addEventListener("focus", onFocus);
      window.addEventListener("blur", onBlur);
      window.addEventListener("beforeunload", onBlur);
      // Capture removers in a closure variable so the useEffect cleanup can
      // detach them without needing a global window property.
      focusCleanup = () => {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("beforeunload", onBlur);
      };

      // Dev-console helper: window.shemmaImportMermaid(source). Mutates store;
      // startStoreSync auto-forwards the batch to backend over WS.
      // biome-ignore lint/suspicious/noExplicitAny: attaching helper to window
      (window as any).shemmaImportMermaid = async (source: string) => {
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
      focusCleanup?.();
      focusCleanup = undefined;
      syncHandle?.stop();
      unsubSel?.();
      if (camSaveTimer) {
        clearTimeout(camSaveTimer);
        saveCamera(room, editor.getCamera());
      }
      // biome-ignore lint/suspicious/noExplicitAny: cleaning up window helper
      // biome-ignore lint/performance/noDelete: intentional property removal
      delete (window as any).shemmaImportMermaid;
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
          {editor && (
            <MermaidImportModal
              visible={mermaidOpen}
              onClose={() => setMermaidOpen(false)}
              onSubmit={async (source) => {
                try {
                  await importMermaid(editor, source);
                  return { ok: true };
                } catch (e) {
                  return { ok: false, error: String(e) };
                }
              }}
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
        components={tldrawComponents}
      />
    </AppChrome>
  );
}
