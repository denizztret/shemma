import type {
  ArrowKind,
  LayoutAlgorithm,
  LayoutParams,
  ResolvedStyleDefaults,
  Role,
  StyleDash,
  StyleDefaults,
  StyleFont,
  StyleSize,
} from "@shemma/domain";
import { DEFAULT_STYLE_DEFAULTS } from "@shemma/domain";
import { type FC, useEffect, useRef, useState } from "react";
import { type Editor, type TLShapeId, useEditor, useValue } from "tldraw";
import {
  applyRespread,
  autoElkLayout,
  autoLayoutFrame,
  captureRespreadSnapshot,
  type RespreadSnapshot,
} from "../canvas/elk-layout";
import { setContainerLayoutParams } from "../shapes/container-layout-params";
import {
  type StyleStateInput,
  type UnifiedStyleState,
  deriveUnifiedStyleState,
} from "../shapes/derive-unified-style-state";
import { SettingsTriggerButton } from "./SettingsTriggerButton";
import { setContainerDirection } from "../shapes/schema-container/SchemaContainerActions";
import type { SchemaContainerShape } from "../shapes/schema-container/SchemaContainerShape";
import {
  type SchemaContainerTitlePosition,
  normalizeTitlePosition,
} from "../shapes/schema-container/title-position";
import { fitTextWithReflow } from "../canvas/apply-text-fit";
import {
  applyStyleToSelection,
  collectDescendantIds,
} from "../shapes/style-apply";
import {
  type LayoutParamsResponse,
  type StyleDefaultsResponse,
  getContainerTitlePosition,
  getLayoutParams,
  getStyleDefaults,
  postContainerTitlePosition,
  postLayoutParams,
  postStyleDefaults,
} from "./api";
import { BoardPanel } from "./panels/BoardPanel";
import { BoardPanelAdvanced } from "./panels/BoardPanelAdvanced";
import { NodePanel } from "./panels/NodePanel";
import { SelectionPanel } from "./panels/SelectionPanel";
import { ShortcutsPanel } from "./panels/ShortcutsPanel";
import { computePopoverPosition } from "./position";
import type { LayoutSettingsValue } from "./sections/LayoutSettingsSection";
import { type PinTriState, aggregatePinState } from "./sections/PinSection";
import { useAltHeld } from "./useAltHeld";
import { useSettingsTrigger } from "./useSettingsTrigger";

export type SettingsPopoverProps = { space: string; room: string };

const POPOVER_SIZE = { width: 240, height: 280 };
const ADVANCED_SIZE = { width: 320, height: 480 };
const SHORTCUTS_SIZE = { width: 320, height: 480 };

const isContainerShape = (s: { type: string }): boolean =>
  s.type === "schema-container" || s.type === "frame";

/**
 * Which shapes the pin buttons act on.
 *  - single frame/container selected → its *contents* (descendant geo/containers);
 *    Opt (`alt`) targets the frame/container itself instead.
 *  - any other selection → the selected shapes themselves (Opt has no effect).
 */
function pinTargetIds(editor: Editor, alt: boolean): string[] {
  const selected = editor.getSelectedShapes() as unknown as Array<{
    id: string;
    type: string;
  }>;
  const single = selected.length === 1 && isContainerShape(selected[0]!);
  if (single) {
    const root = selected[0]!;
    if (alt) return [root.id];
    const desc = [...collectDescendantIds(editor, [root.id])].filter((id) => {
      if (id === root.id) return false;
      const t = editor.getShape(id as TLShapeId)?.type;
      return t === "geo" || t === "schema-container";
    });
    return desc.length > 0 ? desc : [root.id];
  }
  return selected.map((s) => s.id);
}

/**
 * The locked frame that the current selection belongs to (the selected frame
 * itself, or a locked ancestor frame of a selected node/container) — else null.
 * Drives collapsing the panel to just «Разблокировать» so no stale layout meta
 * can be written while locked.
 */
function lockedAncestorFrame(
  editor: Editor,
  ids: string[],
): { id: string; meta?: Record<string, unknown> } | null {
  for (const id of ids) {
    let cur = editor.getShape(id as TLShapeId) as
      | {
          id: string;
          type: string;
          parentId: string;
          meta?: Record<string, unknown>;
        }
      | undefined;
    while (cur) {
      if (cur.type === "frame" && cur.meta?.didrawLocked === true) return cur;
      cur = cur.parentId.startsWith("shape:")
        ? (editor.getShape(cur.parentId as TLShapeId) as typeof cur)
        : undefined;
    }
  }
  return null;
}

