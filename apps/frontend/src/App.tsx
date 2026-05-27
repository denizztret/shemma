import { useEffect, useMemo, useRef, useState } from "react";
import { type Editor, Tldraw } from "tldraw";
import { triggerAutoSize } from "./canvas/auto-size";
import {
  SchemaContainerShapeUtil,
  registerAutoFlipDirection,
  setContainerDirection,
} from "./shapes/schema-container";
import type { SchemaContainerDirection } from "./shapes/schema-container";
import "tldraw/tldraw.css";
import "./settings/styles.css";
import { loadCamera, saveCamera } from "./canvas/camera-persist";
import { getDidrawName } from "./canvas/id-prefix";
import { importMermaid, isBoundsContained, unionBoundsOf } from "./canvas/mermaid-import";
import { backfillStoreRecords } from "./canvas/schema-placeholder";
import { registerStyleDefaultsSync } from "./canvas/style-defaults-sync";
import { registerPinAutoToggle } from "./canvas/pin-auto-toggle";
import { makeExportHotkeyHandler } from "./canvas/export-hotkey";
import { makeForceReLayoutHotkeyHandler, makeTidyHotkeyHandler, tidyLayout } from "./canvas/tidy-layout";
import { postLayoutSelection } from "./settings/api";
import {
  classifySelection,
  makeRolePickerHandler,
  type SelectionInfo,
} from "./canvas/role-picker.ts";
import { RolePicker } from "./canvas/role-picker.tsx";
import { applyOverlaysToShapes } from "./canvas/schema-overlay-hydrate";
import { installSchemaOverlaySync } from "./canvas/schema-overlay-sync";
import { AiActivityBadge } from "./chrome/AiActivityBadge";
import { AppChrome } from "./chrome/AppChrome";
import { ErrorBanner } from "./chrome/ErrorBanner";
import { buildTldrawComponents } from "./chrome/TldrawComponents";
import { UpdateBanner } from "./chrome/UpdateBanner";
import { ExportMiroModal } from "./canvas/export-miro-modal";
import { MermaidImportModal } from "./mermaid/MermaidImportModal";
import { PromptDrawer } from "./prompts/PromptDrawer";
import { PromptInput } from "./prompts/PromptInput";
import { getState, seedSchema } from "./transport/api";
import { viewportReporter } from "./transport/viewport";
import { computeTruncatedBackoff } from "./transport/sync-recovery";
import { type AiActivity, startStoreSync } from "./transport/ws";

/**
 * DRW-096: zoom to the union bounds of `affectedIds`, but only when those
 * bounds are not already fully contained in the current viewport. Sets the
 * programmatic-camera-op ref for the animation duration so the user-pan
 * listener does not trip on synthetic camera events.
 */
function maybeZoomToAffected(
  editor: Editor,
  affectedIds: string[],
  inProgrammaticCameraOp: { current: boolean },
): void {
  if (affectedIds.length === 0 || inProgrammaticCameraOp.current) return;
  const ids = affectedIds as unknown as Parameters<typeof unionBoundsOf>[1];
  const bounds = unionBoundsOf(editor, ids);
  if (!bounds) return;
  const viewport = editor.getViewportPageBounds();
  if (isBoundsContained(bounds, viewport)) return;
  inProgrammaticCameraOp.current = true;
  editor.zoomToBounds(bounds, { animation: { duration: 200 }, inset: 64 });
  setTimeout(() => {
    inProgrammaticCameraOp.current = false;
  }, 300);
}

