import { useEffect, useRef, useState } from "react";
import type { Editor } from "tldraw";
import { getActiveBinding } from "./shortcuts/config";
import { matchShortcut } from "./shortcuts/match";

export type Anchor = { x: number; y: number; w?: number; h?: number };

export type Target =
  | { kind: "board"; anchor: Anchor }
  | { kind: "selection"; anchor: Anchor }
  | { kind: "node"; subjectId: string; anchor: Anchor }
  | { kind: "empty"; anchor: Anchor };

export type ResolveInput = {
  hit: { id: string; type: string; meta?: Record<string, unknown> } | null;
  selectedIds: string[];
  pointerScreen: { x: number; y: number };
  bbox: (ids: string[]) => Anchor | null;
};

export function resolveTarget(input: ResolveInput): Target | null {
  const { hit, selectedIds, pointerScreen, bbox } = input;

  if (hit && selectedIds.includes(hit.id) && selectedIds.length > 1) {
    const a = bbox(selectedIds);
    if (!a) return null;
    return { kind: "selection", anchor: a };
  }
  if (hit) {
    // DRW-186 frame-scope: Frame trated as "selection" target — popover показывает
    // SelectionPanel, который single-frame detection делает через editor.getSelectedShapes().
    if (hit.type === "schema-container" || hit.type === "frame") {
      const a = bbox([hit.id]);
      if (!a) return null;
      return { kind: "selection", anchor: a };
    }
    if (hit.meta?.didrawId || hit.meta?.didrawName) {
      const a = bbox([hit.id]);
      if (!a) return null;
      return { kind: "node", subjectId: hit.id, anchor: a };
    }
    return null;
  }
  if (selectedIds.length >= 1) {
    const a = bbox(selectedIds);
    if (!a) return null;
    return { kind: "selection", anchor: a };
  }
  return { kind: "board", anchor: pointerScreen };
}

export type AmbientShape = {
  id: string;
  type: string;
  meta?: Record<string, unknown>;
};

export type AmbientInput = {
  selectedShapes: ReadonlyArray<AmbientShape>;
  bbox: (ids: string[]) => Anchor | null;
};

/**
 * resolveAmbientTarget — pinned-mode resolver. Unlike resolveTarget (which
 * keys off a pointer hit), this maps current selection state to a Target
 * suitable for the persistent floating panel. No selection → BoardPanel.
 */
export function resolveAmbientTarget(input: AmbientInput): Target {
  const { selectedShapes, bbox } = input;
  const placeholderAnchor: Anchor = { x: 0, y: 0 };
  if (selectedShapes.length === 0) {
    return { kind: "board", anchor: placeholderAnchor };
  }
  if (selectedShapes.length === 1) {
    const s = selectedShapes[0]!;
    if (
      s.type !== "schema-container" &&
      (s.meta?.didrawId || s.meta?.didrawName)
    ) {
      const a = bbox([s.id]);
      return { kind: "node", subjectId: s.id, anchor: a ?? placeholderAnchor };
    }
    const a = bbox([s.id]);
    return { kind: "selection", anchor: a ?? placeholderAnchor };
  }
  const a = bbox(selectedShapes.map((s) => s.id));
  return { kind: "selection", anchor: a ?? placeholderAnchor };
}

export type TriggerState = {
  target: Target | null;
};

// DRW-185: default-pinned mode — popover открывается в закреплённом состоянии.
// User может вернуть к floating через close button (на pinned клик закрывает popover).
// Persistence не реализована (YAGNI) — каждая сессия начинается с этим default.
export const SETTINGS_POPOVER_DEFAULT_PINNED = true;