export const SettingsPopover: FC<SettingsPopoverProps> = ({ space, room }) => {
  const editor = useEditor();
  const { target, close, pinned, setPinned, toggle } =
    useSettingsTrigger(editor);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [advanced, setAdvanced] = useState(false);
  // Shortcuts drill-down (global keyboard-shortcut remapping) on the board panel.
  const [shortcuts, setShortcuts] = useState(false);
  const [boardParams, setBoardParams] = useState<LayoutParamsResponse | null>(
    null,
  );
  const [styleDefaults, setStyleDefaults] =
    useState<StyleDefaultsResponse | null>(null);
  const [containerTitlePosition, setContainerTitlePosition] =
    useState<SchemaContainerTitlePosition>("inside-center");
  const [pending, setPending] = useState<"tidy" | "force-unpin" | null>(null);
  const [userPos, setUserPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!target) {
      setAdvanced(false);
      setShortcuts(false);
      setBoardParams(null);
      setStyleDefaults(null);
      setUserPos(null);
    }
  }, [target]);

  useEffect(() => {
    if (target?.kind === "board") {
      getLayoutParams(space, room)
        .then(setBoardParams)
        .catch(() => setBoardParams(null));
      getStyleDefaults(space, room)
        .then(setStyleDefaults)
        .catch(() => setStyleDefaults(null));
    }
  }, [target, space, room]);

  // Board-default container title position: fetch on mount / room switch.
  useEffect(() => {
    getContainerTitlePosition(space, room)
      .then((r) => setContainerTitlePosition(normalizeTitlePosition(r.value)))
      .catch(() => setContainerTitlePosition("inside-center"));
  }, [space, room]);

  // Mirror current value into editor.documentSettings.meta so SchemaContainerTool
  // can read board-default at shape-creation time via resolveBoardTitlePosition().
  useEffect(() => {
    if (!editor) return;
    const meta = (editor.getDocumentSettings().meta ?? {}) as Record<
      string,
      unknown
    >;
    if (meta.containerTitlePosition !== containerTitlePosition) {
      editor.updateDocumentSettings({
        meta: { ...meta, containerTitlePosition },
      });
    }
  }, [editor, containerTitlePosition]);

  const onContainerTitlePositionChange = async (
    next: SchemaContainerTitlePosition,
  ) => {
    // Optimistic update; revert on POST failure.
    setContainerTitlePosition(next);
    try {
      await postContainerTitlePosition(space, room, next);
    } catch {
      try {
        const r = await getContainerTitlePosition(space, room);
        setContainerTitlePosition(normalizeTitlePosition(r.value));
      } catch {
        setContainerTitlePosition("inside-center");
      }
    }
  };

  useEffect(() => {
    if (!target || pinned) return;
    function onDown(e: PointerEvent) {
      const el = popoverRef.current;
      if (el && !el.contains(e.target as Node)) close();
    }
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [target, pinned, close]);

  useEffect(() => {
    if (!target) return;
    const el = popoverRef.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>(
      'button, input, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusables = Array.from(
        el!.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled])",
        ),
      );
      if (focusables.length === 0) return;
      const firstEl = focusables[0]!;
      const lastEl = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [target]);

  // DRW-206: кнопка ⚙ видна всегда — дискавериваемый вход в панель настроек.
  if (!target) return <SettingsTriggerButton open={false} onToggle={toggle} />;

  async function handleBoardStyle<K extends keyof StyleDefaults>(
    key: K,
    value: NonNullable<StyleDefaults[K]>,
  ) {
    const prev = styleDefaults;
    const nextRaw: StyleDefaults = { ...(prev?.raw ?? {}), [key]: value };
    const nextEffective: ResolvedStyleDefaults = {
      ...(prev?.effective ?? DEFAULT_STYLE_DEFAULTS),
      [key]: value,
    };
    setStyleDefaults({ raw: nextRaw, effective: nextEffective });
    try {
      const r = await postStyleDefaults(space, room, nextRaw);
      setStyleDefaults({ raw: nextRaw, effective: r.effective });
    } catch {
      setStyleDefaults(prev);
    }
  }

  // DRW-207: tri-state — клик по активной кнопке снимает board default
  // (возврат к статус-кво: ручные arc, AI elbow).
  async function handleBoardArrowKind(value: ArrowKind) {
    const prev = styleDefaults;
    const prevRaw = prev?.raw ?? {};
    const nextRaw: StyleDefaults = { ...prevRaw };
    if (prevRaw.arrowKind === value) {
      delete nextRaw.arrowKind;
    } else {
      nextRaw.arrowKind = value;
    }
    const nextEffective: ResolvedStyleDefaults = {
      ...(prev?.effective ?? DEFAULT_STYLE_DEFAULTS),
    };
    if (nextRaw.arrowKind === undefined) {
      delete nextEffective.arrowKind;
    } else {
      nextEffective.arrowKind = nextRaw.arrowKind;
    }
    setStyleDefaults({ raw: nextRaw, effective: nextEffective });
    try {
      const r = await postStyleDefaults(space, room, nextRaw);
      setStyleDefaults({ raw: nextRaw, effective: r.effective });
    } catch {
      setStyleDefaults(prev);
    }
  }

  const size =
    target.kind === "board" && shortcuts
      ? SHORTCUTS_SIZE
      : target.kind === "board" && advanced
        ? ADVANCED_SIZE
        : POPOVER_SIZE;
  // DRW-188/DRW-189: editor.getViewportScreenBounds() returns canvas-area
  // BUT chrome (Menu / Page / Undo / etc.) рендерится поверх canvas — vp.y=0.
  // Query .tlui-menu-zone (top-left chrome group) bottom edge через DOM,
  // чтобы поместить popover НИЖЕ chrome с видимым gap (margin handles gap).
  const vp = editor.getViewportScreenBounds();
  const chromeZone = document.querySelector(".tlui-menu-zone");
  const chromeBottom =
    chromeZone instanceof HTMLElement
      ? chromeZone.getBoundingClientRect().bottom
      : 0;
  const topOffset = Math.max(vp.y, chromeBottom);
  const anchoredPos = computePopoverPosition({
    anchor: target.anchor,
    popoverSize: size,
    viewport: { width: vp.w, height: vp.h, top: topOffset, left: vp.x },
    margin: 16,
  });
  const pos = userPos ?? anchoredPos;

  function onDragStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = userPos ?? anchoredPos;
    const margin = 8;
    const clamp = (x: number, y: number) => ({
      x: Math.max(margin, Math.min(x, window.innerWidth - size.width - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - margin - 32)),
    });
    function onMove(ev: PointerEvent) {
      setUserPos(
        clamp(
          origin.x + (ev.clientX - startX),
          origin.y + (ev.clientY - startY),
        ),
      );
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <>
      <SettingsTriggerButton open onToggle={toggle} />
      <div
      ref={popoverRef}
      className="settings-popover"
      style={{
        position: "absolute",
        left: pos.x,
        top: pos.y,
        width: size.width,
        pointerEvents: "auto",
        zIndex: 1,
      }}
    >
      <div className="settings-popover__top-bar">
        <div
          className="settings-popover__drag-handle"
          onPointerDown={onDragStart}
          title="Перетащить"
          aria-hidden="true"
        >
          <span className="settings-popover__drag-dots">⋯</span>
        </div>
        <button
          type="button"
          className={`settings-popover__pin-btn${pinned ? " settings-popover__pin-btn--on" : ""}`}
          onClick={() => {
            if (pinned) {
              close();
            } else {
              setUserPos(pos);
              setPinned(true);
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          title={
            pinned
              ? "Закрыть"
              : "Закрепить — менюшка останется открытой, контент будет меняться по выделению"
          }
          aria-pressed={pinned}
          aria-label={pinned ? "Закрыть" : "Закрепить"}
        >
          {pinned ? "✕" : "📌"}
        </button>
      </div>
      {target.kind === "empty" && (
        <div
          className="settings-popover__panel settings-popover__panel--empty"
          role="status"
        >
          <div className="settings-popover__empty">
            Для текущего выделения нет настраиваемых параметров
          </div>
        </div>
      )}
      {target.kind === "selection" && (
        <SelectionPanelContainer
          editor={editor}
          space={space}
          room={room}
          pending={pending}
          setPending={setPending}
        />
      )}
      {target.kind === "node" && (
        <NodePanelContainer editor={editor} subjectId={target.subjectId} />
      )}
      {target.kind === "board" && !advanced && !shortcuts && boardParams && (
        <BoardPanel
          effective={boardParams.effective}
          onDirectionChange={async (d) => {
            if (d === "custom") return;
            const next = {
              ...(boardParams.raw ?? {}),
              defaultDirection: d,
            } as Partial<LayoutParams>;
            setBoardParams({
              raw: next,
              effective: { ...boardParams.effective, defaultDirection: d },
            });
            try {
              const r = await postLayoutParams(space, room, next);
              setBoardParams({ raw: next, effective: r.effective });
            } catch {
              setBoardParams(boardParams);
            }
          }}
          onOpenAdvanced={() => setAdvanced(true)}
          onOpenShortcuts={() => setShortcuts(true)}
          styleEffective={styleDefaults?.effective ?? DEFAULT_STYLE_DEFAULTS}
          onStyleDash={(v) => handleBoardStyle("dash", v)}
          onStyleFont={(v) => handleBoardStyle("font", v)}
          onStyleSize={(v) => handleBoardStyle("size", v)}
          styleArrowKind={styleDefaults?.raw?.arrowKind ?? null}
          onStyleArrowKind={(v) => handleBoardArrowKind(v)}
          containerTitlePosition={containerTitlePosition}
          onContainerTitlePositionChange={onContainerTitlePositionChange}
        />
      )}
      {target.kind === "board" && advanced && !shortcuts && boardParams && (
        <BoardPanelAdvanced
          effective={boardParams.effective}
          onFieldChange={async (field, value) => {
            const next = { ...(boardParams.raw ?? {}), [field]: value };
            setBoardParams({
              raw: next,
              effective: { ...boardParams.effective, [field]: value },
            });
            try {
              const r = await postLayoutParams(space, room, next);
              setBoardParams({ raw: next, effective: r.effective });
            } catch {
              setBoardParams(boardParams);
            }
          }}
          onReset={async () => {
            try {
              const r = await postLayoutParams(space, room, null);
              setBoardParams({ raw: null, effective: r.effective });
            } catch {
              /* keep */
            }
          }}
          onBack={() => setAdvanced(false)}
        />
      )}
      {target.kind === "board" && shortcuts && (
        <ShortcutsPanel onBack={() => setShortcuts(false)} />
      )}
      </div>
    </>
  );
};

const SelectionPanelContainer: FC<{
  editor: Editor;
  space: string;
  room: string;
  pending: "tidy" | "force-unpin" | null;
  setPending: (p: "tidy" | "force-unpin" | null) => void;
}> = ({ editor, space, room, pending, setPending }) => {
  // DRW-239: per-gesture snapshot for the density slider — captured at pointer-down
  // so a live drag scales the START layout (not the compounding current one).
  const densitySnapshotRef = useRef<RespreadSnapshot | null>(null);
  const counts = useValue(
    "selectionCounts",
    () => {
      const selected = editor.getSelectedShapes() as unknown as Array<{
        type: string;
      }>;
      const containers = selected.filter(isContainerShape).length;
      return { containers, nodes: selected.length - containers };
    },
    [editor],
  );

  const showContainerSections = counts.containers > 0 && counts.nodes === 0;
  // DRW-239: density respread applies to any respreadable selection — a
  // container/frame, OR ≥2 loose nodes (a single node has nothing to spread).
  const showDensity = counts.containers > 0 || counts.nodes >= 2;

  const direction = useValue(
    "dir",
    () => {
      const containers = (
        editor.getSelectedShapes() as unknown as Array<{
          type: string;
          props?: { direction?: string };
          meta?: { didrawDirection?: string; didrawDirectionInherited?: boolean };
        }>
      ).filter(isContainerShape);
      if (containers.length === 0) return null;
      const readDir = (s: {
        type: string;
        props?: { direction?: string };
        meta?: { didrawDirection?: string; didrawDirectionInherited?: boolean };
      }) =>
        s.type === "schema-container"
          ? // Inherited-placeholder marker → show "custom" (the "•" inherit state),
            // not the structural props.direction default ("TB").
            s.meta?.didrawDirectionInherited === true
            ? "custom"
            : (s.props?.direction ?? null)
          : // Frame: no pinned direction (null / unset) → "custom" so the «•» (auto)
            // button highlights. autoLayoutFrame picks the direction in that state.
            (s.meta?.didrawDirection ?? "custom");
      const first = readDir(containers[0]!);
      return containers.every((c) => readDir(c) === first) ? first : null;
    },
    [editor],
  ) as "TB" | "LR" | "BT" | "RL" | "custom" | null;

  // Spec 7.3: aggregate layout-params overrides across selected containers.
  // null per field = mixed / indeterminate (rendered as "Avto-направление: —" etc.).
  const layoutSettings = useValue<LayoutSettingsValue>(
    "layoutSettings",
    () => {
      const containers = (
        editor.getSelectedShapes() as unknown as Array<{
          type: string;
          meta?: { didrawLayoutParams?: Record<string, unknown> };
        }>
      ).filter(isContainerShape);
      if (containers.length === 0) {
        return {
          preset: null,
          engine: null,
        };
      }

      const readSpacing = (s: {
        meta?: { didrawLayoutParams?: Record<string, unknown> };
      }): "compact" | "normal" | "loose" | null => {
        const v = s.meta?.didrawLayoutParams?.spacing;
        return v === "compact" || v === "normal" || v === "loose" ? v : null;
      };
      const readEngine = (s: {
        meta?: { didrawLayoutParams?: Record<string, unknown> };
      }): LayoutAlgorithm | null => {
        const v = s.meta?.didrawLayoutParams?.layoutEngine;
        return v === "layered" || v === "mrtree" || v === "stress" || v === "force"
          ? v
          : null;
      };

      const spaces = containers.map(readSpacing);
      const engines = containers.map(readEngine);

      const allSame = <T,>(arr: T[]): T | null =>
        arr.length > 0 && arr.every((v) => v === arr[0]) ? arr[0]! : null;

      return {
        preset: allSame(spaces),
        engine: allSame(engines),
      };
    },
    [editor],
  );

  // Show Reset link if ANY selected container has an explicit meta.didrawLayoutParams override.
  const showReset = useValue(
    "showReset",
    () => {
      const containers = (
        editor.getSelectedShapes() as unknown as Array<{
          type: string;
          meta?: { didrawLayoutParams?: unknown };
        }>
      ).filter(isContainerShape);
      return containers.some((s) => {
        const lp = s.meta?.didrawLayoutParams;
        return lp !== undefined && lp !== null;
      });
    },
    [editor],
  );

  // Opt held → pin buttons act on (and reflect) the frame/container itself; the
  // section header swaps to match. Otherwise they act on the contents/selection.
  const altHeld = useAltHeld();
  const pin = useValue(
    "pin",
    () => {
      const ids = pinTargetIds(editor, altHeld);
      const shapes = ids
        .map((id) => editor.getShape(id as TLShapeId))
        .filter(Boolean) as Array<{
        meta?: { pinned?: boolean; didrawSizePinned?: boolean };
      }>;
      const values: { size: PinTriState; position: PinTriState } = {
        size: aggregatePinState(
          shapes.map((s) => s.meta?.didrawSizePinned === true),
        ),
        position: aggregatePinState(shapes.map((s) => s.meta?.pinned === true)),
      };
      // Header communicates the scope (kept clearer than «Все размеры»).
      const sel = editor.getSelectedShapes() as unknown as Array<{
        type: string;
      }>;
      const singleContainerLike = sel.length === 1 && isContainerShape(sel[0]!);
      let header = "Размеры и позиции объектов";
      if (singleContainerLike && altHeld) {
        header =
          sel[0]!.type === "frame"
            ? "Размер и позиция фрейма"
            : "Размер и позиция контейнера";
      }
      return { values, header };
    },
    [editor, altHeld],
  );

  // If the selection is (or sits inside) a locked frame, the panel collapses to
  // just «Разблокировать» — no layout meta can be written while locked.
  const lockedFrame = useValue(
    "lockedFrame",
    () => lockedAncestorFrame(editor, editor.getSelectedShapeIds()),
    [editor],
  );
  const onUnlockFrame = () => {
    if (!lockedFrame) return;
    editor.updateShape({
      id: lockedFrame.id as never,
      type: "frame" as never,
      meta: { ...(lockedFrame.meta ?? {}), didrawLocked: false },
      // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
    } as any);
  };

  // Style section: visible if selection contains ≥1 frame/schema-container.
  const showStyles = useValue(
    "showStyles",
    () => {
      const selected = editor.getSelectedShapes() as unknown as Array<{
        type: string;
      }>;
      return selected.some(isContainerShape);
    },
    [editor],
  );

  // DRW-207: переключатель типа стрелок — виден когда выделение (включая
  // потомков контейнеров/фреймов) содержит ≥1 стрелку.
  const showArrowKind = useValue(
    "showArrowKind",
    () => {
      const selectedIds = editor.getSelectedShapeIds() as unknown as string[];
      if (selectedIds.length === 0) return false;
      const visited = collectDescendantIds(editor, selectedIds);
      for (const id of visited) {
        const s = editor.getShape(id as never) as { type?: string } | undefined;
        if (s?.type === "arrow") return true;
      }
      return false;
    },
    [editor],
  );

  // DRW-219: «Обтянуть текст» — видна, когда выделение (включая потомков)
  // содержит текстовый объект (geo/note/text).
  const showTextFit = useValue(
    "showTextFit",
    () => {
      const selectedIds = editor.getSelectedShapeIds() as unknown as string[];
      if (selectedIds.length === 0) return false;
      const visited = collectDescendantIds(editor, selectedIds);
      for (const id of visited) {
        const s = editor.getShape(id as never) as { type?: string } | undefined;
        if (s?.type === "geo" || s?.type === "note") return true;
      }
      return false;
    },
    [editor],
  );

  // Per-container titlePosition override (Task 9): visible only when ровно один
  // SchemaContainer выбран. Writeback идёт напрямую в `shape.props.titlePosition`
  // (render-time SSOT по спецификации §Title position resolution).
  const singleContainer = useValue(
    "single-container",
    () => {
      const ids = editor.getSelectedShapeIds();
      if (ids.length !== 1) return null;
      const shape = editor.getShape(ids[0]!);
      return shape?.type === "schema-container"
        ? (shape as SchemaContainerShape)
        : null;
    },
    [editor],
  );

  const onSingleContainerTitlePositionChange = (
    next: SchemaContainerTitlePosition,
  ) => {
    if (!singleContainer) return;
    editor.updateShape({
      id: singleContainer.id,
      type: "schema-container",
      props: { titlePosition: next },
    });
  };

  // DRW-186 frame-scope: визуально такой же 4-toggle, но scope — bulk-apply
  // на всех SchemaContainer-детей внутри выбранного Frame'а + memo на
  // frame.meta.didrawContainerTitlePosition (используется при создании новых
  // child-контейнеров — см. registerContainerTitlePositionInherit).
  const singleFrame = useValue(
    "single-frame",
    () => {
      const ids = editor.getSelectedShapeIds();
      if (ids.length !== 1) return null;
      const shape = editor.getShape(ids[0]!);
      return shape?.type === "frame"
        ? (shape as {
            id: string;
            type: string;
            meta?: Record<string, unknown>;
          })
        : null;
    },
    [editor],
  );

  const singleFrameContainerTitlePosition:
    | SchemaContainerTitlePosition
    | undefined = singleFrame
    ? normalizeTitlePosition(
        (singleFrame.meta as Record<string, unknown> | undefined)
          ?.didrawContainerTitlePosition,
      )
    : undefined;

  const onSingleFrameContainerTitlePositionChange = (
    next: SchemaContainerTitlePosition,
  ) => {
    if (!singleFrame) return;
    editor.run(() => {
      // 1. Memo на Frame meta — для inheritance newly-created child containers.
      // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
      editor.updateShape({
        id: singleFrame.id as never,
        type: "frame" as never,
        meta: {
          ...(singleFrame.meta ?? {}),
          didrawContainerTitlePosition: next,
        },
      } as any);
      // 2. Bulk-apply ко всем existing SchemaContainer-детям.
      const childIds = editor.getSortedChildIdsForParent(
        singleFrame.id as never,
      );
      for (const childId of childIds) {
        const child = editor.getShape(childId);
        if (child?.type !== "schema-container") continue;
        editor.updateShape({
          id: child.id,
          type: "schema-container",
          props: { titlePosition: next },
        });
      }
    });
  };

  // Frame lock (Task: блокировка фрейма). When on, runElkLayout skips this frame
  // for every trigger. Shown only when a single frame is selected.
  const onFrameLockToggle = () => {
    if (!singleFrame) return;
    const next = !(singleFrame.meta?.didrawLocked === true);
    editor.updateShape({
      id: singleFrame.id as never,
      type: "frame" as never,
      meta: { ...(singleFrame.meta ?? {}), didrawLocked: next },
      // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
    } as any);
  };

  // Derive unified style state from selected + descendants.
  const styleState = useValue<UnifiedStyleState>(
    "styleState",
    () => {
      const selectedIds = editor.getSelectedShapeIds() as unknown as string[];
      if (selectedIds.length === 0)
        return { dash: null, font: null, size: null, arrowKind: null };

      const visited = collectDescendantIds(editor, selectedIds);
      const inputs: StyleStateInput[] = [];
      for (const id of visited) {
        const s = editor.getShape(id as never) as
          | { type: string; props?: Record<string, unknown> }
          | undefined;
        if (!s) continue;
        inputs.push({
          type: s.type,
          props: (s.props ?? {}) as Record<string, unknown>,
        });
      }
      return deriveUnifiedStyleState(inputs);
    },
    [editor],
  );

  // Spec 4.1 + 7.4: writer пишет `meta.didrawLayoutParams = partial` целиком (replace).
  // Если user меняет ONE field — без accumulate он бы потерял остальные overrides.
  // Frontend accumulate: читаем existing override у первого selected container'а и
  // merge'им с новым subset. Multi-selection с different overrides — picked first
  // (acceptable: mixed state UI уже indicated через null в layoutSettings).
  const buildPartial = (
    override: Partial<LayoutParams>,
  ): Partial<LayoutParams> => {
    const sel = editor.getSelectedShapes() as unknown as Array<{
      type: string;
      meta?: { didrawLayoutParams?: Record<string, unknown> };
    }>;
    const firstContainer = sel.find(isContainerShape);
    const current = (firstContainer?.meta?.didrawLayoutParams ??
      {}) as Partial<LayoutParams>;
    return { ...current, ...override };
  };

  return (
    <SelectionPanel
      counts={counts}
      showContainerSections={showContainerSections}
      showDensity={showDensity}
      direction={direction}
      onDirectionChange={(d) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        const selected = editor.getSelectedShapes() as unknown as Array<{
          id: string;
          type: string;
          props?: { direction?: string };
        }>;
        const allContainers =
          selected.length > 0 &&
          selected.every((s) => s.type === "schema-container");
        const allFrames =
          selected.length > 0 && selected.every((s) => s.type === "frame");
        // Frame «•» → AUTO: clear the pinned direction (null = unset) so
        // autoLayoutFrame re-picks the most compact config (frame dir × container
        // perp/along). Cardinal clicks below still pin the frame. This is the
        // frame counterpart of a container's inherit «•».
        if (allFrames && d === "custom") {
          editor.run(() => {
            for (const s of selected) {
              const sh = editor.getShape(s.id as unknown as TLShapeId);
              editor.updateShape({
                id: s.id as unknown as TLShapeId,
                type: "frame",
                // «•» = "re-pick yourself": drop the pinned direction, the
                // sticky champion AND the import-inherited marker — otherwise
                // the auto search would just restart from the previous resolved
                // direction (and a stale `inherited: true` without a direction
                // would mislead future meta readers).
                meta: {
                  ...(sh?.meta ?? {}),
                  didrawDirection: null,
                  didrawDirectionResolved: null,
                  didrawDirectionInherited: false,
                },
              } as never);
            }
          });
          void autoLayoutFrame(editor, ids as unknown as TLShapeId[], {
            forceUnpin: true,
          });
          return;
        }
        // Tri-state Direction: re-clicking the already-active direction on a
        // container UNSETS it → "custom" (inherit from the frame); the "•" button
        // maps to custom directly.
        const wantInherit = allContainers && (d === "custom" || d === direction);
        if (wantInherit) {
          // setContainerDirection only accepts cardinals — write "custom" straight
          // to props.direction; the inherit-include layout then follows the frame.
          editor.run(() => {
            for (const s of selected) {
              if (s.type !== "schema-container") continue;
              if (s.props?.direction === "custom") continue;
              editor.updateShape({
                id: s.id as unknown as TLShapeId,
                type: "schema-container",
                props: { ...(s.props as object), direction: "custom" },
              } as never);
            }
          });
          // forceUnpin: a direction change re-flows the whole subgraph; pinned
          // children were placed for the OLD direction, so ignore pins for this
          // pass (else they overlap the new layout — the "artifacts before force
          // re-layout" bug). forceDirections stays OFF so the choice just made is
          // honoured. Parity with the backend layout-selection forceUnpin path.
          autoElkLayout(editor, ids as unknown as TLShapeId[], {
            forceUnpin: true,
          });
          return;
        }
        if (d === "custom") return; // mixed selection «•»: no-op
        // Autolayout rebuild: write direction locally (no backend layout POST),
        // then re-flow with elk in place — no extra ⌘⇧L needed. forceUnpin so
        // children pinned for the previous direction don't leave artifacts.
        setContainerDirection(editor, ids, d, { triggerLayout: false });
        autoElkLayout(editor, ids as unknown as TLShapeId[], {
          forceUnpin: true,
        });
      }}
      layoutSettings={layoutSettings}
      onDensity={{
        // DRW-239: relative density gesture — spread/compress the selection in
        // place WITHOUT re-running ELK. One ⌘Z per drag: mark history once at
        // pointer-down, then each tick scales the captured snapshot (no extra
        // marks) so the whole drag collapses to a single undo step.
        start: () => {
          const ids = editor.getSelectedShapeIds() as unknown as TLShapeId[];
          editor.markHistoryStoppingPoint();
          densitySnapshotRef.current = captureRespreadSnapshot(editor, ids);
        },
        change: (k: number) => {
          if (!densitySnapshotRef.current) return;
          const ids = editor.getSelectedShapeIds() as unknown as TLShapeId[];
          applyRespread(editor, ids, k, {
            snapshot: densitySnapshotRef.current,
            markHistory: false,
          });
        },
        end: () => {
          densitySnapshotRef.current = null;
        },
      }}
      onEngine={(e: LayoutAlgorithm) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        // Engine change → rewrite meta (no backend POST) → elk re-flow in place
        // with the chosen ELK algorithm. Same pattern as onPreset (spacing).
        void setContainerLayoutParams(
          editor,
          ids,
          buildPartial({ layoutEngine: e }),
          { triggerLayout: false },
        );
        autoElkLayout(editor, ids as unknown as TLShapeId[]);
      }}
      onAdvanced={() => {
        // Full per-container Advanced UX — отложено в отдельную задачу.
        // BoardPanel-level Advanced остаётся доступен через клик по empty space → Board.
        console.warn(
          "[settings] Advanced drill-down per-container — future work",
        );
      }}
      onReset={() => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        void setContainerLayoutParams(editor, ids, null);
      }}
      showReset={showReset}
      onLayoutAction={async (id, mods) => {
        setPending(id);
        const ids = editor.getSelectedShapeIds() as unknown as TLShapeId[];
        try {
          // Autolayout rebuild: panel buttons drive the same frontend elk pass
          // as ⌘⇧L / ⌘⌥⇧L (aspect-aware auto-direction included). «Принудительно»
          // — or Opt+click «Упорядочить» — force-unpin (ignore pins once).
          const result = await autoLayoutFrame(editor, ids, {
            forceUnpin: id === "force-unpin" || mods.alt,
          });
          if (result.kind === "error") {
            console.warn("[settings] layout action failed", result.message);
          }
        } catch (e) {
          console.warn("[settings] layout action failed", e);
        } finally {
          setPending(null);
        }
      }}
      pinValues={pin.values}
      pinLabel={pin.header}
      altHeld={altHeld}
      onPinToggle={(field, mods) => {
        const key = field === "size" ? "didrawSizePinned" : "pinned";
        const ids = pinTargetIds(editor, mods.alt);
        const shapes = ids
          .map((id) => editor.getShape(id as TLShapeId))
          .filter(Boolean) as Array<{
          id: string;
          type: string;
          meta?: Record<string, unknown>;
        }>;
        // Synchronise: all-on → unpin everything; off or mixed → pin everything.
        const target =
          aggregatePinState(shapes.map((s) => s.meta?.[key] === true)) !== "on";
        editor.run(() => {
          for (const s of shapes) {
            // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
            editor.updateShape({
              id: s.id as never,
              type: s.type as never,
              meta: { ...(s.meta ?? {}), [key]: target },
            } as any);
          }
        });
      }}
      pending={pending}
      showStyles={showStyles}
      styleState={styleState}
      onStyleDash={(v) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        void applyStyleToSelection(editor, ids, { dash: v });
      }}
      onStyleFont={(v) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        void applyStyleToSelection(editor, ids, { font: v });
      }}
      onStyleSize={(v) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        void applyStyleToSelection(editor, ids, { size: v });
      }}
      showArrowKind={showArrowKind}
      arrowKindState={styleState.arrowKind}
      onStyleArrowKind={(v) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        void applyStyleToSelection(editor, ids, { arrowKind: v });
      }}
      showTextFit={showTextFit}
      onTextFit={(force) => {
        const ids = editor.getSelectedShapeIds() as unknown as string[];
        fitTextWithReflow(editor, ids, { force });
      }}
      singleContainerTitlePosition={singleContainer?.props.titlePosition}
      onSingleContainerTitlePositionChange={
        singleContainer ? onSingleContainerTitlePositionChange : undefined
      }
      singleFrameContainerTitlePosition={singleFrameContainerTitlePosition}
      onSingleFrameContainerTitlePositionChange={
        singleFrame ? onSingleFrameContainerTitlePositionChange : undefined
      }
      frameLocked={singleFrame?.meta?.didrawLocked === true}
      onFrameLockToggle={singleFrame ? onFrameLockToggle : undefined}
      lockedFrame={!!lockedFrame}
      onUnlockFrame={onUnlockFrame}
    />
  );
};

