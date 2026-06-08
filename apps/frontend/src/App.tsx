import { useEffect, useMemo, useRef, useState } from "react";
import { type Editor, type TLShapeId, Tldraw } from "tldraw";
import { triggerAutoSize } from "./canvas/auto-size";
import {
  SchemaContainerShapeUtil,
  SchemaContainerTool,
  registerAutoFlipDirection,
  setContainerDirection,
} from "./shapes/schema-container";
import type { SchemaContainerDirection } from "./shapes/schema-container";
import { SHEMMA_ASSET_URLS, buildUiOverrides } from "./ui-overrides";
import "tldraw/tldraw.css";
import "./settings/styles.css";
import { registerArrowAnchorPin } from "./canvas/arrow-anchor-pin";
import { loadCamera, saveCamera } from "./canvas/camera-persist";
import { registerContainerTitlePositionInherit } from "./canvas/container-title-position-inherit";
import { registerDidrawIdDedup } from "./canvas/didraw-id-dedup";
import {
  buildObjectLink,
  parseIdParam,
  resolveUrlIds,
} from "./canvas/deep-link";
import { autoElkLayout, autoLayoutFrame } from "./canvas/elk-layout";
import { makeExportHotkeyHandler } from "./canvas/export-hotkey";
import { ExportMiroModal } from "./canvas/export-miro-modal";
import { getDidrawName } from "./canvas/id-prefix";
import {
  importMermaid,
  importMermaidWithEngine,
  isBoundsContained,
  unionBoundsOf,
} from "./canvas/mermaid-import";
import { registerPinAutoToggle } from "./canvas/pin-auto-toggle";
import {
  type SelectionInfo,
  classifySelection,
  makeRolePickerHandler,
} from "./canvas/role-picker.ts";
import { RolePicker } from "./canvas/role-picker.tsx";
import { applyOverlaysToShapes } from "./canvas/schema-overlay-hydrate";
import { installSchemaOverlaySync } from "./canvas/schema-overlay-sync";
import { backfillStoreRecords } from "./canvas/schema-placeholder";
import { registerStyleDefaultsSync } from "./canvas/style-defaults-sync";
import {
  makeForceReLayoutHotkeyHandler,
  makeTidyHotkeyHandler,
} from "./canvas/tidy-layout";
import { getActiveBinding } from "./settings/shortcuts/config";
import { matchShortcut } from "./settings/shortcuts/match";
import { AiActivityBadge } from "./chrome/AiActivityBadge";
import { AppChrome } from "./chrome/AppChrome";
import { ErrorBanner } from "./chrome/ErrorBanner";
import {
  type ToastSink,
  buildTldrawComponents,
} from "./chrome/TldrawComponents";
import { UpdateBanner } from "./chrome/UpdateBanner";
import { MermaidImportModal } from "./mermaid/MermaidImportModal";
import { PromptDrawer } from "./prompts/PromptDrawer";
import { PromptInput } from "./prompts/PromptInput";
import {
  applyTextFitToShape,
  applyTextFitToSelection,
} from "./canvas/apply-text-fit";
import { registerAutoTextFit } from "./canvas/auto-text-fit";
import { ThemeToggleButtonContainer } from "./theme/ThemeToggleButtonContainer";
import { useThemeMode } from "./theme/useThemeMode";
import { getState, seedSchema } from "./transport/api";
import { computeTruncatedBackoff } from "./transport/sync-recovery";
import { viewportReporter } from "./transport/viewport";
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

/**
 * DL (deep-link на объект): выделить и сфокусировать камеру на shape-id'ах из
 * `?id=`. Выделение = подсветка «показать пальцем». Зум капится на 1, чтобы
 * мелкий объект не раздувался во весь экран, а крупный — вписывался целиком.
 * Возвращает true, если найден хотя бы один shape.
 */
function focusDeepLinkShapes(editor: Editor, ids: TLShapeId[]): boolean {
  if (ids.length === 0) return false;
  editor.select(...ids);
  const bounds = unionBoundsOf(editor, ids);
  if (bounds && bounds.w > 0 && bounds.h > 0) {
    const vp = editor.getViewportScreenBounds();
    const inset = 80;
    const fit = Math.min(
      (vp.w - inset * 2) / bounds.w,
      (vp.h - inset * 2) / bounds.h,
    );
    const targetZoom = Math.min(fit > 0 ? fit : 1, 1);
    editor.zoomToBounds(bounds, { targetZoom, animation: { duration: 0 } });
  }
  return true;
}