export function useSettingsTrigger(editor: Editor | null): TriggerState & {
  close: () => void;
  pinned: boolean;
  setPinned: (next: boolean) => void;
} {
  const [target, setTarget] = useState<Target | null>(null);
  const [pinned, setPinnedState] = useState(SETTINGS_POPOVER_DEFAULT_PINNED);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  // DRW-186: targetRef нужен в store.listen — без него закрытый popover
  // авто-открывался на первой смене selection (pinned=true default).
  // Гейт: store.listen обновляет target только если popover УЖЕ открыт.
  // Opt+RightClick — единственный способ открыть.
  const targetRef = useRef(target);
  targetRef.current = target;

  const setPinned = (next: boolean) => setPinnedState(next);

  useEffect(() => {
    if (!editor) return;

    let prevCamera = editor.getCamera();
    let prevSelection = (
      editor.getSelectedShapeIds() as unknown as string[]
    ).join(",");
    let armed = false;

    function dismissExternalMenus() {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      document.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Escape", bubbles: true }),
      );
    }

    function onPointerDown(e: PointerEvent) {
      if (e.altKey && e.button === 2) {
        dismissExternalMenus();
        armed = true;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      } else {
        armed = false;
      }
    }

    function onPointerUp(e: PointerEvent) {
      if (!armed) return;
      armed = false;
      if (!e.altKey || e.button !== 2) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const ed = editorRef.current;
      if (!ed) return;

      // DRW-186: каждый Opt+RightClick перезапускает popover в default-pinned
      // состоянии. Иначе после close() (который sets pinned=false) следующий
      // Opt+RightClick открывал unpinned.
      setPinnedState(SETTINGS_POPOVER_DEFAULT_PINNED);
      const screen = { x: e.clientX, y: e.clientY };
      const viewportBounds = ed.getViewportScreenBounds();
      if (
        screen.x < viewportBounds.x ||
        screen.x > viewportBounds.x + viewportBounds.w ||
        screen.y < viewportBounds.y ||
        screen.y > viewportBounds.y + viewportBounds.h
      ) {
        return;
      }

      const page = ed.screenToPage(screen);
      const hit = ed.getShapeAtPoint(page);
      // DRW-186 frame-scope: если Opt+RightClick попал по Frame или SchemaContainer'у
      // и этот shape сейчас НЕ в selection — выставляем его как single-selection.
      // Иначе SelectionPanel internals (singleContainer / singleFrame) не увидят
      // shape через editor.getSelectedShapes().
      if (
        hit &&
        (hit.type === "frame" || hit.type === "schema-container") &&
        !ed.getSelectedShapeIds().includes(hit.id)
      ) {
        ed.setSelectedShapes([hit.id]);
      }
      const selected = ed.getSelectedShapeIds() as unknown as string[];

      const result = resolveTarget({
        hit: hit
          ? {
              id: hit.id,
              type: hit.type,
              meta: hit.meta as Record<string, unknown>,
            }
          : null,
        selectedIds: selected,
        pointerScreen: screen,
        bbox: (ids) => {
          if (ids.length === 0) return null;
          if (ids.length === 1) {
            const b = ed.getShapePageBounds(ids[0] as never);
            if (!b) return null;
            const tl = ed.pageToScreen({ x: b.x, y: b.y });
            const br = ed.pageToScreen({ x: b.x + b.w, y: b.y + b.h });
            return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
          }
          const b = ed.getSelectionPageBounds();
          if (!b) return null;
          const tl = ed.pageToScreen({ x: b.x, y: b.y });
          const br = ed.pageToScreen({ x: b.x + b.w, y: b.y + b.h });
          return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
        },
      });
      prevCamera = ed.getCamera();
      prevSelection = (ed.getSelectedShapeIds() as unknown as string[]).join(
        ",",
      );
      setTarget(result);
    }

    function suppressIfArmed(e: Event) {
      const me = e as MouseEvent;
      if (me.altKey) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setTarget(null);
    }

    // ⌘⇧P / Ctrl+Shift+P — toggle the settings panel (open in default-pinned mode
    // targeting the current selection, or close if already open). Capture phase +
    // preventDefault so tldraw's shortcut router doesn't swallow it.
    function onToggleKey(e: KeyboardEvent) {
      // Shortcut registry: read the active binding at event time.
      if (!matchShortcut(getActiveBinding("settings-popover"), e)) return;
      e.preventDefault();
      e.stopPropagation();
      const ed = editorRef.current;
      if (!ed) return;
      if (targetRef.current !== null) {
        setPinnedState(false);
        setTarget(null);
        return;
      }
      setPinnedState(SETTINGS_POPOVER_DEFAULT_PINNED);
      const selectedShapes = ed.getSelectedShapes().map((s) => ({
        id: s.id as unknown as string,
        type: s.type,
        meta: s.meta as Record<string, unknown> | undefined,
      }));
      setTarget(resolveAmbientTarget({ selectedShapes, bbox: makeBbox(ed) }));
    }

    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("pointerup", onPointerUp, { capture: true });
    window.addEventListener("mousedown", suppressIfArmed as EventListener, {
      capture: true,
    });
    window.addEventListener("mouseup", suppressIfArmed as EventListener, {
      capture: true,
    });
    window.addEventListener("auxclick", suppressIfArmed as EventListener, {
      capture: true,
    });
    window.addEventListener("contextmenu", suppressIfArmed as EventListener, {
      capture: true,
    });
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onToggleKey, { capture: true });

    function makeBbox(ed: Editor) {
      return (ids: string[]): Anchor | null => {
        if (ids.length === 0) return null;
        if (ids.length === 1) {
          const b = ed.getShapePageBounds(ids[0] as never);
          if (!b) return null;
          const tl = ed.pageToScreen({ x: b.x, y: b.y });
          const br = ed.pageToScreen({ x: b.x + b.w, y: b.y + b.h });
          return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
        }
        const b = ed.getSelectionPageBounds();
        if (!b) return null;
        const tl = ed.pageToScreen({ x: b.x, y: b.y });
        const br = ed.pageToScreen({ x: b.x + b.w, y: b.y + b.h });
        return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
      };
    }

    const dispose = editor.store.listen(
      () => {
        const ed = editorRef.current;
        if (!ed) return;
        const cam = ed.getCamera();
        const sel = (ed.getSelectedShapeIds() as unknown as string[]).join(",");
        const cameraChanged =
          cam.x !== prevCamera.x ||
          cam.y !== prevCamera.y ||
          cam.z !== prevCamera.z;
        const selectionChanged = sel !== prevSelection;
        prevCamera = cam;
        prevSelection = sel;
        if (!cameraChanged && !selectionChanged) return;

        if (pinnedRef.current) {
          if (!selectionChanged) return;
          // Гейт: не открываем popover автоматически. Только tracking
          // существующего открытого popover'а при смене selection.
          if (targetRef.current === null) return;
          const selectedShapes = ed.getSelectedShapes().map((s) => ({
            id: s.id as unknown as string,
            type: s.type,
            meta: s.meta as Record<string, unknown> | undefined,
          }));
          const next = resolveAmbientTarget({
            selectedShapes,
            bbox: makeBbox(ed),
          });
          setTarget(next);
          return;
        }
        setTarget(null);
      },
      { scope: "session" },
    );

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
      window.removeEventListener("pointerup", onPointerUp, { capture: true });
      window.removeEventListener(
        "mousedown",
        suppressIfArmed as EventListener,
        { capture: true },
      );
      window.removeEventListener("mouseup", suppressIfArmed as EventListener, {
        capture: true,
      });
      window.removeEventListener("auxclick", suppressIfArmed as EventListener, {
        capture: true,
      });
      window.removeEventListener(
        "contextmenu",
        suppressIfArmed as EventListener,
        { capture: true },
      );
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onToggleKey, { capture: true });
      dispose();
    };
  }, [editor]);

  return {
    target,
    close: () => {
      setPinnedState(false);
      setTarget(null);
    },
    pinned,
    setPinned,
  };
}