export function App({
  space,
  room,
}: {
  space: string;
  room: string;
}) {
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
  const [exportOpen, setExportOpen] = useState(false);
  const [aiActivity, setAiActivity] = useState<AiActivity | null>(null);
  // DRW-134 Task 3.2: Cmd+Shift+K semantic picker state.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerInfo, setPickerInfo] = useState<SelectionInfo>({
    hasSelection: false,
    mode: "none",
    shapeIds: [],
    arrowIds: [],
  });

  // tldraw requires `components` prop to be memoized (or defined outside the
  // component) to avoid re-mounting the editor on every render.
  const onTidySelection = useRef<((ids: string[]) => void) | null>(null);
  const onExportSelection = useRef<((ids: string[]) => void) | null>(null);
  // DRW-150: schema-container direction callback — needs live editor ref, set in onMount.
  const onSetContainerDirection = useRef<((direction: SchemaContainerDirection) => void) | null>(null);
  // DRW-150: disposer for registerAutoFlipDirection — prevents listener accumulation on HMR/room-switch.
  const autoFlipDisposerRef = useRef<(() => void) | null>(null);
  // DRW-180 style-propagation Task 9: disposer for registerStyleDefaultsSync.
  const styleSyncDisposerRef = useRef<(() => void) | null>(null);
  // DRW-185: disposer for registerPinAutoToggle.
  const pinAutoToggleDisposerRef = useRef<(() => void) | null>(null);
  onExportSelection.current = (ids: string[]) => {
    if (ids.length === 0) return;
    setExportOpen(true);
  };
  const tldrawComponents = useMemo(
    () =>
      buildTldrawComponents(space, room, {
        onMermaidImport: () => setMermaidOpen(true),
        onTidySelection: (ids) => onTidySelection.current?.(ids),
        onExportSelection: (ids) => onExportSelection.current?.(ids),
        onSetContainerDirection: (direction) => onSetContainerDirection.current?.(direction),
      }),
    [space, room],
  );

  // DRW-150: cleanup auto-flip listener on unmount
  // DRW-180: + style-defaults sync disposer
  useEffect(() => {
    return () => {
      autoFlipDisposerRef.current?.();
      autoFlipDisposerRef.current = null;
      styleSyncDisposerRef.current?.();
      styleSyncDisposerRef.current = null;
      pinAutoToggleDisposerRef.current?.();
      pinAutoToggleDisposerRef.current = null;
    };
  }, []);

  // ⌘K / ⌘M / Esc keyboard handler.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
        // DRW-136 #1: !shiftKey guard — без него ⌘+Shift+K (semantic picker)
        // одновременно toggle'ил PromptInput, и два overlay'а конкурировали
        // за внимание. Picker сам wired в отдельном useEffect ниже.
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

  // ⌘⇧L / Ctrl+Shift+L — tidy layout for current selection. Hotkeys are wired
  // at component level (not inside editor useEffect) so they activate before the
  // editor mounts (handler is a no-op while editor is null).
  useEffect(() => {
    if (!editor) return;
    const handler = makeTidyHotkeyHandler(
      () => editor.getSelectedShapeIds() as unknown as string[],
      editor,
      async (ids, scope) => {
        const result = await tidyLayout(ids, space, room, scope);
        if (result.kind === "ok") {
          maybeZoomToAffected(editor, result.affected, inProgrammaticCameraOp);
        }
      },
    );
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editor, space, room]);

  // ⌘⌥⇧L / Ctrl+Alt+Shift+L — force re-layout: backend ignores meta.pinned /
  // meta.didrawSizePinned for this single layout pass without clearing flags.
  // Capture phase + window: tldraw input system also listens on keydown, so we
  // intercept before it (otherwise Alt-mod combos can be swallowed by the
  // editor's own shortcut router).
  useEffect(() => {
    if (!editor) return;
    const handler = makeForceReLayoutHotkeyHandler(
      () => editor.getSelectedShapeIds() as unknown as string[],
      editor,
      async (ids, scope) => {
        try {
          await postLayoutSelection(space, room, { ids, scope, forceUnpin: true });
        } catch (e) {
          console.warn("[force-relayout] failed", e);
        }
      },
    );
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [editor, space, room]);

  // ⌘⇧E / Ctrl+Shift+E — open Export to Miro modal for current selection.
  useEffect(() => {
    const handler = makeExportHotkeyHandler(
      () => (editor ? (editor.getSelectedShapeIds() as unknown as string[]) : []),
      (ids) => {
        if (ids.length === 0) return;
        setExportOpen(true);
      },
    );
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editor]);

  // DRW-134 Task 3.2: Cmd+Shift+K / Ctrl+Shift+K — semantic picker.
  // Classifies the current selection (shapes vs arrows), then opens the picker modal.
  useEffect(() => {
    const handler = makeRolePickerHandler(
      () => {
        if (!editor) return { hasSelection: false, mode: "none", shapeIds: [], arrowIds: [] };
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        return classifySelection(ids, (id) => {
          // biome-ignore lint/suspicious/noExplicitAny: tldraw id typing
          return editor.getShape(id as any)?.type === "arrow";
        });
      },
      () => {
        if (!editor) return;
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        const info = classifySelection(ids, (id) => {
          // biome-ignore lint/suspicious/noExplicitAny: tldraw id typing
          return editor.getShape(id as any)?.type === "arrow";
        });
        setPickerInfo(info);
        setPickerOpen(true);
      },
      // onEmpty — no-op: no toast, just ignore (spec: silent no-op on empty selection)
    );
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editor]);

  // Periodic re-fetch of AI activity (10s). Cheap insurance against WS drops
  // that leave the badge in a stale state; also re-fires on tab focus.
  useEffect(() => {
    let cancelled = false;
    const refetch = async () => {
      try {
        const r = await fetch(
          `/api/ai/activity?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`,
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
  }, [space, room]);

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
    const stop = viewportReporter(editor, { roomId: room, space });
    return () => stop();
  }, [editor, space, room]);

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
    let unsubOverlaySync: (() => void) | undefined;
    let camSaveTimer: ReturnType<typeof setTimeout> | undefined;
    // DRW-137: truncated recovery timer — cancel on cleanup to prevent
    // post-unmount fetches on a room that's been switched away.
    let truncatedRecoveryTimer: ReturnType<typeof setTimeout> | undefined;

    // DRW-047 + DRW-018: upload our V2 schema (best-effort), then fetch /api/state
    // and apply via mergeRemoteChanges. Shared by initial hydrate and truncated-recovery.
    const fetchAndLoadSnapshot = async (): Promise<{ version: number } | null> => {
      try {
        await seedSchema(space, room, editor.store.schema.serialize());
      } catch {
        // network blip; getState path handles legacy placeholder rooms too.
      }
      const s = await getState(space, room);
      if (!active) return null;
      const snapshot = { ...s.store, store: backfillStoreRecords(s.store?.store) };
      editor.store.mergeRemoteChanges(() => {
        editor.loadSnapshot(snapshot);
        // DRW-135: backend store содержит RAW positions; user overlays лежат
        // в frame.meta.didrawOverlays и должны быть применены поверх RAW.
        // Внутри mergeRemoteChanges чтобы overlay-sync listener (source:"user")
        // не отправил POST обратно.
        applyOverlaysToShapes(editor);
      });
      return { version: s.version };
    };

    // Tidy callback for the context menu. Same logic as the keyboard shortcut
    // handler above, accessed via ref so TldrawComponents can invoke it without
    // importing editor state.
    onTidySelection.current = async (ids: string[]) => {
      const result = await tidyLayout(ids, space, room);
      if (result.kind === "ok") {
        maybeZoomToAffected(editor, result.affected, inProgrammaticCameraOp);
      }
    };

    // DRW-075: reset user-pan flag on room/editor change so AI fit is active
    // for the fresh room until the user interacts with the camera.
    userHasManuallyPanned.current = false;
    // Guard: programmatic zoomToFit also writes the camera with source:"user",
    // which would otherwise trip the user-pan listener below. Set this ref to
    // true around each programmatic fit so the listener can ignore those.
    inProgrammaticCameraOp.current = false;

    // DRW-083/086: shared handler for backend-routed import-mermaid frames.
    // Used by both the initial syncer and the post-truncation syncer.
    const runMermaidImport = async (
      source: string,
      _requestId: string,
      focus: "new" | "fit-all" | "none" = "new",
    ) => {
      const result = await importMermaid(editor, source);

      // DRW-141: v2 path returns {frameId, nodeIds, shapeIds:[]} because the
      // backend writes shapes server-side and WS broadcasts them; the editor
      // store may not yet contain those records when we reply. Surface the
      // backend-assigned identifiers so AI gets a non-empty response and can
      // chain follow-up tool calls (shemma_connect / shemma_patch_schema).
      const isV2 = result.frameId !== undefined;
      if (isV2) {
        const nodeIds = (result.nodeIds ?? []) as unknown as string[];
        // v2: animate to the new frame via fit-all if it's already loaded (WS
        // broadcast might race the reply). Skip per-shape bounds — tldraw IDs
        // aren't known to us in this branch.
        if (
          focus !== "none" &&
          !userHasManuallyPanned.current &&
          (focus === "fit-all" || result.frameId)
        ) {
          inProgrammaticCameraOp.current = true;
          editor.zoomToFit({ animation: { duration: 200 } });
          setTimeout(() => {
            inProgrammaticCameraOp.current = false;
          }, 300);
        }
        return {
          ok: result.ok,
          shapeIds: nodeIds,
          didrawNames: nodeIds,
          rootIds: result.frameId ? [result.frameId as unknown as string] : [],
        };
      }

      const didrawNames = result.shapeIds.map((id) => {
        const shape = editor.getShape(id);
        const name = (shape?.meta as Record<string, unknown> | undefined)?.didrawName;
        return typeof name === "string" ? name : "";
      });

      // DRW-086: animate viewport to new shapes (or fit-all), unless user
      // has manually panned (DRW-075 guard) or focus='none'.
      if (focus !== "none" && !userHasManuallyPanned.current && result.shapeIds.length > 0) {
        inProgrammaticCameraOp.current = true;
        if (focus === "fit-all") {
          editor.zoomToFit({ animation: { duration: 200 } });
        } else {
          // focus === "new" (default)
          const bounds = unionBoundsOf(editor, result.shapeIds);
          if (bounds) {
            editor.zoomToBounds(bounds, { animation: { duration: 200 }, inset: 64 });
          }
        }
        setTimeout(() => {
          inProgrammaticCameraOp.current = false;
        }, 300);
      }

      return {
        ok: result.ok,
        shapeIds: result.shapeIds as unknown as string[],
        didrawNames,
        rootIds: result.sourceTargetIds as unknown as string[],
      };
    };

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
      fetch(
        `/api/ai/activity?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`,
      )
        .then((r) => r.json())
        .then((j) => active && setAiActivity(j.activity ?? null))
        .catch(() => {});

      // DRW-077 / DRW-171: re-trigger autosize for geo/note/text shapes
      // after initial snapshot load. loadSnapshot uses store.put (not
      // editor.createShapes), so tldraw's onBeforeUpdate (growY for geo/note,
      // autoSize for text) never fires. A no-op updateShape pass forces each
      // util to remeasure and correct the bounds to fit text.
      triggerAutoSize(editor);

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
      // DRW-116 Task 15: composite (space, room) key — backend's WS handshake
      // routes the connection to the right per-space bundle. In legacy mode
      // (middleware off) `space` is the `__legacy__` sentinel and the backend
      // ignores it, preserving single-space semantics.
      const wsUrl = `ws://${location.host}/ws?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;

      // DRW-137: recursive recovery — truncated → fetch fresh state → reattach.
      // Exponential backoff между retries (0/1s/2s/4s/8s/16s/30s cap) защищает
      // от tight loop если backend постоянно отвечает truncated. cleanup useEffect
      // дропает truncatedTimer чтобы recovery не fired'ил на dead room.
      const attachStoreSync = (initialVersion: number, retryNumber: number) => {
        if (!active) return;
        syncHandle = startStoreSync({
          editor,
          wsUrl,
          room,
          initialVersion,
          onAiChange: (changedIds) => {
            if (!active) return;
            triggerAutoSize(editor, changedIds);
            scheduleAiZoom();
          },
          onImportMermaid: runMermaidImport,
          onTruncated: () => {
            if (!active) return;
            // DRW-018: pause immediately so straggler frames don't apply to
            // the about-to-be-replaced store.
            syncHandle?.setPaused(true);
            const next = retryNumber + 1;
            const delay = computeTruncatedBackoff(next);
            console.warn(
              `[shemma] truncated → reseed in ${delay}ms (retry ${next})`,
            );
            const fire = async () => {
              if (!active) return;
              try {
                const fresh = await fetchAndLoadSnapshot();
                if (!fresh || !active) return;
                syncHandle?.stop();
                attachStoreSync(fresh.version, next);
              } catch (e) {
                console.warn("[shemma] truncated recovery failed:", e);
                // Reschedule with longer backoff — never give up while active.
                const retryDelay = computeTruncatedBackoff(next + 1);
                truncatedRecoveryTimer = setTimeout(() => {
                  void fire();
                }, retryDelay);
              }
            };
            truncatedRecoveryTimer = setTimeout(() => {
              void fire();
            }, delay);
          },
        });
      };

      attachStoreSync(loaded.version, 0);

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

    // DRW-134 Task 2.7: install overlay-sync listener для user drag/color/rename
    // на schema-frame children. Listener subscribes к store.listen({source:"user"})
    // и debounce'ит POST /api/schema/{frameId}/overlay для каждого изменения.
    unsubOverlaySync = installSchemaOverlaySync(editor, { space, room });

    return () => {
      active = false;
      focusCleanup?.();
      focusCleanup = undefined;
      syncHandle?.stop();
      unsubSel?.();
      unsubOverlaySync?.();
      // DRW-137: cancel any pending truncated-recovery to avoid a stray
      // fetchAndLoadSnapshot on a room that's been unmounted.
      if (truncatedRecoveryTimer) {
        clearTimeout(truncatedRecoveryTimer);
        truncatedRecoveryTimer = undefined;
      }
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
  }, [editor, space, room]);

  return (
    <AppChrome
      banner={<UpdateBanner />}
      floatingOverlays={
        <>
          {editor && (
            <PromptInput
              editor={editor}
              space={space}
              room={room}
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
          {editor && (
            <ExportMiroModal
              open={exportOpen}
              space={space}
              room={room}
              selectedIds={selection}
              onClose={() => setExportOpen(false)}
            />
          )}
          {/* DRW-134 Task 3.2: Cmd+Shift+K semantic picker */}
          {editor && pickerOpen && (
            <RolePicker
              open={pickerOpen}
              info={pickerInfo}
              editor={editor}
              onClose={() => setPickerOpen(false)}
            />
          )}
          <PromptDrawer space={space} room={room} tick={promptsTick} />
          <AiActivityBadge activity={aiActivity} />
          <ErrorBanner />
        </>
      }
    >
      <Tldraw
        // Phase 3.0: NO persistenceKey. Backend TLStoreSnapshot — единственный
        // источник правды; IndexedDB persistence создавал split-brain между
        // tab'ами и бэкендом (см. spec §3.x). Refresh → /api/state → loadSnapshot.
        shapeUtils={[SchemaContainerShapeUtil]}
        onMount={(ed) => {
          setEditor(ed);
          // DRW-150: store disposer to prevent listener accumulation on HMR/room-switch
          autoFlipDisposerRef.current?.();
          autoFlipDisposerRef.current = registerAutoFlipDirection(ed);
          // DRW-180 style-propagation Task 9: bidirectional sync board defaults ↔
          // editor.stylesForNextShape + container resolution chain at create-time.
          styleSyncDisposerRef.current?.();
          styleSyncDisposerRef.current = registerStyleDefaultsSync(ed, space, room);
          // DRW-185: auto-pin on drag/resize end.
          pinAutoToggleDisposerRef.current?.();
          pinAutoToggleDisposerRef.current = registerPinAutoToggle(ed);
          // DRW-150: wire direction callback for context-menu (requires live editor).
          // Task #6 (frame-container-direction-layout): explicit "custom" stays as
          // schema-container props write (auto-flip parity); cardinal directions
          // go through polymorphic setContainerDirection (frame + schema-container).
          onSetContainerDirection.current = (direction) => {
            if (direction === "custom") {
              ed.run(() => {
                for (const id of ed.getSelectedShapeIds()) {
                  const s = ed.getShape(id);
                  if (s?.type !== "schema-container") continue;
                  ed.updateShape({
                    id,
                    type: "schema-container",
                    props: { ...(s.props as object), direction: "custom" },
                    // biome-ignore lint/suspicious/noExplicitAny: tldraw props untyped here
                  } as any);
                }
              });
              return;
            }
            const ids = ed.getSelectedShapeIds() as unknown as string[];
            setContainerDirection(ed, ids, direction);
          };
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