const NodePanelContainer: FC<{
  editor: Editor;
  subjectId: string;
}> = ({ editor, subjectId }) => {
  const pinValues = useValue(
    "nodePinValues",
    () => {
      const s = editor.getShape(subjectId as never) as
        | { meta?: Record<string, unknown> }
        | undefined;
      // Single node → on/off, never mixed.
      const tri = (v: boolean): PinTriState => (v ? "on" : "off");
      return {
        size: tri(s?.meta?.didrawSizePinned === true),
        position: tri(s?.meta?.pinned === true),
      };
    },
    [editor, subjectId],
  );

  const role = useValue(
    "nodeRole",
    () => {
      const s = editor.getShape(subjectId as never) as
        | { meta?: { didrawRole?: string } }
        | undefined;
      return (s?.meta?.didrawRole ?? null) as Role | null;
    },
    [editor, subjectId],
  );

  const lockedFrame = useValue(
    "nodeLockedFrame",
    () => lockedAncestorFrame(editor, [subjectId]),
    [editor, subjectId],
  );

  return (
    <NodePanel
      lockedFrame={!!lockedFrame}
      onUnlockFrame={() => {
        if (!lockedFrame) return;
        editor.updateShape({
          id: lockedFrame.id as never,
          type: "frame" as never,
          meta: { ...(lockedFrame.meta ?? {}), didrawLocked: false },
          // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
        } as any);
      }}
      pinValues={pinValues}
      onPinToggle={(field) => {
        const s = editor.getShape(subjectId as never) as
          | { id: string; type: string; meta?: Record<string, unknown> }
          | undefined;
        if (!s) return;
        const key = field === "size" ? "didrawSizePinned" : "pinned";
        const nextVal = !(s.meta?.[key] === true);
        // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
        editor.updateShape({
          id: s.id as never,
          type: s.type as never,
          meta: { ...(s.meta ?? {}), [key]: nextVal },
        } as any);
      }}
      role={role}
      onRoleSelect={(r) => {
        const s = editor.getShape(subjectId as never) as
          | { id: string; type: string; meta?: Record<string, unknown> }
          | undefined;
        if (!s) return;
        // biome-ignore lint/suspicious/noExplicitAny: tldraw meta untyped
        editor.updateShape({
          id: s.id as never,
          type: s.type as never,
          meta: { ...(s.meta ?? {}), didrawRole: r },
        } as any);
      }}
    />
  );
};