export function App({
  space,
  room,
}: {
  space: string;
  room: string;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  // DRW-217: режим темы (light/dark/system) из shemma:theme; runtime-смена
  // прокидывается в tldraw через updateUserPreferences (effect ниже).
  const { mode: themeMode } = useThemeMode();
  // colorScheme передаётся в <Tldraw> ТОЛЬКО как initial (фиксируется один раз):
  // меняющийся prop пересоздаёт editor → InFrontOfTheCanvas-компоненты
  // (SettingsPopover) перемонтируются, и панель схлопывалась при каждом
  // переключении темы (находка приёмки). Runtime-смена — через
  // updateUserPreferences (canvas перекрашивается без reload).
  const [initialColorScheme] = useState(themeMode);
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
  const onSetContainerDirection = useRef<
    ((direction: SchemaContainerDirection) => void) | null
  >(null);
  // DRW-150: disposer for registerAutoFlipDirection — prevents listener accumulation on HMR/room-switch.
  const autoFlipDisposerRef = useRef<(() => void) | null>(null);
  // DRW-180 style-propagation Task 9: disposer for registerStyleDefaultsSync.
  const styleSyncDisposerRef = useRef<(() => void) | null>(null);
  // DRW-185: disposer for registerPinAutoToggle.
  const pinAutoToggleDisposerRef = useRef<(() => void) | null>(null);
  // DRW-190: disposer for registerArrowAnchorPin.
  const arrowAnchorPinDisposerRef = useRef<(() => void) | null>(null);
  // DRW-186 frame-scope: disposer for registerContainerTitlePositionInherit.
  const titlePosInheritDisposerRef = useRef<(() => void) | null>(null);
  // DRW-194: disposer for registerDidrawIdDedup (regen didrawId on duplicate).
  const didrawDedupDisposerRef = useRef<(() => void) | null>(null);
  // DRW-228: disposer for registerAutoTextFit (event-driven text-fit on add/edit).
  const autoTextFitDisposerRef = useRef<(() => void) | null>(null);
  // DL: deep-link toast sink — устанавливается ToastBridge внутри Tldraw
  // UI-контекста, вызывается из мест вне контекста (hydrate-ретрай, ⌘⌥C).
  const toastRef = useRef<ToastSink["current"]>(null);
  // DL: copy-link callback — ставится в onMount (нужен live editor + space/room).
  const onCopyObjectLink = useRef<((ids: string[]) => void) | null>(null);
  onExportSelection.current = (ids: string[]) => {
    if (ids.length === 0) return;
    setExportOpen(true);
  };
  const tldrawComponents = useMemo(
    () =>
      buildTldrawComponents(space, room, {
        onTidySelection: (ids) => onTidySelection.current?.(ids),
        onExportSelection: (ids) => onExportSelection.current?.(ids),
        onSetContainerDirection: (direction) =>
          onSetContainerDirection.current?.(direction),
        onCopyObjectLink: (ids) => onCopyObjectLink.current?.(ids),
        toastSink: toastRef,
      }),
    [space, room],
  );
  // DRW-186 Task 6: register tools (schema-container + mermaid-import) via
  // TLUiOverrides.tools — both land in tldraw native overflow popover.
  // Stable ref via useMemo (deps: setter is stable from React).
  const tldrawUiOverrides = useMemo(
    () => buildUiOverrides({ onMermaidImport: () => setMermaidOpen(true) }),
    [],
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
      titlePosInheritDisposerRef.current?.();
      titlePosInheritDisposerRef.current = null;
      didrawDedupDisposerRef.current?.();
      didrawDedupDisposerRef.current = null;
      autoTextFitDisposerRef.current?.();
      autoTextFitDisposerRef.current = null;
    };
  }, []);

  // DRW-217: runtime-смена темы → tldraw user prefs (canvas/UI перекрашиваются
  // без reload; AC#3). Наши поверхности перекрашивает data-shemma-theme.
  useEffect(() => {
    editor?.user.updateUserPreferences({ colorScheme: themeMode });
  }, [editor, themeMode]);

  // ⌘K / ⌘M / Esc keyboard handler.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchShortcut(getActiveBinding("prompt"), e)) {
        // DRW-136 #1: the default !shiftKey guard (encoded in the prompt
        // binding) keeps ⌘⇧K (semantic picker) from also toggling PromptInput.
        // Picker сам wired в отдельном useEffect ниже.
        e.preventDefault();
        setPromptOpen((v) => !v);
      } else if (matchShortcut(getActiveBinding("mermaid-import"), e)) {
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
      async (ids) => {
        // Core B: elkjs re-layout on the frontend (replaces legacy backend dagre).
        // autoLayoutFrame: aspect-aware auto-direction for unpinned frames.
        const result = await autoLayoutFrame(
          editor,
          ids as unknown as TLShapeId[],
        );
        if (result.kind === "ok") {
          maybeZoomToAffected(editor, result.affected, inProgrammaticCameraOp);
        } else if (result.kind === "error") {
          console.warn("[elk-layout] failed", result.message);
        }
      },
    );
    // Capture phase: tldraw's input system also listens on keydown and can
    // swallow ⌘⇧L before it bubbles to window. Intercept first (mirrors the
    // force-relayout handler below).
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [editor]);

  // ⌘⌥⇧L / Ctrl+Alt+Shift+L — force re-layout: elk lays out everything for this
  // single pass, ignoring meta.pinned / meta.didrawSizePinned without clearing
  // the flags. Capture phase + window: tldraw input system also listens on
  // keydown, so we intercept before it (otherwise Alt-mod combos can be
  // swallowed by the editor's own shortcut router).
  useEffect(() => {
    if (!editor) return;
    const handler = makeForceReLayoutHotkeyHandler(
      () => editor.getSelectedShapeIds() as unknown as string[],
      editor,
      async (ids) => {
        const result = await autoLayoutFrame(
          editor,
          ids as unknown as TLShapeId[],
          {
            forceUnpin: true,
            // ⌘⌥⇧L also re-infers every container direction from topology,
            // ignoring explicit per-container directions (clean-slate pass).
            forceDirections: true,
          },
        );
        if (result.kind === "ok") {
          maybeZoomToAffected(editor, result.affected, inProgrammaticCameraOp);
        } else if (result.kind === "error") {
          console.warn("[elk-layout] force failed", result.message);
        }
      },
    );
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [editor]);

  // DL: copy deep-link на выделенный объект(ы). Default ⇧⌘S (НЕ ⌘⌥C — то
  // перехватывает Chrome/macOS как "Inspect Element" до страницы). Remappable.
  // Capture phase: tldraw's input system слушает keydown первым; match по e.code.
  useEffect(() => {
    if (!editor) return;
    const handler = (e: KeyboardEvent) => {
      // Shortcut registry: read the active binding at event time.
      if (!matchShortcut(getActiveBinding("copy-link"), e)) return;
      const ids = editor.getSelectedShapeIds() as unknown as string[];
      if (ids.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      onCopyObjectLink.current?.(ids);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [editor]);

  // DRW-219: ⌘⇧F / Ctrl+Shift+F — обтянуть текст выделенных объектов.
  // Capture phase + ⌘⇧F свободен от браузерных акселераторов (⌘F = find).
  useEffect(() => {
    if (!editor) return;
    const handler = (e: KeyboardEvent) => {
      if (!matchShortcut(getActiveBinding("fit-text"), e)) return;
      const ids = editor.getSelectedShapeIds() as unknown as string[];
      if (ids.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      applyTextFitToSelection(editor, ids);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [editor]);

  // ⌘⇧E / Ctrl+Shift+E — open Export to Miro modal for current selection.
  useEffect(() => {
    const handler = makeExportHotkeyHandler(
      () =>
        editor ? (editor.getSelectedShapeIds() as unknown as string[]) : [],
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
        if (!editor)
          return {
            hasSelection: false,
            mode: "none",
            shapeIds: [],
            arrowIds: [],
          };
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
    // DL: deep-link focus retry timer — cancel on cleanup.
    let deepLinkRetryTimer: ReturnType<typeof setTimeout> | undefined;

    // DRW-047 + DRW-018: upload our V2 schema (best-effort), then fetch /api/state
    // and apply via mergeRemoteChanges. Shared by initial hydrate and truncated-recovery.
    const fetchAndLoadSnapshot = async (): Promise<{
      version: number;
    } | null> => {
      try {
        await seedSchema(space, room, editor.store.schema.serialize());
      } catch {
        // network blip; getState path handles legacy placeholder rooms too.
      }
      const s = await getState(space, room);
      if (!active) return null;
      const snapshot = {
        ...s.store,
        store: backfillStoreRecords(s.store?.store),
      };
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
      // Core B: elkjs re-layout (replaces legacy backend dagre tidy).
      const result = await autoLayoutFrame(editor, ids as unknown as TLShapeId[]);
      if (result.kind === "ok") {
        maybeZoomToAffected(editor, result.affected, inProgrammaticCameraOp);
      } else if (result.kind === "error") {
        console.warn("[elk-layout] failed", result.message);
      }
    };

    // DL: copy deep-link на выделенный объект(ы) → clipboard + toast.
    onCopyObjectLink.current = async (ids: string[]) => {
      const shapes = (ids as unknown as TLShapeId[])
        .map((id) => editor.getShape(id))
        .filter((s): s is NonNullable<typeof s> => s !== undefined);
      if (shapes.length === 0) return;
      const url = buildObjectLink({
        origin: location.origin,
        pathname: location.pathname,
        space,
        room,
        shapes,
      });
      try {
        await navigator.clipboard.writeText(url);
        toastRef.current?.(
          shapes.length > 1
            ? `Ссылка на объекты скопирована (${shapes.length})`
            : "Ссылка на объект скопирована",
          "success",
        );
      } catch {
        toastRef.current?.("Не удалось скопировать ссылку", "error");
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
        const name = (shape?.meta as Record<string, unknown> | undefined)
          ?.didrawName;
        return typeof name === "string" ? name : "";
      });

      // DRW-086: animate viewport to new shapes (or fit-all), unless user
      // has manually panned (DRW-075 guard) or focus='none'.
      if (
        focus !== "none" &&
        !userHasManuallyPanned.current &&
        result.shapeIds.length > 0
      ) {
        inProgrammaticCameraOp.current = true;
        if (focus === "fit-all") {
          editor.zoomToFit({ animation: { duration: 200 } });
        } else {
          // focus === "new" (default)
          const bounds = unionBoundsOf(editor, result.shapeIds);
          if (bounds) {
            editor.zoomToBounds(bounds, {
              animation: { duration: 200 },
              inset: 64,
            });
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

    // DRW-228: backend-routed fit-text command (shemma_fit_text). Fits the
    // given targets (shape ids / didrawName / didrawId / didrawLabel) to their
    // text; omitted → all fittable geo/note shapes the user hasn't size-pinned.
    // Respects size-pins (pin discipline): a user's manual resize and an
    // already-fitted box are skipped — so the main use is filling in default-
    // sized shapes after a fresh tab load (snapshot load doesn't fire the
    // auto-fit listener).
    const runTextFit = async (
      targets: string[] | undefined,
      _requestId: string,
    ) => {
      const all = editor.getCurrentPageShapes();
      let pool = all;
      if (targets && targets.length > 0) {
        const wanted = new Set(targets);
        pool = all.filter((s) => {
          if (wanted.has(s.id as unknown as string)) return true;
          const m = s.meta as Record<string, unknown> | undefined;
          return (
            (typeof m?.didrawName === "string" && wanted.has(m.didrawName)) ||
            (typeof m?.didrawId === "string" && wanted.has(m.didrawId)) ||
            (typeof m?.didrawLabel === "string" && wanted.has(m.didrawLabel))
          );
        });
      }
      const fittedIds: string[] = [];
      editor.run(() => {
        editor.markHistoryStoppingPoint("fit-text-mcp");
        for (const s of pool) {
          const pinned =
            (s.meta as Record<string, unknown> | undefined)
              ?.didrawSizePinned === true;
          if (pinned) continue;
          // applyTextFitToShape further filters type (geo/note) + non-empty text.
          if (applyTextFitToShape(editor, s)) {
            fittedIds.push(s.id as unknown as string);
          }
        }
      });
      return { ok: true, count: fittedIds.length, shapeIds: fittedIds };
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
      //
      // DL: deep-link на объект (?id=…) перебивает saved-camera/zoomToFit —
      // явный фокус важнее восстановленного вида. v2-дети могут ещё приезжать
      // по WS → один отложенный ретрай, затем toast если так и не нашли.
      const deepLinkTokens = parseIdParam(
        new URLSearchParams(location.search).get("id"),
      );
      const cam = loadCamera(room);
      inProgrammaticCameraOp.current = true;
      if (deepLinkTokens.length > 0) {
        const focused = focusDeepLinkShapes(
          editor,
          resolveUrlIds(editor.getCurrentPageShapes(), deepLinkTokens),
        );
        // Явный фокус → камера «занята» пользователем, AI-fit её не трогает.
        userHasManuallyPanned.current = true;
        if (!focused) {
          deepLinkRetryTimer = setTimeout(() => {
            deepLinkRetryTimer = undefined;
            if (!active) return;
            const ok = focusDeepLinkShapes(
              editor,
              resolveUrlIds(editor.getCurrentPageShapes(), deepLinkTokens),
            );
            if (!ok) {
              toastRef.current?.(
                `Объект не найден: ${deepLinkTokens.join(", ")}`,
                "warning",
              );
            }
          }, 700);
        }
      } else if (cam) {
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
          onFitText: runTextFit,
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
      if (deepLinkRetryTimer) {
        clearTimeout(deepLinkRetryTimer);
        deepLinkRetryTimer = undefined;
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
              onSubmit={async (source, engine) => {
                try {
                  await importMermaidWithEngine(editor, source, engine);
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
          <ThemeToggleButtonContainer />
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
        tools={[SchemaContainerTool]}
        overrides={tldrawUiOverrides}
        assetUrls={SHEMMA_ASSET_URLS}
        // DRW-217: initial цветовая схема из shemma:theme (SSOT) — стабильный
        // prop (не меняется на лету, иначе editor пересоздаётся). Runtime-смена —
        // updateUserPreferences в theme-sync effect ниже.
        colorScheme={initialColorScheme}
        onMount={(ed) => {
          setEditor(ed);
          // DRW-217: принудительный sync tldraw-prefs с нашим SSOT — tldraw
          // хранит собственный colorScheme в localStorage prefs, который может
          // перекрыть проп; выравниваем при mount.
          ed.user.updateUserPreferences({ colorScheme: themeMode });
          // DRW-150: store disposer to prevent listener accumulation on HMR/room-switch
          autoFlipDisposerRef.current?.();
          autoFlipDisposerRef.current = registerAutoFlipDirection(ed);
          // DRW-180 style-propagation Task 9: bidirectional sync board defaults ↔
          // editor.stylesForNextShape + container resolution chain at create-time.
          styleSyncDisposerRef.current?.();
          styleSyncDisposerRef.current = registerStyleDefaultsSync(
            ed,
            space,
            room,
          );
          // DRW-185: auto-pin on drag/resize end.
          pinAutoToggleDisposerRef.current?.();
          pinAutoToggleDisposerRef.current = registerPinAutoToggle(ed);
          // DRW-190: auto-pin arrow endpoint anchors on manual drag.
          arrowAnchorPinDisposerRef.current?.();
          arrowAnchorPinDisposerRef.current = registerArrowAnchorPin(ed);
          // DRW-186 frame-scope: inherit titlePosition из parent Frame.meta при создании SchemaContainer'а.
          titlePosInheritDisposerRef.current?.();
          titlePosInheritDisposerRef.current =
            registerContainerTitlePositionInherit(ed);
          // DRW-194: regenerate colliding didrawId on local duplicate/paste.
          didrawDedupDisposerRef.current?.();
          didrawDedupDisposerRef.current = registerDidrawIdDedup(ed);
          // DRW-228: event-driven text-fit — size geo/note to its text on
          // add (incl. AI/remote) and on editing-end (skips mid-typing).
          autoTextFitDisposerRef.current?.();
          autoTextFitDisposerRef.current = registerAutoTextFit(ed);
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
            // Autolayout rebuild: write the direction meta locally (no backend
            // layout POST) then re-flow with elk so the schema rebuilds *and*
            // lays out in one action — no extra ⌘⇧L needed.
            setContainerDirection(ed, ids, direction, { triggerLayout: false });
            autoElkLayout(ed, ids as unknown as TLShapeId[]);
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
