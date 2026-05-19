import { useEffect, useMemo, useRef, useState } from "react";
import { type Editor, type TLGeoShape, Tldraw } from "tldraw";
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

/**
 * DRW-077: Re-trigger tldraw's growY side-effect for geo shapes.
 *
 * tldraw's GeoShapeUtil.onBeforeUpdate runs growY only when shapes are
 * mutated via editor.createShapes/updateShapes (not via store.put /
 * mergeRemoteChanges). Calling editor.updateShape with the same props forces
 * onBeforeUpdate to run and correct the height to fit the label text.
 *
 * @param editor  Live tldraw editor instance.
 * @param ids     Optional set of shape ids to process; when omitted all geo
 *                shapes on the current page are processed.
 */
function triggerGrowY(editor: Editor, ids?: Set<string>): void {
  const shapes = editor.getCurrentPageShapes().filter(
    (s): s is TLGeoShape =>
      s.type === "geo" && (ids === undefined || ids.has(s.id)),
  );
  if (shapes.length === 0) return;
  editor.run(() => {
    for (const s of shapes) {
      editor.updateShape<TLGeoShape>({ id: s.id, type: "geo", props: s.props });
    }
  });
}

export function App({ room }: { room: string }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [promptsTick, setPromptsTick] = useState(0);
  const [cameraTick, setCameraTick] = useState(0);
  // DRW-075: tracks whether the user has manually panned/zoomed.
  // When false, post-AI-change zoomToFit is allowed; reset on room change.
  const userHasManuallyPanned = useRef(false);
  // True while we are inside a programmatic camera operation (initial fit,
  // restored-camera setCamera, debounced post-AI zoomToFit). The camera
  // listener uses this to distinguish programmatic moves from real user pans.
  const inProgrammaticCameraOp = useRef(false);
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

    // DRW-075: reset user-pan flag on room/editor change so AI fit is active
    // for the fresh room until the user interacts with the camera.
    userHasManuallyPanned.current = false;
    // Guard: programmatic zoomToFit also writes the camera with source:"user",
    // which would otherwise trip the user-pan listener below. Set this ref to
    // true around each programmatic fit so the listener can ignore those.
    inProgrammaticCameraOp.current = false;

    // DRW-075: debounced zoomToFit after AI mutations; fires at most once per
    // 100ms burst of AI store-change frames. Cancelled on room change via the
    // `active` flag checked inside the callback.
    let aiZoomTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleAiZoom = () => {
      if (aiZoomTimer !== null) clearTimeout(aiZoomTimer);
      aiZoomTimer = setTimeout(() => {
        aiZoomTimer = null;
        if (!active || userHasManuallyPanned.current) return;
        inProgrammaticCameraOp.current = true;
        editor.zoomToFit({ animation: { duration: 200 } });
        // Hold the guard for the full animation duration + margin — each
        // animation frame emits a camera change with source:"user" which would
        // otherwise trip the user-pan listener and lock out further AI fits.
        setTimeout(() => {
          inProgrammaticCameraOp.current = false;
        }, 300);
      }, 100);
    };

    const hydrateAndSync = async () => {
      const loaded = await fetchAndLoadSnapshot();
      if (!loaded) return;

      // Initial AI-activity snapshot.
      fetch(`/api/ai/activity?room=${encodeURIComponent(room)}`)
        .then((r) => r.json())
        .then((j) => active && setAiActivity(j.activity ?? null))
        .catch(() => {});

      // DRW-077: re-trigger growY for all geo shapes after initial snapshot
      // load. loadSnapshot uses store.put (not editor.createShapes), so
      // tldraw's onBeforeUpdate growY never fires. A no-op updateShape forces
      // the util to recalculate height based on actual text bounds.
      triggerGrowY(editor);

      // Camera: restore from localStorage, otherwise zoomToFit if there's
      // content. If a saved camera exists the user has already navigated this
      // room — mark as manually panned so AI fit won't override it.
      const cam = loadCamera(room);
      inProgrammaticCameraOp.current = true;
      if (cam) {
        editor.setCamera(cam, { immediate: true });
        userHasManuallyPanned.current = true;
      } else {
        const shapesCount = editor.getCurrentPageShapes().length;
        if (shapesCount) editor.zoomToFit({ animation: { duration: 0 } });
      }
      // Initial fit uses duration:0 (no animation) — listener fires
      // synchronously, but we still wait a small margin to cover any reactive
      // signal propagation tick before clearing the guard.
      setTimeout(() => {
        inProgrammaticCameraOp.current = false;
      }, 50);

      // Start WS store sync.
      const wsUrl = `ws://${location.host}/ws?room=${encodeURIComponent(room)}`;
      syncHandle = startStoreSync({
        editor,
        wsUrl,
        room,
        initialVersion: loaded.version,
        // DRW-077 + DRW-075: on each AI store-change batch re-trigger growY
        // for affected geo shapes and schedule a camera fit if the user hasn't
        // manually navigated.
        onAiChange: (changedIds) => {
          if (!active) return;
          triggerGrowY(editor, changedIds);
          scheduleAiZoom();
        },
        // DRW-083: MCP import-mermaid command — backend routes WS frame here.
        // Append-only by design — AI must never wipe existing canvas state.
        onImportMermaid: async (source, _requestId) => {
          const result = await importMermaid(editor, source);
          // Collect didrawNames from shape meta (set by importMermaid internally)
          const didrawNames = result.shapeIds.map((id) => {
            const shape = editor.getShape(id);
            const name = (shape?.meta as Record<string, unknown> | undefined)?.didrawName;
            return typeof name === "string" ? name : "";
          });
          return {
            ok: result.ok,
            shapeIds: result.shapeIds as unknown as string[],
            didrawNames,
            rootIds: result.sourceTargetIds as unknown as string[],
          };
        },
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
                onAiChange: (changedIds) => {
                  if (!active) return;
                  triggerGrowY(editor, changedIds);
                  scheduleAiZoom();
                },
                onImportMermaid: async (source, _requestId) => {
                  const result = await importMermaid(editor, source);
                  const didrawNames = result.shapeIds.map((id) => {
                    const shape = editor.getShape(id);
                    const name = (shape?.meta as Record<string, unknown> | undefined)?.didrawName;
                    return typeof name === "string" ? name : "";
                  });
                  return {
                    ok: result.ok,
                    shapeIds: result.shapeIds as unknown as string[],
                    didrawNames,
                    rootIds: result.sourceTargetIds as unknown as string[],
                  };
                },
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
            // DRW-075: any user-driven camera move marks the viewport as
            // intentionally positioned — AI post-mutation zoomToFit will not
            // override it anymore. Programmatic fits (set the
            // inProgrammaticCameraOp ref) are excluded so chained AI batches
            // can still re-fit as content grows.
            if (!inProgrammaticCameraOp.current) {
              userHasManuallyPanned.current = true;
            }
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
      if (aiZoomTimer !== null) {
        clearTimeout(aiZoomTimer);
        aiZoomTimer = null;
      }
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
